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
const GUIDE_MIN = 10; // столько матчей топ-игроков на позиции нужно, чтобы строить билд по ним
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

// Билд по гайдам Dotabuff (матчи топ-игроков) именно для этой позиции героя
function guideFor(heroKey, pos) {
  const g = state.dotabuff && state.dotabuff.guides && state.dotabuff.guides[heroKey];
  const p = g && pos && g[pos];
  if (!p || !p.n) return null;
  const list = Object.entries(p.items)
    .map(([name, [cnt, t]]) => ({ key: itemKeyByName(name), cnt, share: cnt / p.n, median: t / 60 }))
    .filter((x) => x.key && builds.items[x.key]);
  return { n: p.n, w: p.w, list };
}

// Уместен ли предмет на позиции. Правило ITEM_POS снимается, если топ-игроки
// реально собирают этот предмет на этом герое на этой позиции (≥20% матчей).
function itemFitsPos(key, pos, guide) {
  const rule = window.DBCP_KB.ITEM_POS[key];
  if (!rule || !pos || rule.includes(pos)) return true;
  return !!(guide && guide.n >= 5 && guide.list.some((x) => x.key === key && x.cnt >= 2 && x.share >= 0.2));
}

// Насколько герой «сам по себе» собирает предмет: доля матчей по гайдам позиции, иначе общая статистика
function ownShare(key, stats, guide) {
  if (guide && guide.n >= 3) {
    const g = guide.list.find((x) => x.key === key);
    return g ? g.share : 0;
  }
  const s = stats.find((x) => x.key === key);
  return s ? (s.share == null ? 0.05 : s.share) : 0;
}

function counterItemsFor(heroKey, pos, stats, guide) {
  const { THREATS, COUNTER_ITEMS, ATTACK_ITEMS, THREAT_INFO } = window.DBCP_KB;
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
    .filter((a) => builds.items[a.item])
    .map((a) => {
      const share = ownShare(a.item, stats, guide);
      if (share >= 0.03) a.score *= 1.4;
      a.own = stats.find((x) => x.key === a.item) || null;
      return a;
    })
    .sort((a, b) => b.score - a.score);
}

// Шаг 1: данные по герою (без учёта того, что берут союзники)
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

