const { createClient } = require('@supabase/supabase-js');
const Fuse = require('fuse.js');
const { performance } = require('perf_hooks');

// ─── Supabase ───────────────────────────────────────────────────────────
const supabase = createClient(
  'https://xvjruntzmvkjzhdpmoca.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh2anJ1bnR6bXZranpoZHBtb2NhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NTI3MDkwNSwiZXhwIjoyMDcwODQ2OTA1fQ.Q1NFONsR2ct5BZV8uS994iItD_Wlq1SGZwH3R4xCPA0',
  { auth: { persistSession: false } }
);

// ─── Helpers to read both ASCII & diacritics headers ────────────────────
const V = {
  code:                ['product_code','Prekes Nr.','Prekės Nr.'],
  name:                ['product_name','Prekes pavadinimas','Prekės pavadinimas'],
  barcode:             ['barcode','Bruksninis kodas','Brūkšninis kodas'],
  supplier:            ['supplier','Tiekejas','Tiekėjas'],
  expiry:              ['expiry_date','Galiojimo data'],
  lot:                 ['lot','LOT'],
  warehouse:           ['warehouse','Sandelis','Sandėlis'],
  package_number:      ['package_number','Paketo numeris'],
  location:            ['location','Vieta'],
  pallet_number:       ['pallet_number','Padeklo Nr.','Padėklo Nr.'],
  status:              ['status','Busena','Būsena'],
  location_type:       ['location_type','Vietos tipas'],
  unit:                ['unit','Vienetas'],
  stock_total:         ['stock_total','Faktines atsargos','Faktinės atsargos'],
  reserved:            ['reserved','Faktiskai rezervuota','Faktiškai rezervuota'],
  available:           ['available','Faktiskai turima','Faktiškai turima'],
};

const normCode = (v) => (v ?? '').toString().trim().toUpperCase();
const normText = (v) => (v ?? '').toString().trim().toLowerCase();
const tokens   = (v) => (v ?? '').toString().toLowerCase().split(/[,\s]+/).filter(Boolean);

function getField(row, variants) {
  for (const k of variants) if (row[k] !== undefined) return row[k];
  return null;
}
function canonize(row) {
  const code   = getField(row, V.code);
  const name   = getField(row, V.name);
  const bc     = getField(row, V.barcode);
  const lot    = getField(row, V.lot);
  const wh     = getField(row, V.warehouse);
  const loc    = getField(row, V.location);
  const pkg    = getField(row, V.package_number);
  const pal    = getField(row, V.pallet_number);
  const stat   = getField(row, V.status);
  const ltype  = getField(row, V.location_type);
  const supp   = getField(row, V.supplier);
  const unit   = getField(row, V.unit) || 'vnt';
  const avail  = Number(getField(row, V.available)) || 0;
  const expRaw = getField(row, V.expiry);

  // parse expiry (supports ISO or "YYYY.MM.DD")
  let expiry = null;
  if (expRaw) {
    const s = String(expRaw);
    if (/^\d{4}\.\d{2}\.\d{2}$/.test(s)) {
      const [y,m,d] = s.split('.');
      expiry = `${y}-${m}-${d}`;
    } else {
      const d = new Date(s);
      if (!isNaN(d)) expiry = d.toISOString().slice(0,10);
    }
  }

  return {
    code,
    name,
    barcode: bc,
    barcodeTokens: tokens(bc),
    lot,
    warehouse: wh,
    location: loc,
    package_number: pkg,
    pallet_number: pal,
    status: stat,
    location_type: ltype,
    supplier: supp,
    unit,
    available: avail,
    expiry_date: expiry,
  };
}

// ─── In-memory cache & indices ─────────────────────────────────────────
let cache = null;     // original rows
let view  = null;     // canonical view per row
let fuse  = null;
let idx   = null;     // indices
let last  = 0;
const TTL = 5 * 60 * 1000;

