'use strict';
/*
 * Item builds for your team: what to buy, by which minute and what to buy against whom.
 *
 *   • what the hero actually builds          — Dotabuff /heroes/<hero>/items (current patch, all games)
 *   • what top players build on a position   — Dotabuff /heroes/<hero>/guides (lane + role → position)
 *   • purchase timings                       — Dotabuff Guides, OpenDota /scenarios/itemTimings, GPM estimate
 *   • what to buy against specific enemies   — knowledge.js (hero threats → counter-items)
 *
 * Uses globals from app.js (state, hero, cachedJson, store, t, …); only called after app.js has loaded.
 */

const POS_GPM = { 1: 620, 2: 580, 3: 480, 4: 340, 5: 290 };
// lane opponents: my position → enemy positions
const LANE_FOES = { 1: [3, 4], 5: [3, 4], 2: [2], 3: [1, 5], 4: [1, 5] };
const GUIDE_MIN = 10; // top-player matches on a position required to build from guides alone
const BOOTS = new Set(['boots', 'phase_boots', 'power_treads', 'arcane_boots', 'tranquil_boots', 'boots_of_bearing', 'guardian_greaves', 'travel_boots']);
const SUPPORT_LATE_OK = ['ultimate_scepter', 'aghanims_shard', 'sheepstick', 'refresher', 'octarine_core', 'wind_waker'];

const posName = (p) => t('pos.' + p);

const builds = {
  items: null,          // key -> {name, cost, img, neutral, components}
  byName: new Map(),    // norm(dname) -> key
  timings: new Map(),   // heroKey -> Map(item -> {median, early, late, games})
};

/* ---------- item constants (OpenDota, cached for a week) ---------- */

async function loadItemConsts() {
  if (builds.items) return builds.items;
  const cacheKey = 'dbcp_items_v1';
  let cached = store.get(cacheKey);
  if (!cached || Date.now() - cached.t > 7 * DAY) {
    try {
      const raw = await (await fetch(OD_API + '/constants/items')).json();
      const v = {};
      for (const [key, it] of Object.entries(raw)) {
        if (!it || !it.dname) continue;
        v[key] = {
          name: it.dname,
          cost: it.cost || 0,
          img: it.img ? CDN + it.img.replace(/\?.*$/, '') : '',
          neutral: !!it.tier && !(it.cost > 0),
          components: it.components || [],
        };
      }
      cached = { t: Date.now(), v };
      store.set(cacheKey, cached);
    } catch (e) {
      if (!cached) throw e;
    }
  }
  builds.items = cached.v;
  builds.byName = new Map(Object.entries(builds.items).map(([k, it]) => [norm(it.name), k]));
  return builds.items;
}

const itemKeyByName = (name) => builds.byName.get(norm(String(name).replace(/\s*\(level \d+\)/i, '')));
// Stratz data stores internal item keys, Dotabuff data stores display names
const resolveItem = (x) => (builds.items[x] ? x : itemKeyByName(x));

/* ---------- purchase timings (OpenDota, cached for a day) ---------- */

async function loadTimings(heroKey) {
  if (builds.timings.has(heroKey)) return builds.timings.get(heroKey);
  const h = hero(heroKey);
  const out = new Map();
  if (h && h.id) {
    try {
      const rows = await cachedJson(`${OD_API}/scenarios/itemTimings?hero_id=${h.id}`, DAY);
      const by = new Map();
      for (const r of rows) {
        const b = by.get(r.item) || [];
        b.push({ t: +r.time, g: +r.games, w: +r.wins });
        by.set(r.item, b);
      }
      for (const [item, buckets] of by) {
        buckets.sort((a, b) => a.t - b.t);
        const games = buckets.reduce((s, b) => s + b.g, 0);
        if (games < 8) continue;
        let acc = 0, median = buckets[buckets.length - 1].t;
        for (const b of buckets) { acc += b.g; if (acc >= games / 2) { median = b.t; break; } }
        const split = (pred) => {
          const xs = buckets.filter(pred);
          const g = xs.reduce((s, b) => s + b.g, 0);
          return g >= 5 ? (xs.reduce((s, b) => s + b.w, 0) / g) * 100 : null;
        };
        out.set(item, { median: median / 60, early: split((b) => b.t <= median), late: split((b) => b.t > median), games });
      }
    } catch (e) {
      console.warn('[Skalse] itemTimings', heroKey, e);
    }
  }
  builds.timings.set(heroKey, out);
  return out;
}

/* ---------- hero item statistics ---------- */

