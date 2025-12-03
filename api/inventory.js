// /api/inventory.js
const { createClient } = require('@supabase/supabase-js');
const Fuse = require('fuse.js');
const { performance } = require('perf_hooks');

// ─── Supabase ───────────────────────────────────────────────────────────
const supabase = createClient(
  'https://xvjruntzmvkjzhdpmoca.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh2anJ1bnR6bXZranpoZHBtb2NhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NTI3MDkwNSwiZXhwIjoyMDcwODQ2OTA1fQ.Q1NFONsR2ct5BZV8uS994iItD_Wlq1SGZwH3R4xCPA0',
  { auth: { persistSession: false } }
);

// ─── Caching / Fuse ─────────────────────────────────────────────────────
// Lower TTL so “near-real-time” numbers don’t lag for long.
let cache = null;
let fuse  = null;
let last  = 0;
const TTL = 30 * 1000; // 30s

// ─── Normalizers ────────────────────────────────────────────────────────
function stripDiacritics(s) { return String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, ''); }
function stripWeirdSpaces(s){ return String(s ?? '').replace(/[\u00A0\u2000-\u200D\u2060\uFEFF]/g, ' '); }
function fold(s){ return stripDiacritics(stripWeirdSpaces(s)).replace(/\s+/g,' ').trim(); }
function norm(s){ return fold(s).toLowerCase(); }
function normKey(k){ return norm(k); }

// Safe getter for rows with unpredictable headers
function getField(row, candidates){
  if (!row) return undefined;
  if (!row.__nk__) {
    const nk = {};
    for (const key of Object.keys(row)) nk[normKey(key)] = key;
    Object.defineProperty(row, '__nk__', { value: nk, enumerable: false });
  }
  for (const want of candidates) {
    const hit = row.__nk__[normKey(want)];
    if (hit !== undefined) return row[hit];
  }
  return undefined;
}

// Field aliases
const F_PREKES_NR         = ['Prekes Nr.', 'Prekės Nr.', 'product_code', 'SKU', 'Kodas'];
const F_PREKES_PAV        = ['Prekes pavadinimas', 'Prekės pavadinimas', 'product_name', 'Pavadinimas', 'Name'];
const F_ISORINIS          = ['Isorinis prekes numeris', 'Išorinis prekės numeris', 'external_code', 'IDH'];
const F_BRUKSNINIS        = ['Bruksninis kodas', 'Brūkšninis kodas', 'barcode', 'EAN'];
const F_SANDELIS          = ['Sandelis', 'Sandėlis', 'warehouse'];
const F_GALIOJIMO_DATA    = ['Galiojimo data', 'expiry_date', 'BBF'];
const F_LOT               = ['LOT', 'Partija'];
const F_PAKETO_NUMERIS    = ['Paketo numeris', 'Package No'];
const F_VIETA             = ['Vieta', 'Lokacija', 'Rack'];
const F_PADEKLO_NR        = ['Padeklo Nr.', 'Padėklo Nr.', 'Pallet No'];
const F_BUSENA            = ['Busena', 'Būsena', 'status'];
const F_VIETOS_TIPAS      = ['Vietos tipas', 'Location Type'];
const F_VIENETAS          = ['Vienetas', 'Unit', 'vnt', 'kg', 'l'];
const F_FAKTINES_ATSARGOS = ['Faktines atsargos', 'Faktinės atsargos', 'stock_total'];
const F_FAKTISKA_REZ      = ['Faktiskai rezervuota', 'Faktiškai rezervuota', 'reserved'];
const F_FAKTISKA_TURIMA   = ['Faktiskai turima', 'Faktiškai turima', 'available'];

// Accessors
function onlyKLC1(row){ return String(getField(row, F_SANDELIS) ?? '').toUpperCase() === 'KLC1'; }
function notBrokas(row){ return String(getField(row, F_SANDELIS) ?? '').toUpperCase() !== 'BROKAS'; }
function unitOf(row){ return String(getField(row, F_VIENETAS) ?? 'vnt'); }
function skuOf(row){ return String(getField(row, F_PREKES_NR) ?? ''); }
function idhOf(row){ const v = getField(row, F_ISORINIS); return v == null ? null : String(v); }
function nameOf(row){ return String(getField(row, F_PREKES_PAV) ?? ''); }
function barcodeRaw(row){ return String(getField(row, F_BRUKSNINIS) ?? ''); }

function barcodeTokens(row){
  return barcodeRaw(row).split(/[,\s]+/).map(norm).filter(Boolean);
}
function expiryOf(row){
  const iso = getField(row, F_GALIOJIMO_DATA);
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0,10);
}
function asNumber(v){
  if (v === '' || v == null) return 0;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}
