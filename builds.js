'use strict';
/*
 * Билды для героев вашей команды: что собирать, к какой минуте и что против кого.
 *
 *   • какие предметы герой реально собирает  — Dotabuff /heroes/<hero>/items (текущий патч)
 *   • к какой минуте их покупают              — OpenDota /scenarios/itemTimings
 *   • что брать против конкретных врагов      — knowledge.js (угрозы героев → контр-предметы)
 *
 * Использует глобальные state/hero/cachedJson/... из app.js (вызывается после его загрузки).
 */

const POS_NAMES = { 1: 'Керри', 2: 'Мид', 3: 'Оффлейн', 4: 'Саппорт 4', 5: 'Саппорт 5' };
const POS_GPM = { 1: 620, 2: 580, 3: 480, 4: 340, 5: 290 };
// кто против кого стоит на линии: моя позиция → позиции врагов
const LANE_FOES = { 1: [3, 4], 5: [3, 4], 2: [2], 3: [1, 5], 4: [1, 5] };
const BOOTS = new Set(['boots', 'phase_boots', 'power_treads', 'arcane_boots', 'tranquil_boots', 'boots_of_bearing', 'guardian_greaves', 'travel_boots']);

const builds = {
  items: null,          // key -> {name, cost, img, neutral, components}
  byName: new Map(),    // norm(dname) -> key
  timings: new Map(),   // heroKey -> Map(item -> {median, early, late, games})
  odPopularity: new Map(),
};

/* ---------- справочник предметов (OpenDota constants, кэш неделя) ---------- */

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

/* ---------- тайминги предметов (OpenDota, кэш сутки) ---------- */

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
      console.warn('[DotaBuffCP] itemTimings', heroKey, e);
    }
  }
  builds.timings.set(heroKey, out);
  return out;
}

/* ---------- статистика предметов героя ---------- */