async function heroItemStats(heroKey) {
  const d = metaData();
  const games = d && d.games && d.games[heroKey];
  if (d && d.items && d.items[heroKey]) {
    return d.items[heroKey]
      .map(([name, matches, wr]) => ({ key: resolveItem(name), matches, wr, share: games ? matches / games : null }))
      .filter((x) => x.key);
  }
  // fallback: OpenDota itemPopularity (high-level matches only)
  const h = hero(heroKey);
  if (!h || !h.id) return [];
  const pop = await cachedJson(`${OD_API}/heroes/${h.id}/itemPopularity`, DAY);
  const idToKey = await itemIdMap();
  const counts = new Map();
  for (const phase of ['early_game_items', 'mid_game_items', 'late_game_items']) {
    for (const [id, n] of Object.entries(pop[phase] || {})) {
      const k = idToKey.get(+id);
      if (k && builds.items[k]) counts.set(k, (counts.get(k) || 0) + n);
    }
  }
  const max = Math.max(1, ...counts.values());
  return [...counts].map(([key, n]) => ({ key, matches: n, wr: null, share: n / max }));
}

let idMapCache = null;
async function itemIdMap() {
  if (idMapCache) return idMapCache;
  const ids = await cachedJson(OD_API + '/constants/item_ids', 7 * DAY);
  idMapCache = new Map(Object.entries(ids).map(([id, key]) => [+id, key]));
  return idMapCache;
}

/* ---------- building recommendations ---------- */

function laneGpm(heroKey, pos) {
  const lanes = state.dotabuff && state.dotabuff.lanes && state.dotabuff.lanes[heroKey];
  const lane = { 1: 'safe', 5: 'safe', 2: 'mid', 3: 'off', 4: 'off' }[pos];
  const g = lanes && lanes[lane] && lanes[lane][2];
  // lane GPM mixes cores and supports — use it only when it looks like the position
  if (g && (pos <= 3 ? g >= 400 : g < 430)) return g;
  return POS_GPM[pos];
}

function enemyTeam() {
  return state.enemy.map((k, i) => (k ? { key: k, pos: state.enemyPos[i] } : null)).filter(Boolean);
}

// Dotabuff Guides (top-player matches) for this hero on this exact position
function guideFor(heroKey, pos) {
  const d = metaData();
  const g = d && d.guides && d.guides[heroKey];
  const p = g && pos && g[pos];
  if (!p || !p.n) return null;
  const list = Object.entries(p.items)
    .map(([name, [cnt, sec]]) => ({ key: resolveItem(name), cnt, share: cnt / p.n, median: sec / 60 }))
    .filter((x) => x.key && builds.items[x.key]);
  return { n: p.n, w: p.w, list };
}

// Does the item make sense on this position? The ITEM_POS rule is lifted when top players
// actually build the item on this hero in this position (≥2 matches and ≥20%).
function itemFitsPos(key, pos, guide) {
  const rule = window.DBCP_KB.ITEM_POS[key];
  if (!rule || !pos || rule.includes(pos)) return true;
  return !!(guide && guide.n >= 5 && guide.list.some((x) => x.key === key && x.cnt >= 2 && x.share >= 0.2));
}

// How often the hero builds the item: share of guide matches on the position, else patch statistics
function ownShare(key, stats, guide) {
  if (guide && guide.n >= 3) {
    const g = guide.list.find((x) => x.key === key);
    return g ? g.share : 0;
  }
  const s = stats.find((x) => x.key === key);
  return s ? (s.share == null ? 0.05 : s.share) : 0;
}

function counterItemsFor(heroKey, pos, stats, guide) {
  const { THREATS, COUNTER_ITEMS, ATTACK_ITEMS } = window.DBCP_KB;
  const cls = pos && pos >= 4 ? 'support' : 'core';
  const foes = pos ? LANE_FOES[pos] : [];
  const acc = new Map();

  for (const e of enemyTeam()) {
    const laneFoe = e.pos && foes.includes(e.pos);
    for (const threat of THREATS[e.key] || []) {
      for (const ci of COUNTER_ITEMS[threat] || []) {
        if (ci.for !== 'any' && ci.for !== cls) continue;
        if (ci.pos && pos && !ci.pos.includes(pos)) continue;
        if (!itemFitsPos(ci.item, pos, guide)) continue;
        if (ATTACK_ITEMS.has(ci.item) && ownShare(ci.item, stats, guide) < 0.01) continue;
        let w = ci.p * (laneFoe ? 1.3 : 1);
        if (['physical', 'evasion', 'passive'].includes(threat) && e.pos && e.pos <= 2) w *= 1.3;
        const a = acc.get(ci.item) || { item: ci.item, score: 0, vs: new Map(), reasons: [], threats: new Set() };
        a.score += w;
        a.vs.set(e.key, (a.vs.get(e.key) || 0) + w);
        if (!a.reasons.includes(ci.why)) a.reasons.push(ci.why);
        a.threats.add(threat);
        acc.set(ci.item, a);
      }
    }
  }
  return [...acc.values()]
    .filter((a) => builds.items[a.item])
    .map((a) => {
      if (ownShare(a.item, stats, guide) >= 0.03) a.score *= 1.4;
      a.own = stats.find((x) => x.key === a.item) || null;
      return a;
    })
    .sort((a, b) => b.score - a.score);
}

