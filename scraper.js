/*
 * Skalse Dota 2 Picker — Dotabuff data collector.
 *
 * Collects for the current patch:
 *   • counters  /heroes/<hero>/counters  — disadvantage, win rate, matches
 *   • lanes     /heroes/lanes?lane=...   — game share, win rate and GPM of each hero per lane (→ positions 1–5)
 *   • items     /heroes/<hero>/items     — item popularity and win rate
 *   • guides    /heroes/<hero>/guides    — recent top-player matches: lane, role, item timings
 *
 * Normally runs automatically (scripts/update-data.mjs in GitHub Actions or update-data.ps1).
 * Manually: open https://www.dotabuff.com, the console (F12 → Console), paste the whole file, press Enter.
 * data.js downloads in a few minutes.
 */
async function dbcpScrape(opts) {
  // download: false — don't download a file, just return the data (used by the update scripts)
  opts = Object.assign({ concurrency: 3, delay: 250, date: '', download: true, minMatches: 1000 }, opts || {});

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // same normalization as in app.js
  const NAME_FIX = { outworlddevourer: 'outworlddestroyer', skeletonking: 'wraithking', windrunner: 'windranger' };
  const norm = (s) => {
    const k = String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    return NAME_FIX[k] || k;
  };
  const num = (s) => {
    const v = parseFloat(String(s).replace(/[,%\s]/g, ''));
    return Number.isFinite(v) ? v : null;
  };

  // a small progress indicator on top of the page
  const box = document.createElement('div');
  box.style.cssText =
    'position:fixed;z-index:2147483647;right:16px;bottom:16px;padding:12px 16px;' +
    'background:#12161f;color:#e8ecf3;font:13px/1.4 system-ui,sans-serif;border:1px solid #2d3546;' +
    'border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.5);min-width:260px';
  document.body.appendChild(box);
  const status = (t) => { box.textContent = 'Skalse Picker: ' + t; console.log('[Skalse]', t); };

  async function get(path) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetch(path, { credentials: 'include' });
      if (res.ok) return new DOMParser().parseFromString(await res.text(), 'text/html');
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) { await sleep(2500 * (attempt + 1)); continue; }
      throw new Error(path + ' → HTTP ' + res.status);
    }
    throw new Error(path + ' → too many retries');
  }

  async function pool(list, fn) {
    const queue = [...list];
    await Promise.all(Array.from({ length: opts.concurrency }, async () => {
      while (queue.length) {
        const x = queue.shift();
        await fn(x);
        await sleep(opts.delay);
      }
    }));
  }

  // The biggest table whose rows contain a /<kind>/<slug> link followed by numbers.
  function parseTable(doc, kind, minNums) {
    let best = [];
    doc.querySelectorAll('table').forEach((table) => {
      const rows = [];
      for (const tr of table.rows) {
        const link = tr.querySelector(`a[href*="/${kind}/"]`);
        if (!link) continue;
        const m = link.getAttribute('href').match(new RegExp(`/${kind}/([a-z0-9-]+)`));
        if (!m) continue;
        const slug = m[1];

        let name = '';
        tr.querySelectorAll(`a[href*="/${kind}/${slug}"]`).forEach((a) => {
          const t = a.textContent.trim();
          if (t.length > name.length) name = t;
        });
        const img = tr.querySelector('img');
        if (!name && img) name = (img.getAttribute('alt') || img.getAttribute('title') || '').trim();
        if (!name) continue;

        const cells = [...tr.cells];
        let nameIdx = -1;
        cells.forEach((td, i) => { if (td.contains(link) || td.textContent.trim() === name) nameIdx = Math.max(nameIdx, i); });
        const nums = [];
        cells.forEach((td, i) => {
          if (i <= nameIdx) return;
          const v = td.hasAttribute('data-value') ? num(td.getAttribute('data-value')) : num(td.textContent);
          if (v !== null) nums.push(v);
        });
        if (nums.length < minNums) continue;
        rows.push({ slug, name, img: img ? new URL(img.getAttribute('src'), location.origin).href : '', nums });
      }
      if (rows.length > best.length) best = rows;
    });
    return best;
  }

  const parseCounters = (doc) => parseTable(doc, 'heroes', 3)
    .map((r) => ({ slug: r.slug, name: r.name, img: r.img, disadv: r.nums[0], wr: r.nums[1], matches: Math.round(r.nums[2]) }))
    .filter((r) => Math.abs(r.disadv) < 60 && r.wr >= 0 && r.wr <= 100);

  const heroes = {}; // slug -> {name, img}
  const raw = {};    // slug -> rows

  // ---------- period: the current patch if it has enough matches, otherwise the last week ----------
  status('detecting the current patch…');
  let period = opts.date;
  let periodLabel = opts.date;
  let first = null;
  if (!period) {
    const base = await get('/heroes/anti-mage/counters');
    if (!base) throw new Error('Could not open the counters page');
    const label = (v) => {
      const o = base.querySelector(`select[name="date"] option[value="${v}"]`);
      return o ? o.textContent.trim() : v;
    };
    const patch = base.querySelector('select[name="date"] option[value^="patch_"]');
    period = 'month';
    first = base;
    if (patch) {
      const doc = await get('/heroes/anti-mage/counters?date=' + patch.value);
      const rows = doc ? parseCounters(doc) : [];
      const m = rows.map((r) => r.matches).sort((a, b) => a - b);
      const median = m.length ? m[m.length >> 1] : 0;
      if (rows.length >= 50 && median >= opts.minMatches) { period = patch.value; first = doc; }
      else { period = 'week'; first = null; }
    }
    periodLabel = label(period);
  }
  const q = 'date=' + encodeURIComponent(period);

  // ---------- counters ----------
  status(`period: ${periodLabel}, loading the hero list…`);
  if (!first) first = await get('/heroes/anti-mage/counters?' + q);
  if (!first) throw new Error('Could not open the counters page');
  raw['anti-mage'] = parseCounters(first);
  if (raw['anti-mage'].length < 50) {
    status('counters table not found — Dotabuff markup has changed.');
    throw new Error('counters table not found');
  }
  heroes['anti-mage'] = { name: 'Anti-Mage', img: '' };
  raw['anti-mage'].forEach((r) => (heroes[r.slug] = heroes[r.slug] || { name: r.name, img: r.img }));

  const failed = [];
  let done = 1;
  const total = Object.keys(heroes).length;
  await pool(Object.keys(heroes).filter((s) => !raw[s]), async (slug) => {
    try {
      const doc = await get(`/heroes/${slug}/counters?${q}`);
      raw[slug] = doc ? parseCounters(doc) : [];
      raw[slug].forEach((r) => {
        if (!heroes[r.slug]) heroes[r.slug] = { name: r.name, img: r.img };
        else if (!heroes[r.slug].img) heroes[r.slug].img = r.img;
      });
      if (raw[slug].length < 50) failed.push(slug);
    } catch (e) {
      console.warn('[Skalse]', e);
      failed.push(slug);
    }
    status(`counters ${++done}/${total} (${heroes[slug].name})`);
  });

  // The "Win Rate" column may belong to either side. Hero X's disadvantage against Y
  // and X's win rate against Y must correlate negatively — the sign of the correlation
  // tells whose win rate it is; we store it as "candidate's win rate against the enemy".
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, n = 0;
  for (const s in raw) for (const r of raw[s]) {
    sx += r.disadv; sy += r.wr; sxx += r.disadv * r.disadv; syy += r.wr * r.wr; sxy += r.disadv * r.wr; n++;
  }
  const corr = (n * sxy - sx * sy) / Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy) || 1);
  const wrIsEnemys = corr < 0;

  // ---------- lanes: game share / win rate / GPM per lane ----------
  const lanes = {};
  for (const lane of ['safe', 'mid', 'off', 'jungle', 'roaming']) {
    status(`lanes: ${lane}`);
    try {
      const doc = await get(`/heroes/lanes?lane=${lane}&${q}`);
      if (!doc) continue;
      // Hero | Presence | Win Rate | KDA | GPM | XPM
      for (const r of parseTable(doc, 'heroes', 4)) {
        const k = norm(r.name);
        (lanes[k] = lanes[k] || {})[lane] = [+r.nums[0].toFixed(1), +r.nums[1].toFixed(2), Math.round(r.nums[3] || 0)];
      }
    } catch (e) {
      console.warn('[Skalse] lanes', lane, e);
      failed.push('lanes:' + lane);
    }
    await sleep(opts.delay);
  }

  // ---------- items ----------
  const games = {};
  for (const slug in raw) games[slug] = Math.round(raw[slug].reduce((s, r) => s + r.matches, 0) / 5);
  const items = {};
  done = 0;
  await pool(Object.keys(heroes), async (slug) => {
    try {
      const doc = await get(`/heroes/${slug}/items?${q}`);
      // Item | Matches | Win Rate
      const rows = doc ? parseTable(doc, 'items', 2) : [];
      const minM = Math.max(50, (games[slug] || 0) * 0.02);
      items[norm(heroes[slug].name)] = rows
        .filter((r) => r.nums[0] >= minM && r.nums[1] >= 0 && r.nums[1] <= 100)
        .sort((a, b) => b.nums[0] - a.nums[0])
        .slice(0, 45)
        .map((r) => [r.name, Math.round(r.nums[0]), +r.nums[1].toFixed(2)]);
      if (!rows.length) failed.push('items:' + slug);
    } catch (e) {
      console.warn('[Skalse] items', slug, e);
      failed.push('items:' + slug);
    }
    status(`items ${++done}/${total} (${heroes[slug].name})`);
  });

  // ---------- guides: recent top-player matches with lane, role and item timings ----------
  // lane + role → position: safe core 1, mid 2, off core 3, off support 4, safe support 5, roaming 4
  const guidePos = (lane, role) => {
    if (/mid/.test(lane)) return role === 'support' ? 4 : 2;
    if (/safe/.test(lane)) return role === 'support' ? 5 : 1;
    if (/off/.test(lane)) return role === 'support' ? 4 : 3;
    if (/roam/.test(lane)) return 4;
    if (/jungle/.test(lane)) return role === 'support' ? 4 : 3;
    return null;
  };
  const toSec = (t) => {
    const p = String(t).trim().split(':').map(Number);
    if (p.some((x) => !Number.isFinite(x))) return null;
    return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
  };
  function parseGuides(doc) {
    const blocks = [];
    for (const icon of doc.querySelectorAll('i[class*="fa-lane-"]')) {
      let el = icon;
      while (el && !(el.querySelector && el.querySelector('.match-item-with-time') && /View Match/i.test(el.textContent))) el = el.parentElement;
      if (el && !blocks.includes(el)) blocks.push(el);
    }
    return blocks.map((b) => {
      const lane = (b.querySelector('i[class*="fa-lane-"]').className.match(/fa-lane-(\w+)/) || [])[1] || '';
      const roleIcon = b.querySelector('i[class*="fa-role-"]');
      const role = roleIcon ? (roleIcon.className.match(/fa-role-(\w+)/) || [])[1] : 'core';
      const won = /\bwon\b/i.test((b.querySelector('small') || b).textContent);
      const items = [...b.querySelectorAll('.match-item-with-time')]
        .map((m) => ({ name: (m.querySelector('img') || {}).alt || '', t: toSec((m.querySelector('.time') || {}).textContent || '') }))
        .filter((x) => x.name && x.t != null);
      return { pos: guidePos(lane, role), won, items };
    }).filter((g) => g.pos && g.items.length);
  }

  const guides = {};
  done = 0;
  await pool(Object.keys(heroes), async (slug) => {
    const list = [];
    for (let page = 1; page <= (opts.guidePages || 4); page++) {
      try {
        const doc = await get(`/heroes/${slug}/guides${page > 1 ? '?page=' + page : ''}`);
        const g = doc ? parseGuides(doc) : [];
        list.push(...g);
        if (g.length < 3) break;
      } catch (e) {
        console.warn('[Skalse] guides', slug, page, e);
        break;
      }
    }
    // per position: matches, wins and, for each item, in how many matches and the median minute
    const byPos = {};
    for (const g of list) {
      const p = (byPos[g.pos] = byPos[g.pos] || { n: 0, w: 0, items: {} });
      p.n++; if (g.won) p.w++;
      const seen = new Set();
      for (const it of g.items) {
        if (seen.has(it.name)) continue;
        seen.add(it.name);
        (p.items[it.name] = p.items[it.name] || []).push(it.t);
      }
    }
    for (const p of Object.values(byPos)) {
      for (const [name, times] of Object.entries(p.items)) {
        times.sort((a, b) => a - b);
        p.items[name] = [times.length, times[times.length >> 1]];
      }
    }
    guides[norm(heroes[slug].name)] = byPos;
    if (!list.length) failed.push('guides:' + slug);
    status(`guides ${++done}/${total} (${heroes[slug].name})`);
  });

  const out = {
    source: 'dotabuff',
    version: 3,
    updated: new Date().toISOString().slice(0, 10),
    updatedAt: new Date().toISOString(),
    period,
    periodLabel,
    heroes: {},
    games: {},
    m: {},
    lanes,
    items,
    guides,
  };
  for (const slug in heroes) {
    const k = norm(heroes[slug].name);
    out.heroes[k] = { name: heroes[slug].name, slug, img: heroes[slug].img };
    if (games[slug]) out.games[k] = games[slug];
  }
  for (const slug in raw) {
    const row = (out.m[norm(heroes[slug].name)] = {});
    for (const r of raw[slug]) {
      const wr = wrIsEnemys ? 100 - r.wr : r.wr;
      // the enemy's disadvantage against the candidate = the candidate's advantage
      row[norm(r.name)] = [+r.disadv.toFixed(2), +wr.toFixed(2), r.matches];
    }
  }
  out.failed = failed;

  if (opts.download) {
    const blob = new Blob(['window.DBCP_DATA = ' + JSON.stringify(out) + ';\n'], { type: 'text/javascript' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'data.js';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  status(`done: ${Object.keys(out.m).length} heroes` +
    (failed.length ? `, problems with: ${failed.join(', ')}` : '') + (opts.download ? '. data.js downloaded.' : '.'));
  setTimeout(() => box.remove(), 15000);
  return out;
}

if (typeof location !== 'undefined' && /(^|\.)dotabuff\.com$/.test(location.hostname) && !window.DBCP_NO_AUTORUN) {
  dbcpScrape().catch((e) => console.error('[Skalse]', e));
}
