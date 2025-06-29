const { createClient } = require('@supabase/supabase-js');
const Fuse = require('fuse.js');
const { performance } = require('perf_hooks');

// ─── Supabase connection ────────────────────────────────────────────────
const supabase = createClient(
  'https://owwujchagwtanhlmqttm.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im93d3VqY2hhZ3d0YW5obG1xdHRtIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1MDY3NjU0NCwiZXhwIjoyMDY2MjUyNTQ0fQ.xdQlGsx_7PNk8JEziFTM7xJJ2VZtSA-BwYwj_Ydfn7U',
  { auth: { persistSession: false } }
);

// ─── In-memory cache ────────────────────────────────────────────────────
let cache = null;
let fuse  = null;
let last  = 0;
const TTL = 5 * 60 * 1000;  // 5 min

async function load() {
  if (cache && Date.now() - last < TTL) {
    console.log('[load] using cached data – rows:', cache.length,
                'age(ms):', Date.now() - last);
    return;
  }
  console.log('[load] refreshing cache from Supabase …');
  const { data, error } = await supabase.from('products').select('*');
  if (error) throw new Error('Supabase: ' + error.message);

  cache = data;
  fuse = new Fuse(cache, {
    keys: ['product_name', 'product_code', 'barcode'],
    threshold: 0.3,
    includeScore: true
  });
  last = Date.now();
  console.log('[load] cache rebuilt – rows:', cache.length,
              'mem ~', (JSON.stringify(cache).length / 1024 / 1024).toFixed(1), ' MB');
}

// ─── Handler ────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  const t0 = performance.now();
  try {
    const { term = '' } = req.body || {};
    const q = term.toString().trim();
    console.log(`[handler] incoming term: "${q}" len: ${q.length}`);

    if (!q) return res.status(400).json({ error: 'term missing' });

    await load();

    // 1) exact code match
    const exact = cache.filter(r =>
      r.product_code && r.product_code.toLowerCase() === q.toLowerCase()
    );

    // If query matches BDM_ code pattern, return only exact
    if (/^BDM_\d+$/i.test(q)) {
      console.log('[mode] strict code search. exact hits:', exact.length);
      return res.json(exact);          // may be empty array if not found
    }

    // 2) fuzzy search for names, barcodes, etc.
    const fuzzyRaw = fuse.search(q);
    const hits = exact.length ? exact
               : fuzzyRaw.map(r => r.item).slice(0, 10);

    console.log('[mode] fuzzy search. hits returned:', hits.length);
    console.log('[handler] elapsed ms:', (performance.now() - t0).toFixed(1));
    return res.json(hits);
  } catch (err) {
    console.error('[fatal]', err);
    return res.status(500).json({ error: err.message });
  }
};