// Шаг 2: таймлайн. banned — командные предметы, которые отданы другому союзнику.
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
    // если топ-игроки на этой позиции реально так собирают — не спорим
    if (b.guide && b.guide.n >= 5 && b.guide.list.some((x) => x.key === k && x.cnt >= 2)) return true;
    if (b.cls === 'support') return !CORE_ITEMS.has(k) && (it.cost <= 5000 || ['ultimate_scepter', 'aghanims_shard', 'sheepstick', 'refresher', 'octarine_core', 'wind_waker'].includes(k));
    return !(SUPPORT_ITEMS.has(k) && !BOOTS.has(k));
  };

  // общая статистика героя, отфильтрованная под позицию
  const ok = b.stats.filter((s) => valid(s.key) && fits(s.key) && classOk(s.key));
  const isComponent = (s) => ok.some((o) => o.key !== s.key && items[o.key].components.includes(s.key) && o.matches >= s.matches * 0.5);
  const early = ok
    .filter((s) => items[s.key].cost < 1100 && !BOOTS.has(s.key) && !isComponent(s) && (s.share == null || s.share >= 0.15))
    .slice(0, 3)
    .map((s) => ({ ...s, phase: 'early' }));

  // медианное время покупки по гайдам этой позиции (если предмет встретился хотя бы в 2 матчах)
  const guideTime = (k) => {
    const g = b.guide && b.guide.list.find((x) => x.key === k && x.cnt >= 2);
    return g ? g.median : null;
  };

  let main, source;
  if (b.guide && b.guide.n >= GUIDE_MIN) {
    // на позиции достаточно матчей топ-игроков: состав и порядок — по ним (предметы из ≥25% матчей),
    // популярность и винрейт — по всему патчу
    source = 'guides';
    main = b.guide.list
      .filter((x) => valid(x.key) && fits(x.key) && x.share >= 0.25 && !early.some((e) => e.key === x.key))
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
    // мало матчей на этой позиции: предметы — статистика всего патча, отфильтрованная правилами позиции
    source = 'stats';
    // если на позиции есть хотя бы 5 матчей топ-игроков — сначала предметы, которые они там реально брали
    const inGuides = (k) => !!(b.guide && b.guide.n >= 5 && b.guide.list.some((x) => x.key === k));
    const byAffinity = [...ok].sort((x, y) => (inGuides(y.key) - inGuides(x.key)) || (y.matches - x.matches));
    const boots = byAffinity.find((s) => BOOTS.has(s.key) && s.key !== 'boots' && s.key !== 'travel_boots');
    // сильный сигнал: предмет у топ-игроков на позиции минимум в 3 матчах и ≥40% — берём обязательно
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
    // время: по гайдам этой позиции → по OpenDota (если < 25 мин) → расчёт по GPM на позиции
    let spent = early.reduce((sum, s) => sum + items[s.key].cost, 0), last = 0;
    for (const s of main) {
      spent += items[s.key].cost;
      const est = spent / b.gpm + 1;
      const t = b.timings.get(s.key);
      const g = guideTime(s.key);
      s.real = g != null || !!(t && t.median < 25);
      s.eta = Math.max(last, g != null ? g : s.real ? Math.min(t.median, est * 1.25) : est);
      s.timing = t || null;
      last = s.eta;
    }
  }

  // два лучших контр-предмета, которых ещё нет в билде, — «после первого корового предмета»
  const first = main.find((m) => items[m.key].cost >= 1100 && !BOOTS.has(m.key));
  const base = first ? first.eta : 10;
  const extra = counters
    .filter((c) => !main.some((m) => m.key === c.item) && !SKIP_ITEMS.has(c.item) && items[c.item].cost >= 1000)
    .slice(0, 2)
    .map((c) => {
      const t = b.timings.get(c.item);
      const s = statOf.get(c.item);
      return {
        key: c.item, counter: c, added: true, wr: s ? s.wr : null, share: s ? s.share : null,
        real: !!(t && t.median < 25), eta: t && t.median < 25 ? t.median : base + items[c.item].cost / b.gpm, timing: t || null,
      };
    });
  main = [...main, ...extra].sort((x, y) => x.eta - y.eta).map((s) => ({ ...s, phase: 'main' }));

  // ETA ранних предметов — по накопленной стоимости
  let spent = 0;
  for (const s of early) { spent += items[s.key].cost; s.eta = spent / b.gpm + 1; s.real = false; }

  return {
    heroKey: b.heroKey, pos: b.pos, cls: b.cls, gpm: b.gpm, source, guide: b.guide,
    timeline: [...early, ...main].filter((s) => s.eta <= 60),
    counters: counters.slice(0, 6),
  };
}

