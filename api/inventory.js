[req] raw body: {"term":"BDM_12345"}
[handler] incoming term: "BDM_12345" len: 9
[load] refreshing cache from Supabase …
[load] cache rebuilt – rows: 1000 mem ~ 0.5 MB
[exact] count: 0 sample: []
[fuse] total: 92 top-5: [
  {
    score: '0.111',
    code: 'BDM_1034575',
    name: 'STAT MIXER MBX6.5-20-S 10:1 SP (Pakuotė)'
  },
  {
    score: '0.111',
    code: 'BDM_234503',
    name: 'LOCTITE 573 TTL 50 ml EGFD'
  },
  {
    score: '0.111',
    code: 'BDM_234534',
    name: 'LOCTITE 574 ACC50ML EGFD'
  },
  {
    score: '0.111',
    code: 'BDM_234534',
    name: 'LOCTITE 574 ACC50ML EGFD'
  },
  {
    score: '0.222',
    code: 'BDM_1034026',
    name: '50 ML-S 10:1 CART DISP S-50 AU'
  }
]
[hits] returned: 10 sample: [ 'BDM_1034575', 'BDM_234503', 'BDM_234534' ]
[done] elapsed ms: 1076.3


code:

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
const TTL = 5 * 60 * 1000; // 5 min

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
              'mem ~', (JSON.stringify(cache).length / 1024 / 1024).toFixed(1), 'MB');
}

// ─── Handler ────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  const t0 = performance.now();
  try {
    console.log('──────────────────────────────────────────────');
    console.log('[req] raw body:', JSON.stringify(req.body));

    const { term = '' } = req.body || {};
    const q = term.toString().trim();
    console.log('[handler] incoming term:', "${q}", 'len:', q.length);

    if (!q) return res.status(400).json({ error: 'term missing' });

    await load();

    // exact match
    const exact = cache.filter(r =>
      r.product_code && r.product_code.toLowerCase() === q.toLowerCase()
    );
    console.log('[exact] count:', exact.length,
      'sample:', exact.slice(0, 3).map(r => r.product_code));

    // fuzzy
    const fuzzyRaw = fuse.search(q);
    console.log('[fuse] total:', fuzzyRaw.length,
      'top-5:', fuzzyRaw.slice(0, 5).map(r => ({
        score: r.score.toFixed(3),
        code:  r.item.product_code,
        name:  r.item.product_name.slice(0, 40)
      }))
    );

    const hits = exact.length ? exact : fuzzyRaw.map(r => r.item).slice(0, 10);
    console.log('[hits] returned:', hits.length,
      'sample:', hits.slice(0, 3).map(r => r.product_code));

    console.log('[done] elapsed ms:', (performance.now() - t0).toFixed(1));
    return res.json(hits);
  } catch (err) {
    console.error('[fatal]', err);
    return res.status(500).json({ error: err.message });
  }
};