async function load() {
  if (cache && Date.now() - last < TTL) {
    console.log('[load] using cached data – rows:', cache.length, 'age(ms):', Date.now() - last);
    return;
  }
  console.log('[load] refreshing cache from Supabase …');
  const { data, error } = await supabase.from('products').select('*');
  if (error) throw new Error('Supabase: ' + error.message);

  cache = Array.isArray(data) ? data : [];
  view  = cache.map(canonize);

  // Build indices over many columns
  const byCode = new Map();   // NORM_CODE -> Set(real code)
  const byName = new Map();   // norm name -> Set(code)
  const byLot  = new Map();   // lot token -> Set(code)
  const byWh   = new Map();   // warehouse token -> Set(code)
  const byLoc  = new Map();   // location token -> Set(code)
  const byPkg  = new Map();   // package token -> Set(code)
  const byPal  = new Map();   // pallet token -> Set(code)
  const byStat = new Map();   // status token -> Set(code)
  const bySupp = new Map();   // supplier token -> Set(code)
  const byBc   = new Map();   // barcode token -> Set(code)

  function add(map, key, code) {
    if (!key) return;
    const k = key.toLowerCase().trim();
    if (!k) return;
    if (!map.has(k)) map.set(k, new Set());
    map.get(k).add(code);
  }

  for (const v of view) {
    const codeN = normCode(v.code);
    if (codeN) {
      if (!byCode.has(codeN)) byCode.set(codeN, new Set());
      byCode.get(codeN).add(v.code);
    }

    add(byName, v.name, v.code);
    add(byLot, v.lot, v.code);
    add(byWh, v.warehouse, v.code);
    add(byLoc, v.location, v.code);
    add(byPkg, v.package_number, v.code);
    add(byPal, v.pallet_number, v.code);
    add(byStat, v.status, v.code);
    add(bySupp, v.supplier, v.code);
    for (const t of v.barcodeTokens) add(byBc, t, v.code);
  }

  idx = { byCode, byName, byLot, byWh, byLoc, byPkg, byPal, byStat, bySupp, byBc };

  // Fuse across many fields (joined text)
  fuse = new Fuse(view.map((v, i) => ({
    i, // index to get back to view/cache
    code: v.code, name: v.name, barcode: v.barcode,
    lot: v.lot, warehouse: v.warehouse, location: v.location,
    package_number: v.package_number, pallet_number: v.pallet_number,
    status: v.status, supplier: v.supplier,
    haystack: [
      v.code, v.name, v.barcode, v.lot, v.warehouse, v.location,
      v.package_number, v.pallet_number, v.status, v.supplier, v.location_type
    ].filter(Boolean).join(' ')
  })), {
    keys: [
      'code','name','barcode','lot','warehouse','location',
      'package_number','pallet_number','status','supplier','haystack'
    ],
    threshold: 0.35,
    includeScore: true,
    ignoreLocation: true,
    minMatchCharLength: 2,
  });

  last = Date.now();
  console.log('[load] cache rebuilt – rows:', cache.length,
              'mem ~', (JSON.stringify(cache).length / 1024 / 1024).toFixed(1), 'MB');
}

// ─── Query handling ────────────────────────────────────────────────────
function sanitizeTerm(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  return s
    .replace(/^(query|find|search)\s+(this\s+)?(item|product)\s*:?\s*/i, '')
    .replace(/^"(.*)"$/, '$1')
    .trim();
}

function pickBestCode(codeSet) {
  if (!codeSet || !codeSet.size) return null;
  if (codeSet.size === 1) return [...codeSet][0];

  // choose by highest total available across all rows for that code
  const sums = new Map();
  for (const c of codeSet) sums.set(c, 0);
  for (let n = 0; n < view.length; n++) {
    const v = view[n];
    if (sums.has(v.code)) sums.set(v.code, (sums.get(v.code) || 0) + (v.available || 0));
  }
  let best = null, bestSum = -1;
  for (const [c, s] of sums) if (s > bestSum) bestSum = s, best = c;
  return best || [...codeSet][0];
}