// Step 1: per-hero data (independent of what allies buy)
async function prepareBuild(heroKey, pos) {
  await loadItemConsts();
  const [stats, timings] = await Promise.all([heroItemStats(heroKey), loadTimings(heroKey)]);
  const guide = guideFor(heroKey, pos);
  return {
    heroKey, pos,
    cls: pos && pos >= 4 ? 'support' : 'core',
    gpm: laneGpm(heroKey, pos || 1),
    stats, timings, guide,
    counters: counterItemsFor(heroKey, pos, stats, guide),
  };
}

// Step 2: the timeline. banned — team items assigned to another ally.
function finalizeBuild(b, banned) {
  const { SKIP_ITEMS, SUPPORT_ITEMS, CORE_ITEMS } = window.DBCP_KB;
  const items = builds.items;
  const counters = b.counters.filter((c) => !banned.has(c.item));
  const counterOf = new Map(counters.map((c) => [c.item, c]));
  const statOf = new Map(b.stats.map((s) => [s.key, s]));
  const valid = (k) => { const it = items[k]; return it && !it.neutral && it.cost && !SKIP_ITEMS.has(k); };
  const fits = (k) => itemFitsPos(k, b.pos, b.guide) && !banned.has(k);
  const classOk = (k) => {
    const it = items[k];
    // if top players on this position really build it — don't argue
    if (b.guide && b.guide.n >= 5 && b.guide.list.some((x) => x.key === k && x.cnt >= 2)) return true;
    if (b.cls === 'support') return !CORE_ITEMS.has(k) && (it.cost <= 5000 || SUPPORT_LATE_OK.includes(k));
    return !(SUPPORT_ITEMS.has(k) && !BOOTS.has(k));
  };

  // patch-wide hero statistics filtered for the position
  const ok = b.stats.filter((s) => valid(s.key) && fits(s.key) && classOk(s.key));
  const isComponent = (s) => ok.some((o) => o.key !== s.key && items[o.key].components.includes(s.key) && o.matches >= s.matches * 0.5);
  const early = ok
    .filter((s) => items[s.key].cost < 1100 && !BOOTS.has(s.key) && !isComponent(s) && (s.share == null || s.share >= 0.15))
    .slice(0, 3)
    .map((s) => ({ ...s, phase: 'early' }));

  // median purchase time on this position from guides (item seen in at least 2 matches)
  const guideTime = (k) => {
    const g = b.guide && b.guide.list.find((x) => x.key === k && x.cnt >= 2);
    return g ? g.median : null;
  };

  let main, source;
  if (b.guide && b.guide.n >= GUIDE_MIN) {
    // enough top-player matches on the position: items (≥25% of matches) and order come from them,
    // popularity and win rate — from the whole patch
    source = 'guides';
    // a component that is usually completed into a bigger item from the list (Urn → Vessel, Yasha → Manta) is hidden
    const guideComponent = (x) => b.guide.list.some((o) => o.key !== x.key && items[o.key].components.includes(x.key) && o.cnt >= x.cnt * 0.5);
    main = b.guide.list
      .filter((x) => valid(x.key) && fits(x.key) && x.share >= 0.25 && !early.some((e) => e.key === x.key)
        && (items[x.key].cost >= 1000 || BOOTS.has(x.key)) && !guideComponent(x))
      .sort((x, y) => x.median - y.median)
      .slice(0, b.cls === 'core' ? 7 : 6)
      .map((x) => {
        const s = statOf.get(x.key);
        return {
          key: x.key, guideShare: x.share, share: s ? s.share : null, wr: s ? s.wr : null,
          eta: x.median, real: true, timing: b.timings.get(x.key) || null,
          counter: counterOf.get(x.key) || null,
        };
      });
  } else {
    // few matches on this position: patch-wide statistics filtered by the position rules
    source = 'stats';
    // with at least 5 guide matches, items top players actually bought there go first
    const inGuides = (k) => !!(b.guide && b.guide.n >= 5 && b.guide.list.some((x) => x.key === k));
    const byAffinity = [...ok].sort((x, y) => (inGuides(y.key) - inGuides(x.key)) || (y.matches - x.matches));
    const boots = byAffinity.find((s) => BOOTS.has(s.key) && s.key !== 'boots' && s.key !== 'travel_boots');
    // strong signal: in ≥3 guide matches and ≥40% on this position — always included
    const strong = b.guide && b.guide.n >= 5
      ? b.guide.list
        .filter((x) => x.cnt >= 3 && x.share >= 0.4 && valid(x.key) && fits(x.key) && items[x.key].cost >= 1100 && !BOOTS.has(x.key))
        .map((x) => {
          const s = statOf.get(x.key);
          return { key: x.key, matches: s ? s.matches : 0, share: s ? s.share : null, wr: s ? s.wr : null, guideShare: x.share };
        })
      : [];
    const core = [
      ...strong,
      ...byAffinity.filter((s) => items[s.key].cost >= 1100 && !BOOTS.has(s.key) && !isComponent(s) && !strong.some((x) => x.key === s.key)),
    ].slice(0, b.cls === 'core' ? 5 : 4);
    const timeOf = (k) => (b.timings.get(k) ? b.timings.get(k).median : null);
    main = [...(boots ? [boots] : []), ...core].sort((x, y) => {
      if (BOOTS.has(x.key) !== BOOTS.has(y.key)) return BOOTS.has(x.key) ? -1 : 1;
      const tx = timeOf(x.key), ty = timeOf(y.key);
      if (tx != null && ty != null && tx !== ty) return tx - ty;
      return items[x.key].cost - items[y.key].cost;
    }).map((s) => ({ ...s, counter: counterOf.get(s.key) || null }));
    // time: guides for this position → OpenDota (if < 25 min) → GPM estimate for the position
    let spent = early.reduce((sum, s) => sum + items[s.key].cost, 0), last = 0;
    for (const s of main) {
      spent += items[s.key].cost;
      const est = spent / b.gpm + 1;
      const tm = b.timings.get(s.key);
      const g = guideTime(s.key);
      s.real = g != null || !!(tm && tm.median < 25);
      s.eta = Math.max(last, g != null ? g : s.real ? Math.min(tm.median, est * 1.25) : est);
      s.timing = tm || null;
      last = s.eta;
    }
  }

  // the two best counter-items not yet in the build — "after your first core item"
  const first = main.find((m) => items[m.key].cost >= 1100 && !BOOTS.has(m.key));
  const base = first ? first.eta : 10;
  const extra = counters
    .filter((c) => !main.some((m) => m.key === c.item) && !SKIP_ITEMS.has(c.item) && items[c.item].cost >= 1000)
    .slice(0, 2)
    .map((c) => {
      const tm = b.timings.get(c.item);
      const s = statOf.get(c.item);
      return {
        key: c.item, counter: c, added: true, wr: s ? s.wr : null, share: s ? s.share : null,
        real: !!(tm && tm.median < 25), eta: tm && tm.median < 25 ? tm.median : base + items[c.item].cost / b.gpm, timing: tm || null,
      };
    });
  main = [...main, ...extra].sort((x, y) => x.eta - y.eta).map((s) => ({ ...s, phase: 'main' }));

  // early items: ETA from the accumulated cost
  let spent = 0;
  for (const s of early) { spent += items[s.key].cost; s.eta = spent / b.gpm + 1; s.real = false; }

  return {
    heroKey: b.heroKey, pos: b.pos, cls: b.cls, gpm: b.gpm, source, guide: b.guide,
    timeline: [...early, ...main].filter((s) => s.eta <= 60),
    counters: counters.slice(0, 6),
  };
}

