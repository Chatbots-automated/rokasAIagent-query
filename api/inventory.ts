import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import Fuse from 'fuse.js';

// ─────────────────────────────────────────
// 1) Supabase connection (keys in-code as requested)
const SUPABASE_URL = 'https://owwujchagwtanhlmqttm.supabase.co';
const SUPABASE_SERVICE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im93d3VqY2hhZ3d0YW5obG1xdHRtIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1MDY3NjU0NCwiZXhwIjoyMDY2MjUyNTQ0fQ.xdQlGsx_7PNk8JEziFTM7xJJ2VZtSA-BwYwj_Ydfn7U';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// ─────────────────────────────────────────
// 2) Simple in-memory cache (persists while the function is “warm”)
let cache: any[] | null = null;
let fuse: Fuse<any> | null = null;
const TTL = 5 * 60 * 1000; // 5-minute refresh window
let lastLoad = 0;

async function loadProducts() {
  if (cache && Date.now() - lastLoad < TTL) return; // still fresh

  const { data, error } = await supabase.from('products').select('*');
  if (error) throw new Error(error.message);

  cache = data!;
  fuse = new Fuse(cache, {
    keys: ['product_name', 'product_code', 'barcode'],
    threshold: 0.3,
  });
  lastLoad = Date.now();
}

// ─────────────────────────────────────────
// 3) Handler
export default async (req: VercelRequest, res: VercelResponse) => {
  try {
    const term = (req.body?.term ?? req.query.term ?? '').toString().trim();
    if (!term) return res.status(400).json({ error: 'term missing' });

    await loadProducts();

    // Exact code match?
    const exact = cache!.filter(
      (r) => r.product_code?.toLowerCase() === term.toLowerCase()
    );
