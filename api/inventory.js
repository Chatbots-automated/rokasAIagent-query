const { createClient } = require('@supabase/supabase-js');
const Fuse = require('fuse.js');
const { performance } = require('perf_hooks');

// ─── Supabase ───────────────────────────────────────────────────────────
const supabase = createClient(
  'https://xvjruntzmvkjzhdpmoca.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh2anJ1bnR6bXZranpoZHBtb2NhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NTI3MDkwNSwiZXhwIjoyMDcwODQ2OTA1fQ.Q1NFONsR2ct5BZV8uS994iItD_Wlq1SGZwH3R4xCPA0',
  { auth: { persistSession: false } }
);

// ─── Cache & search ─────────────────────────────────────────────────────
let cache = null;
let fuse  = null;
let last  = 0;
const TTL = 5 * 60 * 1000;

// accent-insensitive normalizer
function fold(s) {
  return (s ?? '')
    .toString()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/\s+/g,' ')
    .trim();
}
function norm(s){ return fold(s).toLowerCase(); }

function onlyKLC1(row) {
  const w = (row['Sandelis'] || row.warehouse || '').toString().toUpperCase();
  return w === 'KLC1';
}
function notBrokas(row) {
  const w = (row['Sandelis'] || row.warehouse || '').toString().toUpperCase();
  return w !== 'BROKAS';
}
function asNumber(v) {
  if (v === '' || v == null) return 0;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}
function unitOf(row) {
  return (row['Vienetas'] || row.unit || '').toString() || 'vnt';
}
function skuOf(row) {
  return row.product_code || row['Prekes Nr.'] || row['Prekės Nr.'] || '';
}
function idhOf(row) {
  return row.external_code || row['Isorinis prekes numeris'] || row['Išorinis prekės numeris'] || null;
}
function nameOf(row) {
  return row.product_name || row['Prekes pavadinimas'] || row['Prekės pavadinimas'] || '';
}
function barcodeTokens(row) {
  const raw = row.barcode || row['Bruksninis kodas'] || row['Brūkšninis kodas'] || '';
  return String(raw).split(/[,\s]+/).map(norm).filter(Boolean);
}
function expiryOf(row) {
  const iso = row.expiry_date || row['Galiojimo data'];
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0,10);
}
// find "50 ml", "300ML", "25 KG", "1,5 L" etc.
function packageSizeFromName(name, fallbackUnit) {
  const s = String(name || '').toUpperCase();
  // with/without space; allow comma decimals
  const m = s.match(/(\d+(?:[.,]\d+)?)\s*(ML|L|KG|G)\b/);
  if (m) return `${m[1].replace(',', '.') } ${m[2].toLowerCase()}`;
  const m2 = s.match(/(\d+(?:[.,]\d+)?)(ML|L|KG|G)\b/);
  if (m2) return `${m2[1].replace(',', '.') } ${m2[2].toLowerCase()}`;
  return fallbackUnit || '';
}

async function load() {
  if (cache && Date.now() - last < TTL) return;
  console.log('[load] refreshing cache from Supabase …');
  const { data, error } = await supabase.from('products').select('*');
  if (error) throw new Error('Supabase: ' + error.message);
  cache = Array.isArray(data) ? data : [];

  fuse = new Fuse(cache, {
    keys: [
      'product_name', 'product_code', 'barcode',
      'Prekes pavadinimas', 'Prekės pavadinimas',
      'Prekes Nr.', 'Prekės Nr.',
      'Isorinis prekes numeris', 'Išorinis prekės numeris'
    ],
    threshold: 0.28,
    includeScore: true,
    ignoreLocation: true,
    // Preprocess text for accent-insensitive matching
    getFn: (obj, path) => {
      const v = Fuse.config.getFn(obj, path);
      return Array.isArray(v) ? v.map(fold) : fold(v);
    },
  });

  last = Date.now();
  console.log('[load] cache rebuilt – rows:', cache.length,
              'mem ~', (JSON.stringify(cache).length / 1024 / 1024).toFixed(1), 'MB');
}

function looksLikeBDM(q) { return /^BDM_\d+$/i.test(q); }
function looksLikeISODate(q){ return /^\d{4}-\d{2}-\d{2}$/.test(q); }
function looksLikeLT(q){ return /^lt\.(\d+)$/i.test(q); }