function resolveProductCode(q) {
  if (!q) return null;
  const qCode = normCode(q);
  const qText = q.toLowerCase().trim();

  const looksLikeCode = /^bdm_\d+$/i.test(q);

  // 1) Exact code
  if (looksLikeCode && idx.byCode.has(qCode)) {
    const codes = idx.byCode.get(qCode);
    console.log('[resolve] exact code:', qCode, 'variants:', [...codes]);
    return pickBestCode(codes);
  }

  // 2) Scan equal (covers stray spaces/case in DB)
  {
    const hit = view.find(v => normCode(v.code) === qCode);
    if (hit) {
      console.log('[resolve] scan equal code:', hit.code);
      return hit.code;
    }
  }

  // 3) Code startsWith / includes
  if (looksLikeCode) {
    const starts = new Set(view.filter(v => normCode(v.code).startsWith(qCode)).map(v => v.code));
    if (starts.size) {
      console.log('[resolve] code startsWith hits:', starts.size);
      return pickBestCode(starts);
    }
    const incl = new Set(view.filter(v => normCode(v.code).includes(qCode)).map(v => v.code));
    if (incl.size) {
      console.log('[resolve] code includes hits:', incl.size);
      return pickBestCode(incl);
    }
  }

  // 4) Exact name
  if (idx.byName.has(qText)) {
    const codes = idx.byName.get(qText);
    console.log('[resolve] exact name hit:', qText, 'codes:', [...codes]);
    return pickBestCode(codes);
  }

  // 5) Other exact-column hits (lot / package / pallet / location / warehouse / status / supplier / barcode token)
  const exactMaps = [
    ['lot',   idx.byLot],
    ['pkg',   idx.byPkg],
    ['pal',   idx.byPal],
    ['loc',   idx.byLoc],
    ['wh',    idx.byWh],
    ['stat',  idx.byStat],
    ['supp',  idx.bySupp],
    ['bcTok', idx.byBc],
  ];
  for (const [label, map] of exactMaps) {
    if (map.has(qText)) {
      const codes = map.get(qText);
      console.log(`[resolve] exact ${label} hit:`, qText, 'codes:', [...codes]);
      return pickBestCode(codes);
    }
  }

  // 6) startsWith on name/location if the phrase looks like text
  if (!looksLikeCode) {
    const nameStarts = new Set(view.filter(v => normText(v.name).startsWith(qText)).map(v => v.code));
    if (nameStarts.size) {
      console.log('[resolve] name startsWith hits:', nameStarts.size);
      return pickBestCode(nameStarts);
    }
    const locStarts = new Set(view.filter(v => normText(v.location).startsWith(qText)).map(v => v.code));
    if (locStarts.size) {
      console.log('[resolve] location startsWith hits:', locStarts.size);
      return pickBestCode(locStarts);
    }
  }

  // 7) Fuzzy across all searchable text
  const fz = fuse.search(q);
  if (fz.length) {
    const top = fz[0];
    console.log('[resolve] fuzzy top:', {
      score: top.score?.toFixed(3),
      code: view[top.item.i].code,
      name: view[top.item.i].name,
    });
    return view[top.item.i].code;
  }

  return null;
}

function rowsForCode(code) {
  // return original rows that match that code (case-insensitively)
  const cNorm = normCode(code);
  const rows = [];
  for (let n = 0; n < view.length; n++) {
    if (normCode(view[n].code) === cNorm) rows.push(cache[n]);
  }
  return rows;
}

// ─── Handler ───────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  const t0 = performance.now();
  try {
    const { term = '' } = req.body || {};
    const raw = term.toString();
    const q   = sanitizeTerm(raw);

    console.log('──────────────────────────────────────────────');
    console.log('[handler] raw term:', JSON.stringify(raw));
    console.log('[handler] sanitized:', JSON.stringify(q), 'len:', q.length);

    if (!q) return res.status(400).json({ error: 'term missing' });

    await load();

    const chosenCode = resolveProductCode(q);
    console.log('[resolve] chosen product_code:', chosenCode || '(none)');

    if (!chosenCode) {
      if (/^bdm_\d+$/i.test(q)) {
        const near = view
          .filter(v => normCode(v.code).includes(normCode(q)))
          .slice(0, 5)
          .map(v => v.code);
        console.log('[debug] code includes (first5):', near);
      }
      console.log('[resolve] no match – returning empty array');
      return res.json([]);
    }

    const rows = rowsForCode(chosenCode);
    console.log('[result] rows for code:', chosenCode, 'count:', rows.length);
    console.log('[done] elapsed ms:', (performance.now() - t0).toFixed(1));
    return res.json(rows);
  } catch (err) {
    console.error('[fatal]', err);
    return res.status(500).json({ error: err.message });
  }
};