// Командные предметы (Vessel, Pipe, Mekansm…) — одному-двум союзникам, кому подходят лучше
function allocateTeamItems(list) {
  const { TEAM_ITEMS } = window.DBCP_KB;
  const banned = new Map(list.map((b) => [b, new Set()]));
  const owner = new Map();
  for (const [item, rule] of Object.entries(TEAM_ITEMS)) {
    const cands = list.filter((b) => b.counters.some((c) => c.item === item) || ownShare(item, b.stats, b.guide) >= 0.25);
    if (!cands.length) continue;
    // кто собирает предмет как часть основного билда (≥50% матчей) — у того он и остаётся
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

/* ---------- рендер ---------- */

const mmss = (m) => `${Math.round(m)}'`;

function itemChip(s) {
  const it = builds.items[s.key];
  const t = s.timing;
  const tip = [
    it.name + ` — ${it.cost} золота`,
    s.share != null ? `собирают в ${(s.share * 100).toFixed(0)}% всех игр героя за патч` : '',
    s.wr != null ? `винрейт с предметом за патч: ${s.wr.toFixed(1)}%` : '',
    s.guideShare != null ? `у топ-игроков на этой позиции: в ${(s.guideShare * 100).toFixed(0)}% матчей, обычно к ${mmss(s.eta)}` : '',
    t && t.early != null && t.late != null ? `успел до ${mmss(t.median)}: WR ${t.early.toFixed(0)}% · позже: ${t.late.toFixed(0)}%` : '',
    s.counter ? 'против: ' + [...s.counter.vs.keys()].map((k) => hero(k).name).join(', ') + ' — ' + [...s.counter.reasons][0] : '',
  ].filter(Boolean).join('\n');
  const cls = ['item', s.counter ? 'is-counter' : '', s.added ? 'is-added' : ''].join(' ');
  return `<div class="${cls}" title="${esc(tip)}">
    <img src="${it.img}" alt="" loading="lazy">
    <span class="item-t">${s.real ? '' : '≈'}${mmss(s.eta)}</span>
    ${s.counter ? '<span class="item-flag" aria-hidden="true">⚑</span>' : ''}
  </div>`;
}

function buildCard(b, owner) {
  const h = hero(b.heroKey);
  const tl = b.timeline;
  const phases = [
    { name: 'Линия', list: tl.filter((s) => s.phase === 'early' || s.eta < 10) },
    { name: 'До 20 минут', list: tl.filter((s) => s.phase === 'main' && s.eta >= 10 && s.eta < 20) },
    { name: '20–30 минут', list: tl.filter((s) => s.phase === 'main' && s.eta >= 20 && s.eta < 30) },
    { name: '30–40 минут', list: tl.filter((s) => s.phase === 'main' && s.eta >= 30 && s.eta < 40) },
    { name: 'Лейт', list: tl.filter((s) => s.phase === 'main' && s.eta >= 40) },
  ].filter((p) => p.list.length);

  const d = state.dotabuff;
  const games = d && d.games && d.games[b.heroKey];
  const patch = d ? periodName(d) : 'патч';
  const gamesTxt = games ? (games >= 1e6 ? (games / 1e6).toFixed(1) + ' млн' : Math.round(games / 1000) + ' тыс.') + ' игр героя' : 'все игры героя';
  const nG = b.guide ? b.guide.n : 0;
  const src = b.source === 'guides'
    ? `Популярность и винрейт — ${gamesTxt} (${patch}). Состав и тайминги для позиции ${b.pos} — ${nG} свежих матчей топ-игроков (~5000+ MMR).`
    : `Предметы — ${gamesTxt} (${patch}), отфильтрованы под позицию ${b.pos || '?'}.` +
      (b.pos ? ` На этой позиции герой редкий: всего ${nG} матч(ей) топ-игроков — мало для отдельного билда${nG ? ', тайминги взяты из них где есть' : ''}.` : ' Задайте позицию — билд станет точнее.');

  const lane = b.pos ? enemyTeam().filter((e) => e.pos && LANE_FOES[b.pos].includes(e.pos)) : [];
  const laneHtml = lane.length ? `<div class="build-lane">На линии против: ${lane.map((e) => {
    const r = state.results && state.results.get(b.heroKey);
    const v = r && r.vs.find((x) => x.key === e.key);
    const adv = v && v.adv != null ? `<span class="${sign(v.adv)}">${fmt(v.adv)}</span>` : '';
    return `<span class="vs"><img src="${hero(e.key).icon || hero(e.key).img}" alt="">${esc(hero(e.key).name)} ${adv}</span>`;
  }).join(' ')}</div>` : '';

  const counters = b.counters.map((c) => {
    const it = builds.items[c.item];
    const team = owner.has(c.item) ? ' <small class="team-tag">на команду</small>' : '';
    return `<div class="counter-row">
      <img class="counter-img" src="${it.img}" alt="">
      <div class="counter-main">
        <div><b>${esc(it.name)}</b>${team}${c.own && c.own.wr != null ? ` <small class="muted">WR ${c.own.wr.toFixed(1)}%</small>` : ''}</div>
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
    <div class="build-src ${b.source === 'guides' ? '' : 'warn'}">${esc(src)}</div>
    ${laneHtml}
    <div class="build-timeline">
      ${phases.map((p) => `<div class="phase"><div class="phase-name">${p.name}</div><div class="phase-items">${p.list.map(itemChip).join('')}</div></div>`).join('')}
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
    const prepared = await Promise.all(allies.map((a) => prepareBuild(a.key, a.pos)));
    if (token !== buildsToken) return;
    const { banned, owner } = allocateTeamItems(prepared);
    body.innerHTML = prepared.map((b) => buildCard(finalizeBuild(b, banned.get(b)), owner)).join('');
  } catch (e) {
    if (token !== buildsToken) return;
    console.error(e);
    body.innerHTML = `<div class="empty-state"><p>Не удалось загрузить предметы: ${esc(e.message)}</p></div>`;
  }
}