// Team items (Vessel, Pipe, Mekansm…) go to the one or two allies who fit them best
function allocateTeamItems(list) {
  const { TEAM_ITEMS } = window.DBCP_KB;
  const banned = new Map(list.map((b) => [b, new Set()]));
  const owner = new Map();
  for (const [item, rule] of Object.entries(TEAM_ITEMS)) {
    const cands = list.filter((b) => b.counters.some((c) => c.item === item) || ownShare(item, b.stats, b.guide) >= 0.25);
    if (!cands.length) continue;
    // whoever builds it as a core item (≥50% of matches) keeps it
    const core = (b) => (b.guide && b.guide.n >= 5 && ownShare(item, b.stats, b.guide) >= 0.5 ? 0 : 1);
    const rank = (b) => { const i = rule.pref.indexOf(b.pos); return i === -1 ? 99 : i; };
    const sc = (b) => (b.counters.find((c) => c.item === item) || { score: 0 }).score + ownShare(item, b.stats, b.guide) * 10;
    cands.sort((x, y) => core(x) - core(y) || rank(x) - rank(y) || sc(y) - sc(x));
    const keep = Math.max(rule.max, cands.filter((b) => core(b) === 0).length);
    owner.set(item, cands.slice(0, keep).map((b) => b.heroKey));
    cands.slice(keep).forEach((b) => banned.get(b).add(item));
  }
  return { banned, owner };
}

