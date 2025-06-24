// … same imports & load() as before …

module.exports = async (req, res) => {
  const t0 = performance.now();
  try {
    const { term = '' } = req.body || {};
    const q = term.toString().trim();
    console.log('──────────────────────────────');
    console.log('[handler] term:', `"${q}"`);

    if (!q) return res.status(400).json({ error: 'term missing' });

    await load();

    // 1) exact code match
    const exact = cache.filter(r =>
      r.product_code && r.product_code.toLowerCase() === q.toLowerCase()
    );

    // ── NEW: code-pattern detection ──────────────────────
    const isCode = /^BDM_\d+$/i.test(q);
    if (isCode) {
      console.log('[mode] strict-code search. exact hits:', exact.length);
      return res.json(exact);          // empty array if not found
    }

    // 2) fuzzy fallback for names, barcodes, etc.
    const fuzzyRaw = fuse.search(q);
    const hits = exact.length ? exact
               : fuzzyRaw.map(r => r.item).slice(0, 10);

    console.log('[mode] fuzzy search. hits returned:', hits.length);
    return res.json(hits);
  } catch (err) {
    console.error('[fatal]', err);
    return res.status(500).json({ error: err.message });
  }
};
