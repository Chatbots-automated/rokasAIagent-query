const { createClient } = require('@supabase/supabase-js');
const Fuse = require('fuse.js');
const { performance } = require('perf_hooks');

// ─── Supabase (jūsų naujas projektas) ───────────────────────────────────
const supabase = createClient(
  'https://xvjruntzmvkjzhdpmoca.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh2anJ1bnR6bXZranpoZHBtb2NhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NTI3MDkwNSwiZXhwIjoyMDcwODQ2OTA1fQ.Q1NFONsR2ct5BZV8uS994iItD_Wlq1SGZwH3R4xCPA0',
  { auth: { persistSession: false } }
);

// ─── Cache & paieškos ───────────────────────────────────────────────────
let cache = null;
let fuse  = null;
let last  = 0;
const TTL = 5 * 60 * 1000;

function norm(s) {
  return (s ?? '').toString().normalize('NFKC').replace(/\s+/g,' ').trim();
}
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
  const n = Number(v);
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
function expiryOf(row) {
  // prefer normalized ISO (YYYY-MM-DD) if present
  const iso = row.expiry_date || row['Galiojimo data'];
  if (!iso) return null;
  // handle already ISO or parsable date
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0,10);
}
// extract package size like "50 ml", "250 ml", "300ML", "25KG", etc.
function packageSizeFromName(name, fallbackUnit) {
  const s = name.toUpperCase();
  const m = s.match(/(\d+(?:[.,]\d+)?)\s*(ML|L|KG|G)\b/);
  if (m) {
    const qty = m[1].replace(',', '.');
    const u = m[2].toLowerCase();
    return `${qty} ${u}`;
  }
  // fallback: if unit is piece (vnt), try to spot ml/kg tokens without space
  const m2 = s.match(/(\d+)(ML|KG|G|L)\b/);
  if (m2) return `${m2[1]} ${m2[2].toLowerCase()}`;
  // otherwise return unit only to keep grouping stable
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
    threshold: 0.3,
    includeScore: true,
    ignoreLocation: true,
  });

  last = Date.now();
  console.log('[load] cache rebuilt – rows:', cache.length,
              'mem ~', (JSON.stringify(cache).length / 1024 / 1024).toFixed(1), 'MB');
}

// –– Pagal užklausą: ar tai kodas, ar pavadinimas?
function looksLikeBDM(q) { return /^BDM_\d+$/i.test(q); }

// –– Pakuočių suvestinė (pirma užklausa)
function summarizePackages(rows) {
  // Tik KLC1, be BROKAS
  const filtered = rows.filter(r => onlyKLC1(r) && notBrokas(r));

  // Grupė: (sku, idh, package_size, unit, name)
  const groups = new Map();
  for (const r of filtered) {
    const sku = skuOf(r);
    const idh = idhOf(r);
    const name = nameOf(r);
    const unit = unitOf(r);
    const pkg  = packageSizeFromName(name, unit);

    const key = JSON.stringify([sku, idh, pkg, unit, name]);
    const g = groups.get(key) || { sku, idh, package: pkg, unit, name, total_available:0, total_reserved:0, total_stock:0 };
    const stock_total = asNumber(r.stock_total || r['Faktines atsargos'] || r['Faktinės atsargos']);
    const reserved    = asNumber(r.reserved || r['Faktiskai rezervuota'] || r['Faktiškai rezervuota']);
    const available   = asNumber(r.available || r['Faktiskai turima'] || r['Faktiškai turima']);

    g.total_available += available;
    g.total_reserved  += reserved;
    g.total_stock     += stock_total;
    groups.set(key, g);
  }

  const items = [...groups.values()];
  // Surikiuojam pagal pakuotę (pagal skaičių, jei yra)
  items.sort((a,b) => {
    const ax = parseFloat((a.package||'').split(' ')[0]) || 0;
    const bx = parseFloat((b.package||'').split(' ')[0]) || 0;
    return ax - bx;
  });

  const totals = {
    total_available: items.reduce((s,x)=>s + x.total_available, 0),
    total_reserved:  items.reduce((s,x)=>s + x.total_reserved, 0),
    total_stock:     items.reduce((s,x)=>s + x.total_stock, 0),
    unit_hint: items[0]?.unit || 'vnt'
  };

  // Grąžinam paprastą struktūrą UI-ui / agentui
  return { kind:'packages', items, totals };
}