/* ---------- rendering ---------- */

const mmss = (m) => `${Math.round(m)}'`;
const pct0 = (x) => (x * 100).toFixed(0);

function itemChip(s) {
  const it = builds.items[s.key];
  const tm = s.timing;
  const tip = [
    t('item.cost', { name: it.name, cost: it.cost }),
    s.share != null ? t('item.share', { s: pct0(s.share) }) : '',
    s.wr != null ? t('item.wr', { wr: s.wr.toFixed(1) }) : '',
    s.guideShare != null ? t('item.guide', { s: pct0(s.guideShare), t: mmss(s.eta) }) : '',
    tm && tm.early != null && tm.late != null ? t('item.split', { t: mmss(tm.median), a: tm.early.toFixed(0), b: tm.late.toFixed(0) }) : '',
    s.counter ? t('item.vs', { names: [...s.counter.vs.keys()].map((k) => hero(k).name).join(', '), why: L(s.counter.reasons[0]) }) : '',
  ].filter(Boolean).join('\n');
  const cls = ['item', s.counter ? 'is-counter' : '', s.added ? 'is-added' : ''].join(' ');
  return `<div class="${cls}" title="${esc(tip)}" tabindex="0">
    <img src="${it.img}" alt="${esc(it.name)}" loading="lazy">
    <span class="item-t">${s.real ? '' : '≈'}${mmss(s.eta)}</span>
    ${s.counter ? '<span class="item-flag" aria-hidden="true">⚑</span>' : ''}
  </div>`;
}

function sourceNote(b) {
  const d = metaData();
  const games = d && d.games && d.games[b.heroKey];
  const patch = d ? periodName(d) : '';
  const gamesTxt = games
    ? (games >= 1e6 ? t('games.m', { n: (games / 1e6).toFixed(1) }) : t('games.k', { n: Math.round(games / 1000) }))
    : t('games.all');
  const n = b.guide ? b.guide.n : 0;
  if (b.source === 'guides' && d && d.source === 'stratz') return t('build.src.stratz', { patch, p: b.pos, n: n.toLocaleString(LANG) });
  if (b.source === 'guides') return t('build.src.guides', { games: gamesTxt, patch, p: b.pos, n });
  let s = t('build.src.stats', { games: gamesTxt, patch, p: b.pos || '?' });
  if (!b.pos) return s + t('build.src.nopos');
  s += t('build.src.rare', { n });
  if (n) s += t('build.src.rare.timing');
  return s;
}

function counterRow(c, owner) {
  const it = builds.items[c.item];
  const team = owner.has(c.item) ? ` <span class="team-tag">${esc(t('team.tag'))}</span>` : '';
  const wr = c.own && c.own.wr != null ? ` <small class="muted">${esc(t('counter.wr', { wr: c.own.wr.toFixed(1) }))}</small>` : '';
  return `<div class="counter-row">
    <img class="counter-img" src="${it.img}" alt="">
    <div class="counter-main">
      <div><b>${esc(it.name)}</b>${team}${wr}</div>
      <div class="muted">${esc(c.reasons.slice(0, 2).map(L).join('; '))}</div>
    </div>
    <div class="counter-vs">${[...c.vs.keys()].map((k) => `<img src="${hero(k).icon || hero(k).img}" title="${esc(hero(k).name)}" alt="${esc(hero(k).name)}">`).join('')}</div>
  </div>`;
}