// ─── Views ──────────────────────────────────────────────────────────────
function summarizePackages(rows) {
  const filtered = rows.filter(r => onlyKLC1(r) && notBrokas(r));

  const groups = new Map(); // key = [sku, idh, package, unit, name]
  for (const r of filtered) {
    const sku = skuOf(r);
    const idh = idhOf(r);
    const name = nameOf(r);
    const unit = unitOf(r);
    const pkg  = packageSizeFromName(name, unit);

    const key = JSON.stringify([sku, idh, pkg, unit, name]);
    const g = groups.get(key) || { sku, idh, package: pkg, unit, name, total_available:0, total_reserved:0, total_stock:0 };

    const stock_total = asNumber(r.stock_total || r['Faktines atsargos'] || r['Faktinės atsargos']);
    const reserved    = asNumber(r.reserved     || r['Faktiskai rezervuota'] || r['Faktiškai rezervuota']);
    const available   = asNumber(r.available    || r['Faktiskai turima']     || r['Faktiškai turima']);

    g.total_available += available;
    g.total_reserved  += reserved;
    g.total_stock     += stock_total;
    groups.set(key, g);
  }

  const items = [...groups.values()];
  items.sort((a,b) => {
    // sort by numeric size if present, else by name
    const ax = parseFloat((a.package||'').split(' ')[0]) || 0;
    const bx = parseFloat((b.package||'').split(' ')[0]) || 0;
    if (ax !== bx) return ax - bx;
    return a.package.localeCompare(b.package);
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
    name_hint: items[0]?.name || ''
  };

  return { kind:'packages', items, totals, header };
}

function summarizeExpiry(rows) {
  const filtered = rows.filter(r => onlyKLC1(r) && notBrokas(r));

  const groups = new Map(); // key = [package, expiry]
  for (const r of filtered) {
    const name  = nameOf(r);
    const unit  = unitOf(r);
    const pkg   = packageSizeFromName(name, unit);
    const exp   = expiryOf(r);
    const key   = JSON.stringify([pkg, exp]);
    const g = groups.get(key) || { package: pkg, expiry: exp, qty:0, unit };
    const available = asNumber(r.available || r['Faktiskai turima'] || r['Faktiškai turima']);
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
    total_available: rows.reduce((s,r)=> s + asNumber(r.available || r['Faktiskai turima'] || r['Faktiškai turima']), 0)
  };

  return { kind:'expiry', items, header };
}

// ─── Search helpers ─────────────────────────────────────────────────────
function searchRowsByTerm(q) {
  const Q = fold(q);

  // code: exact
  if (looksLikeBDM(Q)) {
    return cache.filter(r => fold(skuOf(r)).toUpperCase() === Q.toUpperCase());
  }

  // barcode token exact
  const token = norm(Q);
  const tokenHits = cache.filter(r => barcodeTokens(r).includes(token));
  if (tokenHits.length) return tokenHits;

  // fuzzy name / sku / idh
  const hits = fuse.search(Q);
  if (!hits.length) return [];

  // family sweep by substring over these fields (accent-insensitive)
  const qn = norm(Q);
  const family = cache.filter(r =>
    norm(nameOf(r)).includes(qn) ||
    norm(skuOf(r)).includes(qn)  ||
    norm(idhOf(r) || '').includes(qn)
  );
  return family.length ? family : hits.slice(0,50).map(h => h.item);
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

    // date filter (expiry <= date)
    if (looksLikeISODate(qRaw)) {
      const cutoff = qRaw;
      rows = cache.filter(r => {
        const e = expiryOf(r);
        return e && e <= cutoff;
      });
    } else {
      rows = searchRowsByTerm(qRaw);
    }

    // low-stock filter lt.N
    const mLT = looksLikeLT(qRaw) ? qRaw.match(/^lt\.(\d+)$/i) : null;
    if (mLT) {
      const thr = Number(mLT[1]);
      rows = rows.filter(r => asNumber(r.available || r['Faktiskai turima'] || r['Faktiškai turima']) < thr);
    }

    // apply view builder
    let out = (view === 'expiry') ? summarizeExpiry(rows) : summarizePackages(rows);

    // simple paging of the view items (do not re-query DB)
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