// –– Galiojimų (FEFO) sąrašas (antra užklausa)
function summarizeExpiry(rows) {
  const filtered = rows.filter(r => onlyKLC1(r) && notBrokas(r));

  // Grupė: (package, expiry)
  const groups = new Map();
  for (const r of filtered) {
    const name  = nameOf(r);
    const unit  = unitOf(r);
    const pkg   = packageSizeFromName(name, unit);
    const exp   = expiryOf(r); // ISO arba null
    const key   = JSON.stringify([pkg, exp]);
    const g = groups.get(key) || { package: pkg, expiry: exp, qty:0, unit };
    const available = asNumber(r.available || r['Faktiskai turima'] || r['Faktiškai turima']);
    g.qty += available;
    groups.set(key, g);
  }

  let items = [...groups.values()];
  // Rikiavimas: pirma su data, nuo artimiausios; nullai („—“) gale
  items.sort((a,b) => {
    if (!a.expiry && !b.expiry) return 0;
    if (!a.expiry) return 1;
    if (!b.expiry) return -1;
    return a.expiry.localeCompare(b.expiry);
  });

  // Žyma ⚠️ jei praeitis
  const today = new Date().toISOString().slice(0,10);
  for (const it of items) {
    if (!it.expiry) { it.expiry_label = '—'; it.expired = false; continue; }
    it.expired = it.expiry < today;
    it.expiry_label = it.expired ? `⚠️ ${it.expiry}` : it.expiry;
  }

  return { kind:'expiry', items };
}

// –– Rinkti eilutes pagal term
function searchRowsByTerm(q) {
  const Q = norm(q);

  // 1) Jei BDM kodas – grąžinam visus to kodo įrašus
  if (looksLikeBDM(Q)) {
    const rows = cache.filter(r => norm(skuOf(r)).toUpperCase() === Q.toUpperCase());
    return rows;
  }

  // 2) Kitaip – fuzzy paieška pagal pavadinimą/kodus/idh
  const hits = fuse.search(Q);
  if (!hits.length) return [];

  // Imkim platesnį „šeimos“ rinkinį: visi, kurių name apima bazinį terminą (case-insensitive)
  const termLower = Q.toLowerCase();
  const family = cache.filter(r => (nameOf(r) || '').toLowerCase().includes(termLower)
                                || (skuOf(r) || '').toLowerCase().includes(termLower)
                                || (idhOf(r) || '').toLowerCase().includes(termLower));
  // Jei šeima labai maža, bent grąžinam top hits
  if (family.length >= 1) return family;
  return hits.slice(0,50).map(h => h.item);
}

// ─── Handler ───────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  const t0 = performance.now();
  try {
    const { term = '' } = req.body || {};
    const view = (req.query.view || 'packages').toString(); // 'packages' | 'expiry'
    const q = norm(term);

    console.log('──────────────────────────────────────────────');
    console.log('[handler] term:', JSON.stringify(q), 'view:', view);

    if (!q) return res.status(400).json({ error: 'term missing' });
    await load();

    const rows = searchRowsByTerm(q);

    let out;
    if (view === 'expiry') {
      out = summarizeExpiry(rows);
    } else {
      out = summarizePackages(rows);
    }

    console.log('[done] kind:', out.kind, 'rows considered:', rows.length,
                'elapsed ms:', (performance.now() - t0).toFixed(1));
    return res.json(out);
  } catch (err) {
    console.error('[fatal]', err);
    return res.status(500).json({ error: err.message });
  }
};