function buildCard(b, owner) {
  const h = hero(b.heroKey);
  const tl = b.timeline;
  const phases = [
    { name: t('phase.lane'), list: tl.filter((s) => s.phase === 'early' || s.eta < 10) },
    { name: t('phase.20'), list: tl.filter((s) => s.phase === 'main' && s.eta >= 10 && s.eta < 20) },
    { name: t('phase.30'), list: tl.filter((s) => s.phase === 'main' && s.eta >= 20 && s.eta < 30) },
    { name: t('phase.40'), list: tl.filter((s) => s.phase === 'main' && s.eta >= 30 && s.eta < 40) },
    { name: t('phase.late'), list: tl.filter((s) => s.phase === 'main' && s.eta >= 40) },
  ].filter((p) => p.list.length);

  const lane = b.pos ? enemyTeam().filter((e) => e.pos && LANE_FOES[b.pos].includes(e.pos)) : [];
  const laneHtml = lane.length ? `<div class="build-lane"><span>${esc(t('build.lane'))}</span> ${lane.map((e) => {
    const r = state.results && state.results.get(b.heroKey);
    const v = r && r.vs.find((x) => x.key === e.key);
    const adv = v && v.adv != null ? `<span class="${sign(v.adv)}">${fmt(v.adv)}</span>` : '';
    return `<span class="vs"><img src="${hero(e.key).icon || hero(e.key).img}" alt="">${esc(hero(e.key).name)} ${adv}</span>`;
  }).join(' ')}</div>` : '';

  const top = b.counters.slice(0, 3).map((c) => counterRow(c, owner)).join('');
  const rest = b.counters.slice(3);
  const counters = b.counters.length ? `
    <div class="build-sub">${esc(t('build.vsteam'))}</div>
    <div class="counters">${top}</div>
    ${rest.length ? `<details class="more-counters"><summary>${esc(t('build.more', { n: rest.length }))}</summary>
      <div class="counters">${rest.map((c) => counterRow(c, owner)).join('')}</div></details>` : ''}`
    : (enemyTeam().length ? '' : `<div class="muted build-hint">${esc(t('build.addenemies'))}</div>`);

  return `<article class="build card">
    <header class="build-head">
      <img class="build-hero" src="${h.img}" alt="">
      <div class="build-title">
        <div class="build-name">${esc(h.name)}</div>
        <div class="build-meta">
          ${b.pos ? `<span class="pos-badge pos-${b.pos}">${b.pos}</span>${esc(posName(b.pos))}` : esc(t('build.nopos'))}
          <span class="dot-sep">·</span>~${Math.round(b.gpm)} GPM
        </div>
      </div>
    </header>
    <p class="build-src ${b.source === 'guides' ? '' : 'warn'}">${esc(sourceNote(b))}</p>
    ${laneHtml}
    <div class="build-timeline">
      ${phases.map((p) => `<div class="phase"><div class="phase-name">${esc(p.name)}</div><div class="phase-items">${p.list.map(itemChip).join('')}</div></div>`).join('')}
    </div>
    ${counters}
  </article>`;
}

const skeletonCards = (n) => Array.from({ length: n }, () => `<article class="build card skeleton-card">
  <div class="sk sk-head"></div><div class="sk sk-line"></div><div class="sk sk-row"></div><div class="sk sk-row"></div><div class="sk sk-row short"></div>
</article>`).join('');

let buildsToken = 0;
async function renderBuilds() {
  const section = $('#builds');
  const allies = state.ally.map((k, i) => (k ? { key: k, pos: state.allyPos[i] } : null)).filter(Boolean)
    .sort((a, b) => (a.pos || 9) - (b.pos || 9));
  const jump = $('#jump-builds');
  if (jump) jump.hidden = !allies.length;
  document.body.classList.toggle('has-builds', !!allies.length);
  if (!allies.length) { section.hidden = true; return; }
  section.hidden = false;
  const token = ++buildsToken;
  const body = $('#builds-body');
  if (!body.querySelector('.build:not(.skeleton-card)')) body.innerHTML = skeletonCards(allies.length);
  try {
    const prepared = await Promise.all(allies.map((a) => prepareBuild(a.key, a.pos)));
    if (token !== buildsToken) return;
    const { banned, owner } = allocateTeamItems(prepared);
    patchHTML(body, prepared.map((b) => buildCard(finalizeBuild(b, banned.get(b)), owner)).join(''));
  } catch (e) {
    if (token !== buildsToken) return;
    console.error(e);
    body.innerHTML = `<div class="empty-state"><p>${esc(t('builds.error', { e: e.message }))}</p></div>`;
  }
}
