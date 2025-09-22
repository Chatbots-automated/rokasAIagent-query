const { createClient } = require('@supabase/supabase-js');
const Fuse = require('fuse.js');
const { performance } = require('perf_hooks');

// ─── Supabase ───────────────────────────────────────────────────────────
const supabase = createClient(
  'https://xvjruntzmvkjzhdpmoca.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh2anJ1bnR6bXZranpoZHBtb2NhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NTI3MDkwNSwiZXhwIjoyMDcwODQ2OTA1fQ.Q1NFONsR2ct5BZV8uS994iItD_Wlq1SGZwH3R4xCPA0',
  { auth: { persistSession: false } }
);

// ─── In-memory cache & indices ─────────────────────────────────────────
let cache = null;
let fuse  = null;
let idx   = null; // normalized indices
let last  = 0;
const TTL = 5 * 60 * 1000; // 5 min

function normCode(v) {
  return (v ?? '').toString().trim().toUpperCase();
}
function normName(v) {
  return (v ?? '').toString().trim().toLowerCase();
}
function barcodeTokens(v) {
  return (v ?? '')
    .toString()
    .toLowerCase()
    .split(/[,\s]+/)
    .filter(Boolean);
}

async function load() {
  if (cache && Date.now() - last < TTL) {
    console.log('[load] using cached data – rows:', cache.length, 'age(ms):', Date.now() - last);
    return;
  }
  console.log('[load] refreshing cache from Supabase …');
  const { data, error } = await supabase.from('products').select('*');
  if (error) throw new Error('Supabase: ' + error.message);

  cache = Array.isArray(data) ? data : [];

  // Build indices
  const byCode = new Map();   // NORM_CODE -> Set(real product_code variants)
  const byName = new Map();   // NORM_NAME -> Set(real product_code)
  const byBc   = new Map();   // barcode token -> Set(real product_code)

  for (const r of cache) {
    const codeRaw = r.product_code ?? '';
    const codeN   = normCode(codeRaw);
    if (codeN) {
      if (!byCode.has(codeN)) byCode.set(codeN, new Set());
      byCode.get(codeN).add(r.product_code);
    }

    const nameN = normName(r.product_name);
    if (nameN) {
      if (!byName.has(nameN)) byName.set(nameN, new Set());
      byName.get(nameN).add(r.product_code);
    }

    for (const t of barcodeTokens(r.barcode)) {
      if (!byBc.has(t)) byBc.set(t, new Set());
      byBc.get(t).add(r.product_code);
    }
  }

  idx = { byCode, byName, byBc };

  fuse = new Fuse(cache, {
    keys: ['product_name', 'product_code', 'barcode'],
    threshold: 0.35,
    includeScore: true,
    ignoreLocation: true,
  });

  last = Date.now();
  console.log('[load] cache rebuilt – rows:', cache.length,
              'mem ~', (JSON.stringify(cache).length / 1024 / 1024).toFixed(1), 'MB');
}

// Normalize incoming term (strip prompt fluff like "Query this item:")
function sanitizeTerm(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  return s
    .replace(/^(query|find|search)\s+(this\s+)?(item|product)\s*:?\s*/i, '')
    .replace(/^"(.*)"$/, '$1')
    .trim();
}

// pick the code with max available sum if multiple
function pickBestCode(codes) {
  if (!codes || !codes.size) return null;
  if (codes.size === 1) return [...codes][0];
  const sums = new Map();
  for (const c of codes) sums.set(c, 0);
  for (const r of cache) {
    if (sums.has(r.product_code)) {
      sums.set(r.product_code, (sums.get(r.product_code) || 0) + (Number(r.available) || 0));
    }
  }
  let best = null, bestSum = -1;
  for (const [c, s] of sums) {
    if (s > bestSum) bestSum = s, best = c;
  }
  return best || [...codes][0];
}

// Resolve to a single product_code (robust)
function resolveProductCode(q) {
  if (!q) return null;

  const qCodeN = normCode(q);
  const qNameN = normName(q);
  const qBcTok = q.toLowerCase().trim();

  // 0) If looks like a BDM code, try multiple strategies
  const looksLikeCode = /^bdm_\d+$/i.test(q);

  // 1) Exact normalized code match via index
  if (looksLikeCode && idx.byCode.has(qCodeN)) {
    const codes = idx.byCode.get(qCodeN);
    console.log('[resolve] exact code via index:', qCodeN, 'variants:', [...codes]);
    return pickBestCode(codes);
  }

  // 2) Strict scan equality with trim (covers trailing spaces in DB)
  {
    const exact = cache.find(r => normCode(r.product_code) === qCodeN);
    if (exact) {
      console.log('[resolve] exact code via scan:', exact.product_code);
      return exact.product_code;
    }
  }

  // 3) code startsWith / includes (handles partials or trailing chars)
  if (looksLikeCode) {
    const cands = cache.filter(r => normCode(r.product_code).startsWith(qCodeN));
    if (cands.length) {
      console.log('[resolve] code startsWith candidates:', cands.length);
      const codes = new Set(cands.map(r => r.product_code));
      return pickBestCode(codes);
    }
    const cands2 = cache.filter(r => normCode(r.product_code).includes(qCodeN));
    if (cands2.length) {
      console.log('[resolve] code includes candidates:', cands2.length);
      const codes = new Set(cands2.map(r => r.product_code));
      return pickBestCode(codes);
    }
  }

  // 4) Exact name via index
  if (idx.byName.has(qNameN)) {
    const codes = idx.byName.get(qNameN);
    console.log('[resolve] exact name via index:', q);
    return pickBestCode(codes);
  }

  // 5) Name startsWith
  {
    const starts = cache.filter(r => normName(r.product_name).startsWith(qNameN));
    if (starts.length) {
      console.log('[resolve] name startsWith hits:', starts.length);
      const codes = new Set(starts.map(r => r.product_code));
      return pickBestCode(codes);
    }
  }

  // 6) Barcode token match (exact token)
  if (idx.byBc.has(qBcTok)) {
    const codes = idx.byBc.get(qBcTok);
    console.log('[resolve] barcode token hit:', qBcTok, 'codes:', [...codes]);
    return pickBestCode(codes);
  }

  // 7) Fuzzy fallback
  const fz = fuse.search(q);
  if (fz.length) {
    console.log('[resolve] fuzzy top:', {
      score: fz[0].score?.toFixed(3),
      code: fz[0].item.product_code,
      name: fz[0].item.product_name,
    });
    return fz[0].item.product_code;
  }

  // 8) Last-ditch: fuzzy on normalized code
  if (looksLikeCode) {
    const fzCode = fuse.search(qCodeN);
    if (fzCode.length) {
      console.log('[resolve] fuzzy code last-ditch:', fzCode[0].item.product_code);
      return fzCode[0].item.product_code;
    }
  }

  return null;
}

function rowsForCode(code) {
  return cache.filter(r => r.product_code === code);
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
      // Extra debug for code-like queries
      if (/^bdm_\d+$/i.test(q)) {
        const normMatches = cache
          .filter(r => normCode(r.product_code).includes(normCode(q)))
          .slice(0, 5)
          .map(r => r.product_code);
        console.log('[debug] norm includes candidates (first 5):', normMatches);
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
