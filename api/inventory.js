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
let cache = null;         // raw rows from Supabase
let fuse  = null;         // Fuse index over normalized fields
let last  = 0;
const TTL = 5 * 60 * 1000;

// ─── Normalizers ────────────────────────────────────────────────────────
function stripDiacritics(s) {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}
function stripWeirdSpaces(s) {
  // NBSP, thin spaces, zero-width chars, etc.
  return s.replace(/[\u00A0\u2000-\u200D\u2060\uFEFF]/g, ' ');
}
function fold(s) {
  return stripDiacritics(stripWeirdSpaces(String(s ?? '')))
    .replace(/\s+/g, ' ')
    .trim();
}
function norm(s) { return fold(s).toLowerCase(); }
function normKey(k) { return norm(k); }

// Safe getter for rows with unpredictable headers (diacritics/NBSP/etc.)
function getField(row, candidates) {
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

// Field candidate lists
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
function onlyKLC1(row) { return String(getField(row, F_SANDELIS) ?? '').toUpperCase() === 'KLC1'; }
function notBrokas(row) { return String(getField(row, F_SANDELIS) ?? '').toUpperCase() !== 'BROKAS'; }
function unitOf(row)    { return String(getField(row, F_VIENETAS) ?? 'vnt'); }
function skuOf(row)     { return String(getField(row, F_PREKES_NR) ?? ''); }
function idhOf(row)     { const v = getField(row, F_ISORINIS); return v == null ? null : String(v); }
function nameOf(row)    { return String(getField(row, F_PREKES_PAV) ?? ''); }
function lotOf(row)     { return String(getField(row, F_LOT) ?? ''); }
function barcodeRaw(row){ return String(getField(row, F_BRUKSNINIS) ?? ''); }

function barcodeTokens(row) {
  return barcodeRaw(row).split(/[,\s]+/).map(norm).filter(Boolean);
}
function expiryOf(row) {
  const iso = getField(row, F_GALIOJIMO_DATA);
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0,10);
}
function asNumber(v) {
  if (v === '' || v == null) return 0;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}
// Extract e.g. "50 ml", "25 kg", "300 ml", etc.
function packageSizeFromName(name, fallbackUnit) {
  const s = String(name || '').toUpperCase();
  const m1 = s.match(/(\d+(?:[.,]\d+)?)\s*(ML|L|KG|G)\b/);
  if (m1) return `${m1[1].replace(',', '.') } ${m1[2].toLowerCase()}`;
  const m2 = s.match(/(\d+(?:[.,]\d+)?)(ML|L|KG|G)\b/);
  if (m2) return `${m2[1].replace(',', '.') } ${m2[2].toLowerCase()}`;
  return fallbackUnit || '';
}

// Helpers
function looksLikeBDM(q)      { return /^BDM_\d+$/i.test(q); }
function looksLikeISODate(q)  { return /^\d{4}-\d{2}-\d{2}$/.test(q); }
function looksLikeLT(q)       { return /^lt\.(\d+)$/i.test(q); }

// ─── Load & index ───────────────────────────────────────────────────────
async function load() {
  if (cache && Date.now() - last < TTL) return;
  console.log('[load] refreshing cache from Supabase …');

  const { data, error } = await supabase.from('products').select('*');
  if (error) throw new Error('Supabase: ' + error.message);

  cache = Array.isArray(data) ? data : [];
  last = Date.now();

  if (cache.length) {
    console.log('[load] sample keys:', Object.keys(cache[0]));
  }

  // Build normalized docs for Fuse
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
function searchRowsByTerm(q) {
  const Qraw = String(q || '').trim();
  const Q    = fold(Qraw);
  const Qn   = norm(Qraw);

  // 1) direct product code
  if (looksLikeBDM(Q)) {
    const exact = cache.filter(r => norm(skuOf(r)) === Qn);
    if (exact.length) return exact;

    const starts = cache.filter(r => norm(skuOf(r)).startsWith(Qn));
    if (starts.length) return starts;

    const incl = cache.filter(r => norm(skuOf(r)).includes(Qn));
    if (incl.length) return incl;

    return [];
  }

  // 2) barcode exact token
  const bcHits = cache.filter(r => barcodeTokens(r).includes(Qn));
  if (bcHits.length) return bcHits;

  // 3) fuzzy across normalized docs
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
function summarizePackages(rows) {
  const filtered = rows.filter(r => onlyKLC1(r) && notBrokas(r));

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

  const header = {
    total_available: totals.total_available,
    unit: totals.unit_hint,
    name_hint: items[0]?.name || (rows[0] ? nameOf(rows[0]) : '')
  };

  return { kind:'packages', items, totals, header };
}

function summarizeExpiry(rows) {
  const filtered = rows.filter(r => onlyKLC1(r) && notBrokas(r));

  const groups = new Map(); // key: [package, expiry]
  for (const r of filtered) {
    const name  = nameOf(r);
    const unit  = unitOf(r);
    const pkg   = packageSizeFromName(name, unit);
    const exp   = expiryOf(r);
    const key   = JSON.stringify([pkg, exp]);
    const g = groups.get(key) || { package: pkg, expiry: exp, qty:0, unit };
    const available = asNumber(getField(r, F_FAKTISKA_TURIMA));
    g.qty += available;
    groups.set(key, g);
  }

  let items = [...groups.values()];
  items.sort((a,b) => {
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

  const header = {
    name_hint: rows[0] ? nameOf(rows[0]) : '',
    unit: rows[0] ? unitOf(rows[0]) : 'vnt',
    total_available: rows.reduce((s,r)=> s + asNumber(getField(r, F_FAKTISKA_TURIMA)), 0)
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
    const cursor = Math.max(0, Number(req.query.cursor || 0)); // simple offset paging

    console.log('──────────────────────────────────────────────');
    console.log('[handler] term:', JSON.stringify(qRaw), 'view:', view, 'limit:', limit, 'cursor:', cursor);

    if (!qRaw) return res.status(400).json({ error: 'term missing' });
    await load();

    let rows = [];

    // Date filter: expiry <= date
    if (looksLikeISODate(qRaw)) {
      const cutoff = qRaw;
      rows = cache.filter(r => {
        const e = expiryOf(r);
        return e && e <= cutoff;
      });
    } else {
      rows = searchRowsByTerm(qRaw);
    }

    // Low-stock filter: lt.N
    const mLT = looksLikeLT(qRaw) ? qRaw.match(/^lt\.(\d+)$/i) : null;
    if (mLT) {
      const thr = Number(mLT[1]);
      rows = rows.filter(r => asNumber(getField(r, F_FAKTISKA_TURIMA)) < thr);
    }

    // Build view
    let out = (view === 'expiry') ? summarizeExpiry(rows) : summarizePackages(rows);

    // Paging on computed items
    const list = out.items || [];
    const sliced = list.slice(cursor, cursor + limit);
    const nextCursor = cursor + limit < list.length ? cursor + limit : null;

    const response = { ...out, items: sliced, page: { cursor, limit, nextCursor, total: list.length } };

    console.log('[done] kind:', response.kind, 'rows considered:', rows.length,
                'items returned:', sliced.length, 'elapsed ms:', (performance.now() - t0).toFixed(1));
    return res.json(response);
  } catch (err) {
    console.error('[fatal]', err);
    return res.status(500).json({ error: err.message });
  }
};
