const { createClient } = require('@supabase/supabase-js');
const Fuse = require('fuse.js');

// Supabase credentials (hard-coded per your request)
const supabase = createClient(
  'https://owwujchagwtanhlmqttm.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im93d3VqY2hhZ3d0YW5obG1xdHRtIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1MDY3NjU0NCwiZXhwIjoyMDY2MjUyNTQ0fQ.xdQlGsx_7PNk8JEziFTM7xJJ2VZtSA-BwYwj_Ydfn7U',
  { auth: { persistSession: false } }
);

let cache = null;
let fuse  = null;
let last  = 0;
const TTL = 5 * 60 * 1000;              // 5 min

async function load() {
  if (cache && Date.now() - last < TTL) return;
  const { data, error } = await supabase.from('products').select('*');
  if (error) throw new Error(error.message);
  cache = data;
  fuse  = new Fuse(cache, {
    keys: ['product_name', 'product_code', 'barcode'],
    threshold: 0.3,
  });
  last  = Date.now();
}

module.exports = async (req, res) => {
  try {
    // Vercel sends JSON only if header is correct
    const { term = '' } = (req.body || {});
    const q = term.toString().trim();
    if (!q) return res.status(400).json({ error: 'term missing' });

    await load();

    const exact = cache.filter(
      r => r.product_code && r.product_code.toLowerCase() === q.toLowerCase()
    );
    const hits  = exact.length ? exact
               : fuse.search(q).map(r => r.item).slice(0, 10);

    return res.json(hits);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
