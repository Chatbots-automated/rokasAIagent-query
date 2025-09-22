const { createClient } = require('@supabase/supabase-js');
const Fuse = require('fuse.js');
const { performance } = require('perf_hooks');

// ─── Supabase (new project) ─────────────────────────────────────────────
const supabase = createClient(
  'https://xvjruntzmvkjzhdpmoca.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh2anJ1bnR6bXZranpoZHBtb2NhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NTI3MDkwNSwiZXhwIjoyMDcwODQ2OTA1fQ.Q1NFONsR2ct5BZV8uS994iItD_Wlq1SGZwH3R4xCPA0',
  { auth: { persistSession: false } }
);

// ─── In-memory cache ───────────────────────────────────────────────────
let cache = null;
let fuse  = null;
let last  = 0;
const TTL = 5 * 60 * 1000; // 5 min

async function load() {
  if (cache && Date.now() - last < TTL) {
    console.log('[load] using cached data – rows:', cache.length, 'age(ms):', Date.now() - last);
    return;
  }
  console.log('[load] refreshing cache from Supabase …');
  const { data, error } = await supabase
    .from('products')
    .select('*');
  if (error) throw new Error('Supabase: ' + error.message);

  cache = Array.isArray(data) ? data : [];
  fuse  = new Fuse(cache, {
    keys: ['product_name', 'product_code', 'barcode'],
    threshold: 0.3,
    includeScore: true,
    ignoreLocation: true
  });
  last = Date.now();
  console.log('[load] cache rebuilt – rows:', cache.length,
              'mem ~', (JSON.stringify(cache).length / 1024 / 1024).toFixed(1), 'MB');
}

// Normalize incoming term (strip prompt fluff like "Query this item:")
function sanitizeTerm(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  // remove leading directive phrases and quotes
  return s
    .replace(/^(query|find|search)\s+(this\s+)?(item|product)\s*:?\s*/i, '')
    .replace(/^"(.*)"$/, '$1')
    .trim();
}

// Resolve to a single product_code
function resolveProductCode(q) {
  if (!q) return null;
  const qLower = q.toLowerCase();

  // 1) Exact code match BDM_#####
  if (/^bdm_\d+$/i.test(q)) {
    const exactCode = cache.find(r => (r.product_code || '').toLowerCase() === qLower);
    if (exactCode) return exactCode.product_code;
  }

  // 2) Exact name match
  {
    const exactName = cache.find(r => (r.product_name || '').toLowerCase() === qLower);
    if (exactName) return exactName.product_code;
  }

  // 3) Starts-with name match (often nicer than fuzzy)
  {
    const starts = cache.filter(r => (r.product_name || '').toLowerCase().startsWith(qLower));
    if (starts.length) {
      // choose the one with highest total available across rows for that code
      const byCode = new Map();
      for (const row of starts) {
        const code = row.product_code;
        const sum  = (byCode.get(code) || 0) + (Number(row.available) || 0);
        byCode.set(code, sum);
      }
      let bestCode = null, bestAvail = -1;
      for (const [code, sum] of byCode) {
        if (sum > bestAvail) bestAvail = sum, bestCode = code;
      }
      if (bestCode) return bestCode;
    }
  }

  // 4) Barcode contains
  {
    const bcHit = cache.find(r => (r.barcode || '').toLowerCase().split(/[,\s]+/).includes(qLower));
    if (bcHit) return bcHit.product_code;
  }

  // 5) Fuzzy fallback → take top hit’s product_code
  {
    const f = fuse.search(q);
    if (f.length) return f[0].item.product_code;
  }

  return null;
}

// Collect all rows for that product_code (all locations/batches)
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
