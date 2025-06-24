const { createClient } = require('@supabase/supabase-js');
const Fuse = require('fuse.js');

// ─── Supabase connection ────────────────────────────────────────────────
const supabase = createClient(
  'https://owwujchagwtanhlmqttm.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im93d3VqY2hhZ3d0YW5obG1xdHRtIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1MDY3NjU0NCwiZXhwIjoyMDY2MjUyNTQ0fQ.xdQlGsx_7PNk8JEziFTM7xJJ2VZtSA-BwYwj_Ydfn7U',
  { auth: { persistSession: false } }
);

// ─── In-memory cache & helpers ──────────────────────────────────────────
let cache = null;
let fuse  = null;
let last  = 0;
const TTL = 5 * 60 * 1000; // 5 min

async function load() {
  // Re-use cache if still fresh
  if (cache && Date.now() - last < TTL) {
    console.log('[load] using cached data – rows:', cache.length);
    return;
  }

  console.log('[load] refreshing cache from Supabase …');
  const { data, error } = await supabase.from('products').select('*');

  if (error) {
    console.error('[load] Supabase error:', error.message);
    throw new Error(error.message);
  }

  cache = data;
  fuse  = new Fuse(cache, {
    keys: ['product_name', 'product_code', 'barcode'],
    threshold: 0.3,
  });
  last  = Date.now();

  console.log('[load] cache built – rows:', cache.length);
}

// ─── Serverless handler ────────────────────────────────────────────────
module.exports = async (req, res) => {
  try {
    // Vercel auto-parses JSON when header = application/json
    const { term = '' } = req.body || {};
    const q = term.toString().trim();

    console.log('[handler] incoming term:', q || '(empty)');

    if (!q) {
      console.warn('[handler] term missing');
      return res.status(400).json({ error: 'term missing' });
    }

    await load();

    // 1) Exact code match
    const exact = cache.filter(
      (r) => r.product_code && r.product_code.toLowerCase() === q.toLowerCase()
    );

    // 2) Fuzzy fallback
    const hits =
      exact.length > 0
        ? exact
        : fuse.search(q).map((r) => r.item).slice(0, 10);

    console.log(
      `[handler] exact matches: ${exact.length}, fuzzy matches returned: ${hits.length}`
    );

    return res.json(hits);
  } catch (err) {
    console.error('[handler] fatal error:', err);
    return res.status(500).json({ error: err.message });
  }
};