function packageSizeFromName(name, fallbackUnit){
  const s = String(name || '').toUpperCase();
  const m1 = s.match(/(\d+(?:[.,]\d+)?)\s*(ML|L|KG|G)\b/);
  if (m1) return `${m1[1].replace(',', '.') } ${m1[2].toLowerCase()}`;
  const m2 = s.match(/(\d+(?:[.,]\d+)?)(ML|L|KG|G)\b/);
  if (m2) return `${m2[1].replace(',', '.') } ${m2[2].toLowerCase()}`;
  return fallbackUnit || '';
}

// ─── Term detection helpers ─────────────────────────────────────────────
function looksLikeBDM(q){ return /^BDM_\d+$/i.test(q); }
function looksLikeISODate(q){ return /^\d{4}-\d{2}-\d{2}$/.test(q); }

// Parse low-stock expressions (lt.10 | <10 | <=10 | ≤10 | under/below/less than 10 | mažiau (nei) 10)
function parseLowStock(qRaw){
  const q = norm(qRaw);

  let m = q.match(/^lt\.(\d+)$/i);
  if (m) return { op: '<', eq: false, n: Number(m[1]), scope: parseScope(q) };

  m = q.match(/^<\s*(\d+)$/);
  if (m) return { op: '<', eq: false, n: Number(m[1]), scope: parseScope(q) };
  m = q.match(/^<=\s*(\d+)$/);
  if (m) return { op: '<', eq: true,  n: Number(m[1]), scope: parseScope(q) };
  m = q.match(/^[≤]\s*(\d+)$/);
  if (m) return { op: '<', eq: true,  n: Number(m[1]), scope: parseScope(q) };

  m = q.match(/\b(under|less\s*than|below)\s+(\d+)\b/);
  if (m) return { op: '<', eq: false, n: Number(m[2]), scope: parseScope(q) };

  m = q.match(/\b(mažiau|maziau)\s*(nei)?\s*(\d+)\b/);
  if (m) return { op: '<', eq: false, n: Number(m[3]), scope: parseScope(q) };

  return null;
}

// Scope: detect "all warehouse" phrasing (LT/EN) to bypass KLC1 filter
function parseScope(q){
  const s = norm(q);
  if (/\b(all|entire|whole)\b.*\b(warehouse|stock)\b/.test(s)) return 'all';
  if (/\b(visas|visuose|visam|visame)\b.*\b(sandel|sandėli)/.test(s)) return 'all';
  return 'klc1';
}

// Strip directive/noise tokens (e.g., “BDM_142411 expiry” -> “BDM_142411”)
const NOISE_TOKENS = [
  'expiry', 'expiries', 'exp', 'bbf', 'galiojimas', 'galiojimai', 'galioj',
  'rodyk', 'show', 'taip', 'yes', 'please', 'prasau', 'prašau', 'next', 'more',
  'daugiau', 'longer', 'paketai', 'packages', 'partijos', 'batches'
];
function stripNoise(qRaw){
  const tokens = fold(qRaw).split(' ');
  const filtered = tokens.filter(t => !NOISE_TOKENS.includes(norm(t)));
  return filtered.join(' ').trim();
}
function extractCoreTerm(qRaw){
  const cleaned = stripNoise(qRaw);
  const m = cleaned.match(/BDM_\d+/i);
  if (m) return m[0];
  return cleaned;
}

// ─── Load & index ───────────────────────────────────────────────────────
async function load(force = false){
  if (!force && cache && Date.now() - last < TTL) return;
  console.log('[load] refreshing cache from Supabase …');

  const { data, error } = await supabase.from('products').select('*');
  if (error) throw new Error('Supabase: ' + error.message);

  cache = Array.isArray(data) ? data : [];
  last = Date.now();

  if (cache.length) console.log('[load] sample keys:', Object.keys(cache[0]));

  const docs = cache.map(r => ({
    _ref: r,
    name: fold(nameOf(r)),
    code: fold(skuOf(r)),
    idh:  fold(idhOf(r) ?? ''),
    bc:   fold(barcodeRaw(r))
  }));

  fuse = new Fuse(docs, {
    keys: ['name', 'code', 'idh', 'bc'],
    threshold: 0.28,
    includeScore: true,
    ignoreLocation: true,
  });

  console.log('[load] cache rows:', cache.length,
              'mem ~', (JSON.stringify(cache).length / 1024 / 1024).toFixed(1), 'MB');
}