async function heroItemStats(heroKey) {
  const d = state.dotabuff;
  const games = d && d.games && d.games[heroKey];
  if (d && d.items && d.items[heroKey]) {
    return d.items[heroKey]
      .map(([name, matches, wr]) => ({ key: itemKeyByName(name), matches, wr, share: games ? matches / games : null }))
      .filter((x) => x.key);
  }
  // запасной вариант: OpenDota itemPopularity (матчи высокого уровня)
  const h = hero(heroKey);
  if (!h || !h.id) return [];
  const pop = await cachedJson(`${OD_API}/heroes/${h.id}/itemPopularity`, DAY);
  const ids = new Map(Object.entries(builds.items).map(([k]) => [k, k]));
  const counts = new Map();
  const idToKey = await itemIdMap();
  for (const phase of ['early_game_items', 'mid_game_items', 'late_game_items']) {
    for (const [id, n] of Object.entries(pop[phase] || {})) {
      const k = idToKey.get(+id);
      if (k && ids.has(k)) counts.set(k, (counts.get(k) || 0) + n);
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

/* ---------- сборка рекомендаций ---------- */

function laneGpm(heroKey, pos) {
  const lanes = state.dotabuff && state.dotabuff.lanes && state.dotabuff.lanes[heroKey];
  const lane = { 1: 'safe', 5: 'safe', 2: 'mid', 3: 'off', 4: 'off' }[pos];
  const g = lanes && lanes[lane] && lanes[lane][2];
  // GPM линии смешивает кора и саппорта — берём его только если он похож на позицию
  if (g && (pos <= 3 ? g >= 400 : g < 430)) return g;
  return POS_GPM[pos];
}

function enemyTeam() {
  return state.enemy.map((k, i) => (k ? { key: k, pos: state.enemyPos[i] } : null)).filter(Boolean);
}

function counterItemsFor(heroKey, pos, stats) {
  const { THREATS, COUNTER_ITEMS, ATTACK_ITEMS, THREAT_INFO } = window.DBCP_KB;
  const cls = pos && pos >= 4 ? 'support' : 'core';
  const builds_ = new Map(stats.map((s) => [s.key, s]));
  const foes = pos ? LANE_FOES[pos] : [];
  const acc = new Map();

  for (const e of enemyTeam()) {
    const laneFoe = e.pos && foes.includes(e.pos);
    for (const threat of THREATS[e.key] || []) {
      for (const ci of COUNTER_ITEMS[threat] || []) {
        if (ci.for !== 'any' && ci.for !== cls) continue;
        const own = builds_.get(ci.item);
        if (ATTACK_ITEMS.has(ci.item) && !(own && (own.share == null || own.share >= 0.01))) continue;
        let w = ci.p * (laneFoe ? 1.3 : 1);
        if (['physical', 'evasion', 'passive'].includes(threat) && e.pos && e.pos <= 2) w *= 1.3;
        const a = acc.get(ci.item) || { item: ci.item, score: 0, vs: new Map(), reasons: new Set(), threats: new Set() };
        a.score += w;
        a.vs.set(e.key, (a.vs.get(e.key) || 0) + w);
        a.reasons.add(ci.why);
        a.threats.add(THREAT_INFO[threat].name);
        acc.set(ci.item, a);
      }
    }
  }
  return [...acc.values()]
    .map((a) => {
      const own = builds_.get(a.item);
      if (own && (own.share == null || own.share >= 0.03)) a.score *= 1.4;
      a.own = own || null;
      return a;
    })
    .filter((a) => builds.items[a.item])
    .sort((a, b) => b.score - a.score);
}

async function buildFor(heroKey, pos) {
  const { SKIP_ITEMS, SUPPORT_ITEMS, CORE_ITEMS } = window.DBCP_KB;
  await loadItemConsts();
  const [stats, timings] = await Promise.all([heroItemStats(heroKey), loadTimings(heroKey)]);
  const cls = pos && pos >= 4 ? 'support' : 'core';
  const items = builds.items;

  const ok = stats.filter((s) => {
    const it = items[s.key];
    if (!it || it.neutral || !it.cost || SKIP_ITEMS.has(s.key)) return false;
    if (cls === 'support' && (CORE_ITEMS.has(s.key) || (it.cost > 5000 && !['ultimate_scepter', 'aghanims_shard', 'sheepstick', 'refresher', 'octarine_core', 'wind_waker'].includes(s.key)))) return false;
    if (cls === 'core' && SUPPORT_ITEMS.has(s.key) && !BOOTS.has(s.key)) return false;
    return true;
  });
  // компоненты, которые почти всегда собираются дальше, не показываем
  const present = new Map(ok.map((s) => [s.key, s]));
  const isComponent = (s) => ok.some((o) => o.key !== s.key && items[o.key].components.includes(s.key) && o.matches >= s.matches * 0.5);

  const early = ok
    .filter((s) => items[s.key].cost < 1100 && !BOOTS.has(s.key) && !isComponent(s) && (s.share == null || s.share >= 0.15))
    .slice(0, 3);
  let boots = ok.filter((s) => BOOTS.has(s.key) && s.key !== 'boots' && s.key !== 'travel_boots')[0];
  const core = ok
    .filter((s) => items[s.key].cost >= 1100 && !BOOTS.has(s.key) && !isComponent(s))
    .slice(0, cls === 'core' ? 7 : 5);

  const counters = counterItemsFor(heroKey, pos, stats);
  const counterTop = counters.filter((c) => !present.has(c.item) || !core.some((x) => x.key === c.item)).slice(0, 3);
  const counterSet = new Map(counters.map((c) => [c.item, c]));

  // порядок: ранние → ботинки → остальное по реальному таймингу (OpenDota) или по цене
  const timeOf = (k) => (timings.get(k) ? timings.get(k).median : null);
  const order = (a, b) => {
    const ta = timeOf(a.key), tb = timeOf(b.key);
    if (ta != null && tb != null && ta !== tb) return ta - tb;
    return items[a.key].cost - items[b.key].cost;
  };
  const main = [
    ...core.map((s) => ({ ...s, counter: counterSet.get(s.key) || null })),
    ...counterTop.map((c) => ({ key: c.item, matches: c.own ? c.own.matches : 0, wr: c.own ? c.own.wr : null, share: c.own ? c.own.share : null, counter: c, added: true })),
  ].sort(order);
  const timeline = [...early.map((s) => ({ ...s, phase: 'early' })), ...(boots ? [{ ...boots, phase: 'boots' }] : []), ...main.map((s) => ({ ...s, phase: 'main' }))];

  // ETA: накопленная стоимость / GPM героя на этой позиции; если есть реальный тайминг — он важнее
  const gpm = laneGpm(heroKey, pos || 1);
  let spent = 0, last = 0;
  for (const s of timeline) {
    spent += items[s.key].cost;
    const est = (spent / gpm) + 1;
    const t = timings.get(s.key);
    s.eta = Math.max(last, t ? Math.min(t.median, est * 1.25) : est);
    s.real = !!t;
    s.timing = t || null;
    last = s.eta;
  }

  return { heroKey, pos, cls, gpm, timeline, counters: counters.slice(0, 6) };
}

/* ---------- рендер ---------- */

const mmss = (m) => `${Math.round(m)}'`;

function itemChip(s, opts = {}) {
  const it = builds.items[s.key];
  const t = s.timing;
  const tip = [
    it.name + ` — ${it.cost} золота`,
    s.share != null ? `собирают в ${(s.share * 100).toFixed(0)}% игр` : '',
    s.wr != null ? `винрейт с предметом ${s.wr.toFixed(1)}%` : '',
    t && t.early != null && t.late != null ? `успел до ${mmss(t.median)}: WR ${t.early.toFixed(0)}% · позже: ${t.late.toFixed(0)}%` : '',
    s.counter ? 'против: ' + [...s.counter.vs.keys()].map((k) => hero(k).name).join(', ') + ' — ' + [...s.counter.reasons][0] : '',
  ].filter(Boolean).join('\n');
  const cls = ['item', s.counter ? 'is-counter' : '', s.added ? 'is-added' : ''].join(' ');
  return `<div class="${cls}" title="${esc(tip)}">
    <img src="${it.img}" alt="" loading="lazy">
    ${opts.time === false ? '' : `<span class="item-t">${s.real ? '' : '≈'}${mmss(s.eta)}</span>`}
    ${s.counter ? '<span class="item-flag" aria-hidden="true">⚑</span>' : ''}
  </div>`;
}

function buildCard(b) {
  const h = hero(b.heroKey);
  const phases = [
    { name: 'Линия', list: b.timeline.filter((s) => s.phase === 'early' || s.phase === 'boots') },
    { name: 'До 20 минут', list: b.timeline.filter((s) => s.phase === 'main' && s.eta < 20) },
    { name: '20–30 минут', list: b.timeline.filter((s) => s.phase === 'main' && s.eta >= 20 && s.eta < 30) },
    { name: '30+ минут', list: b.timeline.filter((s) => s.phase === 'main' && s.eta >= 30) },
  ].filter((p) => p.list.length);

  const lane = b.pos ? enemyTeam().filter((e) => e.pos && LANE_FOES[b.pos].includes(e.pos)) : [];
  const laneHtml = lane.length ? `<div class="build-lane">На линии против: ${lane.map((e) => {
    const r = state.results && state.results.get(b.heroKey);
    const v = r && r.vs.find((x) => x.key === e.key);
    const adv = v && v.adv != null ? `<span class="${sign(v.adv)}">${fmt(v.adv)}</span>` : '';
    return `<span class="vs"><img src="${hero(e.key).icon || hero(e.key).img}" alt="">${esc(hero(e.key).name)} ${adv}</span>`;
  }).join(' ')}</div>` : '';

  const counters = b.counters.map((c) => {
    const it = builds.items[c.item];
    return `<div class="counter-row">
      <img class="counter-img" src="${it.img}" alt="">
      <div class="counter-main">
        <div><b>${esc(it.name)}</b>${c.own && c.own.wr != null ? ` <small class="muted">WR ${c.own.wr.toFixed(1)}%</small>` : ''}</div>
        <div class="muted">${esc([...c.reasons].slice(0, 2).join('; '))}</div>
      </div>
      <div class="counter-vs">${[...c.vs.keys()].map((k) => `<img src="${hero(k).icon || hero(k).img}" title="${esc(hero(k).name)}" alt="">`).join('')}</div>
    </div>`;
  }).join('');

  return `<article class="build card">
    <header class="build-head">
      <img class="build-hero" src="${h.img}" alt="">
      <div>
        <div class="build-name">${esc(h.name)}</div>
        <div class="muted">${b.pos ? `Позиция ${b.pos} · ${POS_NAMES[b.pos]}` : 'Позиция не задана'} · ~${Math.round(b.gpm)} GPM</div>
      </div>
    </header>
    ${laneHtml}
    <div class="build-timeline">
      ${phases.map((p) => `<div class="phase"><div class="phase-name">${p.name}</div><div class="phase-items">${p.list.map((s) => itemChip(s)).join('')}</div></div>`).join('')}
    </div>
    ${counters ? `<div class="build-sub">Против этой команды</div><div class="counters">${counters}</div>` :
      (enemyTeam().length ? '' : '<div class="muted build-sub">Добавьте врагов — появятся контр-предметы.</div>')}
  </article>`;
}

let buildsToken = 0;
async function renderBuilds() {
  const section = $('#builds');
  const allies = state.ally.map((k, i) => (k ? { key: k, pos: state.allyPos[i] } : null)).filter(Boolean)
    .sort((a, b) => (a.pos || 9) - (b.pos || 9));
  if (!allies.length) { section.hidden = true; return; }
  section.hidden = false;
  const token = ++buildsToken;
  const body = $('#builds-body');
  if (!body.children.length) body.innerHTML = '<div class="empty-state"><p>Считаю билды…</p></div>';
  try {
    const list = await Promise.all(allies.map((a) => buildFor(a.key, a.pos)));
    if (token !== buildsToken) return;
    body.innerHTML = list.map(buildCard).join('');
  } catch (e) {
    if (token !== buildsToken) return;
    body.innerHTML = `<div class="empty-state"><p>Не удалось загрузить предметы: ${esc(e.message)}</p></div>`;
  }
}