// ─── Search ─────────────────────────────────────────────────────────────
function searchRowsByTerm(qRaw){
  const coreRaw = extractCoreTerm(qRaw);
  const Qraw = String(coreRaw || '').trim();
  const Q    = fold(Qraw);
  const Qn   = norm(Qraw);

  if (!Qraw) return [];

  if (looksLikeBDM(Q)) {
    const exact  = cache.filter(r => norm(skuOf(r)) === Qn);
    if (exact.length) return exact;
    const starts = cache.filter(r => norm(skuOf(r)).startsWith(Qn));
    if (starts.length) return starts;
    const incl   = cache.filter(r => norm(skuOf(r)).includes(Qn));
    if (incl.length) return incl;
    return [];
  }

  const bcHits = cache.filter(r => barcodeTokens(r).includes(Qn));
  if (bcHits.length) return bcHits;

  const hits = fuse.search(Q);
  if (hits.length) {
    const rows = hits.map(h => h.item._ref);
    const fam = cache.filter(r =>
      norm(nameOf(r)).includes(Qn) ||
      norm(skuOf(r)).includes(Qn)  ||
      norm(idhOf(r) || '').includes(Qn)
    );
    return fam.length ? fam : rows.slice(0, 50);
  }
  return [];
}

// ─── Views ──────────────────────────────────────────────────────────────
function summarizePackages(rows, titleOverride, scope){
  const filtered = rows.filter(r => (scope === 'all' ? true : onlyKLC1(r)) && notBrokas(r));

  const groups = new Map(); // key: [sku, idh, package, unit, name]
  for (const r of filtered) {
    const sku  = skuOf(r);
    const idh  = idhOf(r);
    const name = nameOf(r);
    const unit = unitOf(r);
    const pkg  = packageSizeFromName(name, unit);

    const key = JSON.stringify([sku, idh, pkg, unit, name]);
    const g = groups.get(key) || { sku, idh, package: pkg, unit, name, total_available:0, total_reserved:0, total_stock:0 };

    const stock_total = asNumber(getField(r, F_FAKTINES_ATSARGOS));
    const reserved    = asNumber(getField(r, F_FAKTISKA_REZ));
    const available   = asNumber(getField(r, F_FAKTISKA_TURIMA));

    g.total_available += available;
    g.total_reserved  += reserved;
    g.total_stock     += stock_total;
    groups.set(key, g);
  }

  const items = [...groups.values()];
  items.sort((a,b) => {
    const ax = parseFloat((a.package||'').split(' ')[0]) || 0;
    const bx = parseFloat((b.package||'').split(' ')[0]) || 0;
    if (ax !== bx) return ax - bx;
    return (a.package||'').localeCompare(b.package||'');
  });

  const totals = {
    total_available: items.reduce((s,x)=>s + x.total_available, 0),
    total_reserved:  items.reduce((s,x)=>s + x.total_reserved,  0),
    total_stock:     items.reduce((s,x)=>s + x.total_stock,     0),
    unit_hint: items[0]?.unit || 'vnt'
  };

  const scopeLabel = scope === 'all' ? 'visuose sandėliuose' : 'KLC1';
  const header = {
    total_available: totals.total_available,
    unit: totals.unit_hint,
    name_hint: (titleOverride ? `${titleOverride}` : (items[0]?.name || '')) + (titleOverride ? '' : ''),
    scope: scopeLabel
  };

  return { kind:'packages', items, totals, header };
}

function summarizeExpiry(rows, titleOverride, scope){
  const filtered = rows.filter(r => (scope === 'all' ? true : onlyKLC1(r)) && notBrokas(r));

  // Group by package + expiry
  const groups = new Map(); // key: [package, expiry, unit]
  for (const r of filtered) {
    const name  = nameOf(r);
    const unit  = unitOf(r);
    const pkg   = packageSizeFromName(name, unit);
    const exp   = expiryOf(r);
    const key   = JSON.stringify([pkg, exp, unit]);

    const stock_total = asNumber(getField(r, F_FAKTINES_ATSARGOS));
    const reserved    = asNumber(getField(r, F_FAKTISKA_REZ));
    const available   = asNumber(getField(r, F_FAKTISKA_TURIMA));

    const g = groups.get(key) || { package: pkg, expiry: exp, unit, qty_available:0, qty_reserved:0, qty_total:0 };
    g.qty_available += available;
    g.qty_reserved  += reserved;
    g.qty_total     += stock_total;
    groups.set(key, g);
  }

  let items = [...groups.values()];
  items.sort((a,b) => {
    // FEFO: missing expiry last
    if (!a.expiry && !b.expiry) return 0;
    if (!a.expiry) return 1;
    if (!b.expiry) return -1;
    return a.expiry.localeCompare(b.expiry);
  });

  const today = new Date().toISOString().slice(0,10);
  for (const it of items) {
    if (!it.expiry) { it.expiry_label = '—'; it.expired = false; continue; }
    it.expired = it.expiry < today;
    it.expiry_label = it.expired ? `⚠️ ${it.expiry}` : it.expiry;
  }

  const scopeLabel = scope === 'all' ? 'visuose sandėliuose' : 'KLC1';
  const header = {
    name_hint: titleOverride || (rows[0] ? nameOf(rows[0]) : ''),
    unit: rows[0] ? unitOf(rows[0]) : 'vnt',
    total_available: filtered.reduce((s,r)=> s + asNumber(getField(r, F_FAKTISKA_TURIMA)), 0),
    total_reserved:  filtered.reduce((s,r)=> s + asNumber(getField(r, F_FAKTISKA_REZ)), 0),
    total_stock:     filtered.reduce((s,r)=> s + asNumber(getField(r, F_FAKTINES_ATSARGOS)), 0),
    scope: scopeLabel
  };

  return { kind:'expiry', items, header };
}

// ─── Handler ────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  const t0 = performance.now();
  try {
    const { term = '' } = req.body || {};
    const qRaw   = String(term || '').trim();
    const view   = String(req.query.view || 'packages'); // 'packages' | 'expiry'
    const limit  = Math.max(1, Math.min(100, Number(req.query.limit || 50)));
    const cursor = Math.max(0, Number(req.query.cursor || 0));
    const refresh = String(req.query.refresh || '0') === '1'; // force reload

    console.log('──────────────────────────────────────────────');
    console.log('[handler] term:', JSON.stringify(qRaw), 'view:', view, 'limit:', limit, 'cursor:', cursor, 'refresh:', refresh);

    if (!qRaw) return res.status(400).json({ error: 'term missing' });

    await load(refresh);

    let rows = [];
    let titleOverride = null;
    let scope = 'klc1'; // default behavior

    // 1) Low-stock filters over requested scope (default KLC1; if text suggests 'all', do all)
    const low = parseLowStock(qRaw);
    if (low) {
      rows = cache; // start from all rows; scope handled later
      scope = low.scope;
      const cmp = (a) => {
        const v = asNumber(getField(a, F_FAKTISKA_TURIMA));
        if (low.op === '<' && low.eq)  return v <= low.n;
        if (low.op === '<' && !low.eq) return v <  low.n;
        return false;
      };
      rows = rows.filter(cmp);
      titleOverride = `Likutis ${low.eq ? '≤' : '<'} ${low.n}`;
    }
    // 2) Expiry cutoff (expiry <= date)
    else if (looksLikeISODate(qRaw)) {
      const cutoff = qRaw;
      rows = cache.filter(r => {
        const e = expiryOf(r);
        return e && e <= cutoff;
      });
      titleOverride = `Galiojimai iki ${cutoff}`;
    }
    // 3) Normal product/name/code search (robust to “BDM_142411 expiry”, etc.)
    else {
      rows = searchRowsByTerm(qRaw);
    }

    // Apply scope + BROKAS filtering on raw rows for return
    const filtered = rows.filter(r => (scope === 'all' ? true : onlyKLC1(r)) && notBrokas(r));

    // Build view from filtered rows
    const out = (view === 'expiry')
      ? summarizeExpiry(filtered, titleOverride, scope)
      : summarizePackages(filtered, titleOverride, scope);

    // Paging (align raw + items)
    const itemsList   = out.items || [];
    const itemsSliced = itemsList.slice(cursor, cursor + limit);
    const nextCursor  = cursor + limit < itemsList.length ? cursor + limit : null;
    const rawSliced   = filtered.slice(cursor, cursor + limit);

    const response = {
      ...out,
      items: itemsSliced,
      page: { cursor, limit, nextCursor, total: itemsList.length },
      raw: {
        total: filtered.length,
        rows: rawSliced,     // paged raw rows
        all_rows: filtered   // full filtered raw set
      },
      meta: {
        term: qRaw,
        view,
        scope,
        refresh,
        cache_age_ms: Date.now() - last,
        generated_ms: Number((performance.now() - t0).toFixed(1))
      }
    };

    console.log('[done] kind:', response.kind,
      'rows considered:', rows.length,
      'filtered:', filtered.length,
      'items returned:', itemsSliced.length,
      'elapsed ms:', response.meta.generated_ms);

    return res.json(response);
  } catch (err) {
    console.error('[fatal]', err);
    return res.status(500).json({ error: err.message });
  }
};
