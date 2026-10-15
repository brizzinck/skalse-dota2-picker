'use strict';
/*
 * Skalse Dota 2 Picker — draft, positions and counter-pick suggestions.
 * Item builds live in builds.js, translations in i18n.js, the knowledge base in knowledge.js.
 */

const CDN = 'https://cdn.cloudflare.steamstatic.com';
const OD_API = 'https://api.opendota.com/api';
const DAY = 864e5;
const STALE_DAYS = 3; // older Dotabuff data → switch to OpenDota live automatically

const ATTRS = [
  { k: 'str', color: 'var(--str)' },
  { k: 'agi', color: 'var(--agi)' },
  { k: 'int', color: 'var(--int)' },
  { k: 'all', color: 'var(--all)' },
];
const ROLE_KEYS = ['Carry', 'Support', 'Nuker', 'Disabler', 'Initiator', 'Durable', 'Escape', 'Pusher'];

// aliases and old names for search (key = normalized hero name)
const ALIASES = {
  abaddon: ['avernus'], alchemist: ['razzil'], ancientapparition: ['aa', 'kaldr'],
  antimage: ['am', 'magina'], arcwarden: ['aw', 'zet'], beastmaster: ['bm', 'rexxar'],
  bloodseeker: ['bs', 'strygwyr'], bountyhunter: ['bh', 'gondar'], brewmaster: ['brew', 'mangix'],
  bristleback: ['bb', 'rigwarl'], broodmother: ['brood'], centaurwarrunner: ['cent', 'cw', 'bradwarden'],
  chaosknight: ['ck'], clinkz: ['bone'], clockwerk: ['clock', 'rattletrap'],
  crystalmaiden: ['cm', 'rylai'], darkseer: ['ds', 'ish'], darkwillow: ['dw', 'mireska'],
  dawnbreaker: ['db', 'valora'], deathprophet: ['dp', 'krobelus'], dragonknight: ['dk', 'davion'],
  drowranger: ['drow', 'traxex'], earthshaker: ['es', 'raigor'], earthspirit: ['kaolin'],
  eldertitan: ['et'], emberspirit: ['ember', 'xin'], enchantress: ['ench', 'aiushtha'],
  facelessvoid: ['fv', 'void', 'darkterror'], grimstroke: ['grim'], gyrocopter: ['gyro', 'aurel'],
  hoodwink: ['hw'], invoker: ['kael', 'karl', 'carl', 'voker'], io: ['wisp'], jakiro: ['thd'],
  juggernaut: ['jugg', 'yurnero'], keeperofthelight: ['kotl', 'ezalor'], kez: [],
  legioncommander: ['lc', 'tresdin'], lifestealer: ['ls', 'naix'], lonedruid: ['ld', 'sylla'],
  lycan: ['banehallow'], magnus: ['mag'], medusa: ['dusa', 'gorgon'], meepo: ['geomancer'],
  mirana: ['potm'], monkeyking: ['mk', 'wukong'], morphling: ['morph'], muerta: [],
  nagasiren: ['naga', 'slithice'], naturesprophet: ['np', 'furion'], necrophos: ['necro', 'necrolyte'],
  nightstalker: ['ns', 'balanar'], nyxassassin: ['nyx'], ogremagi: ['ogre', 'om'],
  omniknight: ['omni', 'ok'], oracle: [], outworlddestroyer: ['od', 'harbinger', 'outworlddevourer'],
  pangolier: ['pango', 'donte'], phantomassassin: ['pa', 'mortred'], phantomlancer: ['pl', 'azwraith'],
  primalbeast: ['pb'], pudge: ['butcher'], queenofpain: ['qop', 'akasha'], ringmaster: ['rm'],
  sandking: ['sk', 'crixalis'], shadowdemon: ['sd'], shadowfiend: ['sf', 'nevermore'],
  shadowshaman: ['shaman', 'rhasta'], silencer: ['nortrom'], skywrathmage: ['sky', 'dragonus'],
  sniper: ['kardel'], spectre: ['spec', 'mercurial'], spiritbreaker: ['sb', 'bara', 'barathrum'],
  stormspirit: ['storm', 'ss', 'raijin'], techies: ['squee', 'spleen', 'spoon'],
  templarassassin: ['ta', 'lanaya'], terrorblade: ['tb'], tidehunter: ['tide', 'leviathan'],
  timbersaw: ['timber', 'rizzrack'], tinker: ['boush'], treantprotector: ['treant', 'tree', 'rooftrellen'],
  trollwarlord: ['troll', 'tw'], tusk: ['ymir'], underlord: ['ul', 'pitlord', 'abyssalunderlord'],
  undying: ['dirge'], vengefulspirit: ['venge', 'vs', 'shendelzare'], venomancer: ['veno', 'lesale'],
  voidspirit: ['vs', 'inai'], warlock: ['wl', 'demnok'], weaver: ['skitskurr'],
  windranger: ['wr', 'windrunner', 'lyralei'], winterwyvern: ['ww', 'wyvern', 'auroth'],
  witchdoctor: ['wd', 'zharvakko'], wraithking: ['wk', 'skeletonking', 'ostarion'], zeus: ['zuus'],
  snapfire: ['snap', 'mortimer'], mars: [], marci: [], largo: [],
};

// name normalization: "Nature's Prophet" → naturesprophet, plus renamed heroes
const NAME_FIX = { outworlddevourer: 'outworlddestroyer', skeletonking: 'wraithking', windrunner: 'windranger' };
const norm = (s) => {
  const k = String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  return NAME_FIX[k] || k;
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v) => (v > 0 ? '+' : '') + v.toFixed(2);
// CSS class for a signed value
const sign = (v) => (v > 0.05 ? 'up' : v < -0.05 ? 'down' : 'flat');

// Re-render a container without re-creating its images: <img> nodes with the same src are moved into
// the new markup, so portraits don't blink when only scores, classes or order change.
function patchHTML(el, html) {
  const old = new Map();
  el.querySelectorAll('img').forEach((img) => {
    const list = old.get(img.src) || [];
    list.push(img);
    old.set(img.src, list);
  });
  el.innerHTML = html;
  if (!old.size) return;
  el.querySelectorAll('img').forEach((img) => {
    const list = old.get(img.src);
    if (!list || !list.length) return;
    const keep = list.shift();
    for (const a of [...keep.attributes]) if (!img.hasAttribute(a.name)) keep.removeAttribute(a.name);
    for (const a of [...img.attributes]) if (a.name !== 'src') keep.setAttribute(a.name, a.value);
    img.replaceWith(keep);
  });
}

const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
  del(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

async function cachedJson(url, ttl) {
  const key = 'dbcp_cache:' + url;
  const hit = store.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const v = await res.json();
    store.set(key, { t: Date.now(), v });
    return v;
  } catch (e) {
    if (hit) return hit.v; // offline — use the stale cache
    throw e;
  }
}

/* ===================== state ===================== */

const state = {
  heroes: [],        // [{key, id, name, attr, roles, img, icon, wr}]
  byKey: new Map(),
  dotabuff: null,    // window.DBCP_DATA or an imported file
  stratz: null,      // window.DBCP_STRATZ (per-position statistics, see scripts/stratz.mjs)
  source: 'opendota',
  enemy: [null, null, null, null, null],
  ally: [null, null, null, null, null],
  enemyPos: [null, null, null, null, null],         // positions 1–5
  allyPos: [null, null, null, null, null],
  enemyManual: [false, false, false, false, false], // position set by the user
  allyManual: [false, false, false, false, false],
  pickPos: 0,        // position we pick for: 0 (any — pure counter-pick) | 1–5
  opts: null,        // suggestion sorting, weights and filters (see OPT_DEFAULTS), saved in localStorage
  optsOpen: false,   // the options panel is expanded
  prio: { on: false, strength: 'strong', order: [] }, // enemy priority: order[0] is the enemy you want to counter most
  side: 'dire',      // your side: 'radiant' (shown on the left, as in the game) | 'dire'
  ban: [],
  mode: 'enemy',
  tab: 'best',
  roles: new Set(),
  attr: null,
  query: '',
  showAll: false,
  results: null,     // Map key -> {wr, vs:[...]}
  odMatchups: new Map(),
};

const hero = (k) => state.byKey.get(k);
const atkOf = (k) => (hero(k) || {}).atk || null;
const taken = () => new Set([...state.enemy, ...state.ally, ...state.ban].filter(Boolean));

/* ===================== data ===================== */

async function loadHeroMeta() {
  const list = await cachedJson(OD_API + '/heroStats', DAY);
  return list.map((h) => ({
    key: norm(h.localized_name),
    id: h.id,
    name: h.localized_name,
    attr: h.primary_attr,
    roles: h.roles || [],
    picks: h.pub_pick || 0,
    atk: h.attack_type === 'Melee' ? 'melee' : h.attack_type === 'Ranged' ? 'ranged' : null,
    img: CDN + h.img.replace(/\?$/, ''),
    icon: CDN + h.icon.replace(/\?$/, ''),
    wr: h.pub_pick ? (h.pub_win / h.pub_pick) * 100 : 50,
  }));
}

// data files are loaded by us, bypassing the cache — every visit gets the latest data from the server
function loadDataScript(file) {
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = location.protocol.startsWith('http') ? file + '?v=' + Date.now() : file;
    s.onload = s.onerror = () => resolve();
    document.head.appendChild(s);
  });
}

// the dataset of the selected source; OpenDota live has matchups only
function curData() {
  return state.source === 'stratz' ? state.stratz : state.source === 'dotabuff' ? state.dotabuff : null;
}
// positions, meta and items: the selected source, otherwise the best available (Stratz > Dotabuff)
function metaData() {
  return curData() || state.stratz || state.dotabuff;
}

const stamp = (d) => d.updatedAt || d.updated || '';
const dataAgeDays = (d) => (Date.now() - Date.parse(stamp(d))) / DAY;

function pickDotabuffData() {
  const fromFile = window.DBCP_DATA && window.DBCP_DATA.m ? window.DBCP_DATA : null;
  const imported = store.get('dbcp_data');
  if (fromFile && imported) return stamp(imported) > stamp(fromFile) ? imported : fromFile;
  return fromFile || imported || null;
}

function periodName(d) {
  const p = d.period || '';
  if (p.startsWith('patch_')) return t('period.patch', { v: p.slice(6) });
  if (['week', 'month', '3month'].includes(p)) return t('period.' + p);
  return d.periodLabel || t('period.all');
}

function parseDataFile(text) {
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  const data = JSON.parse(json);
  if (!data || !data.m || !data.heroes) throw new Error(t('err.format'));
  return data;
}

// OpenDota: enemy matchups against every hero → the candidate's advantage.
// Samples are small (high-level matches only), so values are shrunk towards zero.
async function odMatchupsFor(enemyKey) {
  if (state.odMatchups.has(enemyKey)) return state.odMatchups.get(enemyKey);
  const e = hero(enemyKey);
  const rows = await cachedJson(`${OD_API}/heroes/${e.id}/matchups`, DAY);
  const byId = new Map(state.heroes.map((h) => [h.id, h]));
  const logit = (p) => Math.log(p / (1 - p));
  // the enemy's win rate in this sample is the baseline (don't mix pubs and high-level games)
  let wins = 0, games = 0;
  for (const r of rows) { wins += r.wins; games += r.games_played; }
  const enemyWr = games ? Math.min(0.9, Math.max(0.1, wins / games)) : e.wr / 100;
  const out = {};
  for (const r of rows) {
    const c = byId.get(r.hero_id);
    if (!c || !r.games_played) continue;
    const candWr = 1 - r.wins / r.games_played;
    const expected = 1 / (1 + Math.exp(-(logit(c.wr / 100) - logit(enemyWr))));
    // Bayesian shrinkage: noise ~50/√n %, real matchup effects are ~±3%
    const shrink = r.games_played / (r.games_played + 250);
    out[c.key] = [(candWr - expected) * 100 * shrink, candWr * 100, r.games_played];
  }
  state.odMatchups.set(enemyKey, out);
  return out;
}

async function matchupsFor(enemyKey) {
  if (state.source === 'stratz' && state.stratz) return state.stratz.m[enemyKey] || {};
  if (state.source === 'dotabuff' && state.dotabuff) return state.dotabuff.m[enemyKey] || {};
  return odMatchupsFor(enemyKey);
}

let calcToken = 0;
async function calculate() {
  const enemies = state.enemy.filter(Boolean);
  const token = ++calcToken;
  if (!enemies.length) { state.results = null; renderAll(); return; }

  // network fetch ahead (OpenDota) — show placeholders meanwhile
  if (state.source === 'opendota' && enemies.some((k) => !state.odMatchups.has(k))) renderPicksSkeleton();

  let tables;
  try {
    tables = await Promise.all(enemies.map(matchupsFor));
  } catch (e) {
    toast(t('toast.matchups', { e: e.message }));
    return;
  }
  if (token !== calcToken) return;

  const results = new Map();
  for (const h of state.heroes) {
    let wrSum = 0, wrN = 0;
    const vs = enemies.map((ek, i) => {
      const row = tables[i][h.key];
      if (!row) return { key: ek, adv: null };
      wrSum += row[1]; wrN++;
      return { key: ek, adv: row[0], wr: row[1], games: row[2] };
    });
    results.set(h.key, { wr: wrN ? wrSum / wrN : null, vs });
  }
  state.results = results;
  renderAll();
}

function renderAll() {
  renderSlots();
  renderPool();
  renderPicks();
  renderBuilds();
}

/* ===================== positions ===================== */

const MIN_POS_SHARE = 0.1;  // a hero "plays" a position if ≥10% of their games are there

// Hero game share per position: Stratz positions directly, or Dotabuff lanes + GPM
// (on one lane a core farms much more than a support)
const shareCache = new Map();
function posShares(key) {
  if (shareCache.has(key)) return shareCache.get(key);
  const s = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const d = metaData();
  const posStats = d && d.pos && d.pos[key];
  const lanes = d && d.lanes && d.lanes[key];
  if (posStats) {
    for (const [p, [n]] of Object.entries(posStats)) s[p] = n;
  } else if (lanes) {
    for (const [lane, [presence, , gpm]] of Object.entries(lanes)) {
      if (lane === 'safe') s[gpm >= 430 ? 1 : 5] += presence;
      else if (lane === 'mid') s[2] += presence;
      else if (lane === 'off') s[gpm >= 420 ? 3 : 4] += presence;
      else if (lane === 'roaming') s[4] += presence;
    }
  } else {
    // no Dotabuff data — rough guess from OpenDota roles
    const r = (hero(key) || {}).roles || [];
    if (r.includes('Support')) { s[4] += 1; s[5] += 1; }
    if (r.includes('Carry')) { s[1] += 1.5; s[2] += 0.5; }
    if (r.includes('Initiator') || r.includes('Durable')) s[3] += 1;
    if (r.includes('Nuker') && !r.includes('Support')) s[2] += 0.7;
    if (!r.length) [1, 2, 3, 4, 5].forEach((p) => (s[p] = 1));
  }
  const total = Object.values(s).reduce((a, b) => a + b, 0) || 1;
  for (const p in s) s[p] /= total;
  shareCache.set(key, s);
  return s;
}

// Lay out a team over positions: manual positions stay, the rest get the most likely
// assignment (brute force, at most 5! permutations).
function autoAssign(side) {
  const heroes = state[side], pos = state[side + 'Pos'], manual = state[side + 'Manual'];
  heroes.forEach((k, i) => {
    if (!k) { pos[i] = null; manual[i] = false; } else if (!manual[i]) pos[i] = null;
  });
  const used = new Set(pos.filter(Boolean));
  const free = [1, 2, 3, 4, 5].filter((p) => !used.has(p));
  const idx = heroes.map((k, i) => (k && !manual[i] ? i : -1)).filter((i) => i >= 0);
  let best = null, bestScore = -Infinity;
  (function rec(j, left, acc, score) {
    if (j === idx.length) { if (score > bestScore) { bestScore = score; best = acc.slice(); } return; }
    const sh = posShares(heroes[idx[j]]);
    left.forEach((p, n) => {
      acc.push(p);
      rec(j + 1, left.filter((_, m) => m !== n), acc, score + Math.log(sh[p] + 0.01));
      acc.pop();
    });
  })(0, free, [], 0);
  if (best) idx.forEach((i, j) => (pos[i] = best[j]));
}

function setPosition(side, i, p) {
  const pos = state[side + 'Pos'], manual = state[side + 'Manual'];
  const other = pos.findIndex((x, j) => j !== i && x === p && state[side][j]);
  if (other !== -1) manual[other] = false; // free it — autoAssign will place it again
  pos[i] = p;
  manual[i] = true;
  changed();
}

const targetPos = () => state.pickPos || null;

// Position meta: the hero's win rate on that position in the current patch
// (Stratz: exactly on the position; Dotabuff: on the position's lane)
function posMeta(key, P) {
  if (!P) return null;
  const d = metaData();
  let wr = null;
  if (d && d.pos) {
    const r = d.pos[key] && d.pos[key][P];
    if (r) wr = r[1];
  } else {
    const lanes = d && d.lanes && d.lanes[key];
    const lane = { 1: 'safe', 5: 'safe', 2: 'mid', 3: 'off', 4: 'off' }[P];
    let row = lanes && lanes[lane];
    if (P === 4 && lanes && lanes.roaming && (!row || lanes.roaming[0] > row[0])) row = lanes.roaming;
    if (row) wr = row[1];
  }
  if (wr == null) return null;
  // rare off-role picks (Lycan mid, …) are played mostly by specialists — their win rate is inflated,
  // so the meta weight grows with the hero's share of games on the position (full weight from 40%)
  const conf = Math.min(1, posShares(key)[P] / 0.4);
  return { wr, delta: (wr - 50) * conf, conf };
}

// is this enemy your lane opponent when you pick for position P?
function isLaneFoe(ek, P) {
  if (!P) return false;
  const ep = state.enemyPos[state.enemy.indexOf(ek)];
  return !!ep && LANE_FOES[P].includes(ep);
}

// games of the hero in the current patch (on position P when given)
function heroGames(key, P) {
  const d = metaData();
  const ps = d && d.pos && d.pos[key];
  if (ps) return P ? (ps[P] ? ps[P][0] : 0) : Object.values(ps).reduce((n, r) => n + r[0], 0);
  const total = (d && d.games && d.games[key]) || (hero(key) || {}).picks || 0;
  return P ? total * posShares(key)[P] : total;
}

// the hero's overall win rate in the patch (Stratz: over all positions; otherwise OpenDota pubs)
function heroWr(key) {
  const d = metaData();
  const ps = d && d.pos && d.pos[key];
  if (ps) {
    let n = 0, w = 0;
    for (const [g, wr] of Object.values(ps)) { n += g; w += g * wr; }
    if (n) return w / n;
  }
  const h = hero(key);
  return h ? h.wr : null;
}

function metaFor(key, P) {
  if (P) return posMeta(key, P);
  const wr = heroWr(key);
  return wr == null ? null : { wr, delta: wr - 50, conf: 1 };
}

// Team composition: your picked heroes' melee/ranged split. A team of only melee heroes (or only ranged)
// is easy to kite or to dive, so the missing attack type gets a bonus and the overrepresented one a penalty.
const COMP_WEIGHT = 0.75; // per hero of difference, from a difference of 2: ±1.5 … ±2.25
const COMP_MAX = 2.25;
function teamComp() {
  const c = { melee: 0, ranged: 0 };
  for (const k of state.ally) if (k && atkOf(k)) c[atkOf(k)]++;
  return c;
}
function compBonus(key, comp = teamComp()) {
  const a = atkOf(key);
  if (!a) return 0;
  const diff = comp[a === 'melee' ? 'ranged' : 'melee'] - comp[a];
  if (Math.abs(diff) < 2) return 0;
  return Math.max(-COMP_MAX, Math.min(COMP_MAX, diff * COMP_WEIGHT));
}

/* ===================== enemy priority ===================== */

// multiplier of a counter-pick against the enemy on each place of the priority list
const PRIO_STRENGTH = {
  soft: [1.6, 1.3, 1.1, 1, 0.9],
  strong: [2.5, 1.75, 1.25, 1, 0.75],
  focus: [3, 1, 0.6, 0.4, 0.3],
};

// the priority order, kept in sync with the picked enemies (new ones go to the end)
function prioOrder() {
  const enemies = state.enemy.filter(Boolean);
  const order = state.prio.order.filter((k) => enemies.includes(k));
  for (const k of enemies) if (!order.includes(k)) order.push(k);
  state.prio.order = order;
  return order;
}

function prioWeights() {
  const m = new Map();
  if (!state.prio.on) return m;
  const W = PRIO_STRENGTH[state.prio.strength] || PRIO_STRENGTH.strong;
  prioOrder().forEach((k, i) => m.set(k, W[i]));
  return m;
}

const savePrio = () => store.set('dbcp_prio', { on: state.prio.on, strength: state.prio.strength });

// Every number a suggestion can be ranked by. "Итог" (total) is a weighted sum; the weights live in the options.
//   counter — sum of advantages against all enemies, lane — only against your lane opponents,
//   meta — win rate on the position, comp — melee/ranged balance, safe — the worst single matchup.
function scoreParts(key, P, comp = teamComp()) {
  const w = state.opts.w;
  const r = state.results && state.results.get(key);
  const pw = prioWeights();
  let counter = 0, lane = 0, laneN = 0, safe = null;
  if (r) {
    for (const v of r.vs) {
      if (v.adv == null) continue;
      const adv = v.adv * (pw.get(v.key) || 1); // enemy priority scales the counter-pick against that enemy
      counter += adv;
      if (isLaneFoe(v.key, P)) { lane += adv; laneN++; }
      safe = safe == null ? v.adv : Math.min(safe, v.adv);
    }
  }
  const meta = metaFor(key, P);
  const metaPts = P && meta ? w.meta * meta.delta : 0; // "Any position" stays a pure counter-pick
  const compPts = w.comp * compBonus(key, comp);
  const total = w.counter * (counter - lane) + w.lane * lane + metaPts + compPts;
  return {
    counter, lane, laneN, safe, meta, metaPts, compPts, total,
    wr: r ? r.wr : null, games: heroGames(key, P), share: P ? posShares(key)[P] : null,
  };
}

const totalScore = (key, P) => scoreParts(key, P).total;

/* ===================== suggestion options ===================== */

const METRICS = ['total', 'counter', 'lane', 'meta', 'games', 'share', 'wr', 'safe', 'comp'];
const WEIGHTS = ['counter', 'lane', 'meta', 'comp'];
const OPT_DEFAULTS = {
  sort: 'total', then: '', topN: 10,
  w: { counter: 1, lane: 1.5, meta: 0.5, comp: 1 },
  atk: '', minShare: MIN_POS_SHARE, pop: 0, hard: 0, laneOk: false, metaOk: false,
  critOn: false, critOrder: ['counter', 'lane', 'meta', 'comp', 'games', 'wr', 'safe'],
};
// "Your own order": criteria ranked by dragging; each hero gets a 0–100 rating from its percentiles,
// the first criterion weighs the most
const CRITERIA = OPT_DEFAULTS.critOrder;
const CRIT_W = [1, 0.6, 0.35, 0.2, 0.12, 0.07, 0.04];
// a preset sets only the fields it names
const PRESETS = {
  balance: { critOn: false, sort: 'total', then: '', w: { counter: 1, lane: 1.5, meta: 0.5, comp: 1 } },
  lane: { critOn: false, sort: 'total', then: '', w: { counter: 0.5, lane: 3, meta: 0.5, comp: 0.5 } },
  counter: { critOn: false, sort: 'total', then: '', w: { counter: 1, lane: 1, meta: 0, comp: 0 } },
  meta: { critOn: false, sort: 'total', then: '', w: { counter: 0.5, lane: 0.5, meta: 1.5, comp: 0.5 } },
  popular: { critOn: false, sort: 'games', then: 'total', topN: 15 },
  safe: { critOn: false, sort: 'safe', then: 'total', topN: 15 },
};

function loadOpts() {
  const saved = store.get('dbcp_opts') || {};
  const o = { ...OPT_DEFAULTS, ...saved, w: { ...OPT_DEFAULTS.w, ...(saved.w || {}) } };
  if (!METRICS.includes(o.sort)) o.sort = 'total';
  if (o.then && !METRICS.includes(o.then)) o.then = '';
  // keep the saved criteria order, drop unknown ones, add new ones at the end
  o.critOrder = (Array.isArray(o.critOrder) ? o.critOrder : []).filter((k) => CRITERIA.includes(k));
  for (const k of CRITERIA) if (!o.critOrder.includes(k)) o.critOrder.push(k);
  return o;
}
const saveOpts = () => store.set('dbcp_opts', state.opts);

function applyPreset(name) {
  const p = PRESETS[name];
  Object.assign(state.opts, p, { w: { ...state.opts.w, ...(p.w || {}) } });
}
function presetActive(name) {
  const p = PRESETS[name], o = state.opts;
  return Object.entries(p).every(([k, v]) => (k === 'w' ? WEIGHTS.every((x) => o.w[x] === v[x]) : o[k] === v));
}

// how many settings differ from the defaults (shown on the "Filters" button)
function optsChanged() {
  const o = state.opts, d = OPT_DEFAULTS;
  let n = WEIGHTS.filter((k) => o.w[k] !== d.w[k]).length;
  for (const k of ['sort', 'then', 'atk', 'minShare', 'pop', 'hard', 'laneOk', 'metaOk', 'critOn']) if (o[k] !== d[k]) n++;
  return n + state.roles.size + (state.attr ? 1 : 0);
}

// a metric can be ranked by only when its data is there
function metricOk(m, P, res) {
  if (m === 'counter' || m === 'wr' || m === 'safe') return !!res;
  if (m === 'lane') return !!(res && P && state.enemy.some((k, i) => k && LANE_FOES[P].includes(state.enemyPos[i])));
  if (m === 'share') return !!P;
  return true;
}

const metricVal = (m, p) => (m === 'meta' ? (p.meta ? p.meta.delta : null) : m === 'comp' ? p.compPts : p[m]);

const compact = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)));

function metricText(m, p, res) {
  const v = metricVal(m, p);
  if (v == null) return '—';
  if (m === 'rank') return String(Math.round(v));
  if (m === 'meta') return p.meta.wr.toFixed(1) + '%';
  if (m === 'games') return compact(v);
  if (m === 'share') return Math.round(v * 100) + '%';
  if (m === 'wr') return v.toFixed(1) + '%';
  return fmt(v) + (res || m === 'comp' ? '%' : '');
}
function metricSign(m, p) {
  const v = metricVal(m, p);
  if (v == null || m === 'games' || m === 'share' || m === 'rank') return 'plain';
  return sign(m === 'wr' ? v - 50 : v);
}

/* ===================== actions & undo ===================== */

const DRAFT_KEYS = ['enemy', 'ally', 'enemyPos', 'allyPos', 'enemyManual', 'allyManual', 'ban'];
const snapshot = () => JSON.stringify(Object.fromEntries(DRAFT_KEYS.map((k) => [k, state[k]])));
function restore(snap) {
  Object.assign(state, JSON.parse(snap));
  changed();
}
// run a destructive change and offer "Undo" in the toast
function undoable(message, fn) {
  const snap = snapshot();
  fn();
  toast(message, { label: t('undo'), fn: () => restore(snap) });
}

function add(key, side = state.mode) {
  if (!key || !hero(key) || taken().has(key)) return false;
  if (side === 'ban') {
    state.ban.push(key);
  } else {
    const arr = state[side];
    const i = arr.indexOf(null);
    if (i === -1) { toast(t(side === 'enemy' ? 'toast.full.enemy' : 'toast.full.ally')); return false; }
    arr[i] = key;
    if (side === 'enemy' && state.mode === 'enemy' && !state.enemy.includes(null)) {
      setMode('ally');
      toast(t('toast.enemies.done'));
    }
  }
  changed();
  return true;
}

function remove(key) {
  undoable(t('toast.removed', { name: hero(key).name }), () => {
    for (const side of ['enemy', 'ally']) {
      const i = state[side].indexOf(key);
      if (i !== -1) { state[side][i] = null; state[side + 'Manual'][i] = false; }
    }
    state.ban = state.ban.filter((k) => k !== key);
    changed();
  });
}

function clearSide(side) {
  const empty = side === 'ban' ? !state.ban.length : !state[side].some(Boolean);
  if (empty) return;
  undoable(t('toast.cleared'), () => {
    if (side === 'ban') state.ban = [];
    else {
      state[side] = [null, null, null, null, null];
      state[side + 'Manual'] = [false, false, false, false, false];
    }
    changed();
  });
}

function resetAll() {
  if (!taken().size) return;
  undoable(t('toast.reset'), () => {
    state.enemy = [null, null, null, null, null];
    state.ally = [null, null, null, null, null];
    state.enemyManual = [false, false, false, false, false];
    state.allyManual = [false, false, false, false, false];
    state.ban = [];
    changed();
  });
}

function changed() {
  autoAssign('ally');
  autoAssign('enemy');
  writeHash();
  renderSlots();
  renderPool();
  calculate();
}

/* ===================== search ===================== */

function searchRank(h, q) {
  if (!q) return 0;
  const name = h.name.toLowerCase();
  const nq = norm(q);
  const aliases = ALIASES[h.key] || [];
  if (aliases.includes(nq) || h.key === nq) return 1;
  if (name.startsWith(q.toLowerCase()) || h.key.startsWith(nq)) return 2;
  if (name.split(/[\s-]+/).some((w) => w.startsWith(q.toLowerCase()))) return 3;
  if (aliases.some((a) => a.startsWith(nq))) return 4;
  if (nq && h.key.includes(nq)) return 5;
  return -1;
}

function searchMatches() {
  const q = state.query.trim();
  const busy = taken();
  return state.heroes
    .map((h) => ({ h, r: searchRank(h, q) }))
    .filter((x) => x.r >= 0 && !busy.has(x.h.key))
    .sort((a, b) => a.r - b.r || a.h.name.localeCompare(b.h.name))
    .map((x) => x.h.key);
}

/* ===================== URL ===================== */

function writeHash() {
  const p = [];
  // hero.position — the position is written only when set manually
  const enc = (side) => state[side]
    .map((k, i) => (k ? k + (state[side + 'Manual'][i] ? '.' + state[side + 'Pos'][i] : '') : null))
    .filter(Boolean);
  const e = enc('enemy'), a = enc('ally');
  if (e.length) p.push('e=' + e.join(','));
  if (a.length) p.push('a=' + a.join(','));
  if (state.ban.length) p.push('b=' + state.ban.join(','));
  if (state.side === 'radiant') p.push('s=r');
  if (state.prio.on && state.enemy.filter(Boolean).length > 1) p.push('p=' + prioOrder().join(','));
  history.replaceState(null, '', p.length ? '#' + p.join('&') : location.pathname + location.search);
}

function readHash() {
  const raw = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  if (!raw) return;
  const valid = (k) => hero(k) && !taken().has(k);
  if (!raw.includes('=')) {
    // legacy link format: #Anti-Mage/Axe/...
    raw.split('/').slice(0, 5).forEach((n, i) => {
      const k = norm(n.replace(/_/g, ' '));
      if (valid(k)) state.enemy[i] = k;
    });
    return;
  }
  const params = new URLSearchParams(raw);
  for (const [param, side] of [['e', 'enemy'], ['a', 'ally']]) {
    let i = 0;
    for (const part of (params.get(param) || '').split(',')) {
      const [name, pos] = part.split('.');
      const k = norm(name);
      if (!valid(k) || i >= 5) continue;
      state[side][i] = k;
      if (+pos >= 1 && +pos <= 5) { state[side + 'Pos'][i] = +pos; state[side + 'Manual'][i] = true; }
      i++;
    }
  }
  state.ban = (params.get('b') || '').split(',').map(norm).filter(valid);
  if (params.has('p')) {
    state.prio.on = true;
    state.prio.order = params.get('p').split(',').map(norm);
  }
  if (params.get('s') === 'r' || params.get('s') === 'd') state.side = params.get('s') === 'r' ? 'radiant' : 'dire';
}

/* ===================== rendering ===================== */

// Under a picked hero: whom it beats most (▲) and who beats it (▼) among the other team's heroes.
// Values are from that hero's point of view; colour is from yours: blue = good for you, amber = a threat.
function slotMatchups(side, k) {
  const res = state.results;
  const opp = (side === 'ally' ? state.enemy : state.ally).filter(Boolean);
  if (!res || !opp.length) return '';
  const rows = opp.map((o) => {
    const r = res.get(side === 'ally' ? k : o);
    const v = r && r.vs.find((x) => x.key === (side === 'ally' ? o : k));
    if (!v || v.adv == null) return null;
    return { key: o, adv: side === 'ally' ? v.adv : -v.adv, ours: v.adv };
  }).filter(Boolean).sort((a, b) => b.adv - a.adv);
  if (!rows.length) return '';
  const name = hero(k).name;
  const row = (x, beats) => {
    const tone = x.ours > 0.05 ? 'good' : x.ours < -0.05 ? 'threat' : 'even';
    return `<span class="mu ${tone}"><i aria-hidden="true">${beats ? '▲' : '▼'}</i><img src="${hero(x.key).icon || hero(x.key).img}" alt="${esc(hero(x.key).name)}"><b>${fmt(x.adv)}</b></span>`;
  };
  const best = rows[0], worst = rows[rows.length - 1];
  const out = [];
  if (best.adv > 0.3) out.push(row(best, true));
  if (worst.adv < -0.3 && worst !== best) out.push(row(worst, false));
  const title = rows.map((x) => t(x.adv >= 0 ? 'mu.beats' : 'mu.loses', { a: name, b: hero(x.key).name, v: fmt(x.adv) })).join('\n');
  return `<div class="slot-mu" title="${esc(title)}">${out.length ? out.join('') : `<span class="mu even">${esc(t('mu.even'))}</span>`}</div>`;
}

function renderSide() {
  const allyLeft = state.side === 'radiant';
  $('#draft').classList.toggle('ally-left', allyLeft);
  for (const team of ['ally', 'enemy']) {
    const side = (team === 'ally') === allyLeft ? 'radiant' : 'dire';
    const el = $('.team-' + team);
    el.classList.toggle('side-radiant', side === 'radiant');
    el.classList.toggle('side-dire', side === 'dire');
    const b = $('[data-swap]', el);
    b.innerHTML = `<span aria-hidden="true">${side === 'radiant' ? '☀' : '☾'}</span>${esc(t('side.' + side))}<span class="swap-ico" aria-hidden="true">⇄</span>`;
    b.title = t('side.swap.title');
  }
}

function swapSides() {
  state.side = state.side === 'radiant' ? 'dire' : 'radiant';
  store.set('dbcp_side', state.side);
  renderSide();
  writeHash();
  toast(t('toast.side', { side: t('side.' + state.side) }));
}

function renderSlots() {
  for (const side of ['enemy', 'ally']) {
    patchHTML($('#slots-' + side), state[side].map((k, i) => {
      if (!k) {
        return `<div class="slot-wrap"><button class="slot empty" data-side="${side}" data-i="${i}" title="${esc(t('slot.empty'))}" aria-label="${esc(t('slot.empty'))}"></button></div>`;
      }
      const h = hero(k);
      const cur = state[side + 'Pos'][i];
      const manual = state[side + 'Manual'][i];
      const sh = posShares(k);
      const pos = [1, 2, 3, 4, 5].map((p) => {
        const title = t('pos.title', { p, role: posName(p), share: Math.round(sh[p] * 100) }) + (p === cur && !manual ? t('pos.auto') : '');
        return `<button class="pos ${p === cur ? 'active' : ''} ${p === cur && !manual ? 'auto' : ''}" data-side="${side}" data-i="${i}" data-pos="${p}" title="${esc(title)}" aria-pressed="${p === cur}">${p}</button>`;
      }).join('');
      return `<div class="slot-wrap">
        <button class="slot filled" data-remove="${k}" title="${esc(t('slot.remove', { name: h.name }))}">
          <img src="${h.img}" alt="" loading="lazy"><span class="slot-name">${esc(h.name)}</span><span class="slot-x" aria-hidden="true">×</span>
        </button>
        <div class="pos-pick" role="group">${pos}</div>
        <div class="slot-role">${cur ? esc(posName(cur)) : ''}</div>
        ${slotMatchups(side, k)}
      </div>`;
    }).join(''));
  }
  patchHTML($('#slots-ban'), state.ban.length
    ? state.ban.map((k) => `<button class="ban" data-remove="${k}" title="${esc(t('slot.remove', { name: hero(k).name }))}"><img src="${hero(k).img}" alt="${esc(hero(k).name)}"></button>`).join('')
    : `<span class="empty-note">${esc(t('bans.empty'))}</span>`);
  $$('[data-clear]').forEach((b) => {
    const side = b.dataset.clear;
    b.disabled = side === 'ban' ? !state.ban.length : !state[side].some(Boolean);
  });
  $('#btn-reset').disabled = !taken().size;
}

function renderPool() {
  const q = state.query.trim();
  const matchList = q ? searchMatches() : null;
  const matches = matchList ? new Set(matchList) : null;
  const first = matchList ? matchList[0] : null;
  const res = state.results;

  patchHTML($('#pool'), ATTRS.map((a) => {
    const list = state.heroes.filter((h) => h.attr === a.k).sort((x, y) => x.name.localeCompare(y.name));
    if (!list.length) return '';
    return `<div class="attr-group">
      <div class="attr-title"><i style="background:${a.color}"></i>${esc(t('attr.' + a.k))}</div>
      <div class="tiles">${list.map((h) => tile(h, matches, first, res)).join('')}</div>
    </div>`;
  }).join(''));
}

function tile(h, matches, first, res) {
  const cls = ['tile'];
  let badge = '';
  if (state.enemy.includes(h.key)) cls.push('taken-enemy');
  else if (state.ally.includes(h.key)) cls.push('taken-ally');
  else if (state.ban.includes(h.key)) cls.push('taken');
  else if (res && state.mode === 'ally') {
    // scores light up only while you pick your own heroes; while picking enemies the grid stays neutral
    const P = targetPos();
    const s = totalScore(h.key, P);
    const n = state.enemy.filter(Boolean).length;
    if (s >= 1.5 * n) cls.push('great'); else if (s >= 0.6 * n) cls.push('good'); else if (s <= -0.6 * n) cls.push('bad');
    if (P && posShares(h.key)[P] < MIN_POS_SHARE) cls.push('offpos');
    badge = `<span class="tile-score ${sign(s)}">${fmt(s)}</span>`;
  }
  if (matches) cls.push(matches.has(h.key) ? 'match' : 'dim');
  if (h.key === first) cls.push('first');
  return `<div class="${cls.join(' ')}" data-key="${h.key}" title="${esc(h.name)}" role="button" tabindex="-1">
    <img src="${h.img}" alt="" loading="lazy">${badge}<span class="tile-name">${esc(h.name)}</span></div>`;
}

function renderPosFilter() {
  const btn = (v, label, title) =>
    `<button class="${state.pickPos === v ? 'active' : ''}" data-pickpos="${v}" title="${esc(title)}" aria-pressed="${state.pickPos === v}">${label}</button>`;
  $('#pos-filter').innerHTML =
    `<span class="pos-label">${esc(t('picks.for'))}</span><div class="seg small">` +
    btn(0, esc(t('picks.any')), t('picks.any.title')) +
    [1, 2, 3, 4, 5].map((p) => btn(p, `<b>${p}</b> ${esc(posName(p))}`, t('picks.pos.title', { p }))).join('') +
    '</div>';
}

function renderPresets() {
  const on = state.opts.critOn;
  $('#presets').innerHTML = Object.keys(PRESETS).map((k) =>
    `<button class="chip ${presetActive(k) ? 'active' : ''}" data-preset="${k}" title="${esc(t('preset.' + k + '.title'))}" aria-pressed="${presetActive(k)}">${esc(t('preset.' + k))}</button>`).join('') +
    `<button class="chip crit-toggle ${on ? 'active' : ''}" data-crit-toggle title="${esc(t('crit.title'))}" aria-pressed="${on}"><span aria-hidden="true">⇅</span> ${esc(t('crit.toggle'))}</button>`;
  renderCrit();
  const n = optsChanged();
  const cnt = $('#opts-count');
  cnt.hidden = !n;
  cnt.textContent = n;
  const btn = $('#btn-opts');
  btn.classList.toggle('open', state.optsOpen);
  btn.setAttribute('aria-expanded', state.optsOpen);
}

// segmented control bound to an option: data-opt = option name, data-v = value
function optSeg(key, values, label, disabled = () => false) {
  return `<div class="seg small wrap" role="group">${values.map((v) => {
    const cur = state.opts[key] === v;
    return `<button class="${cur ? 'active' : ''}" data-opt="${key}" data-v="${v}" aria-pressed="${cur}" ${disabled(v) ? 'disabled' : ''}>${esc(label(v))}</button>`;
  }).join('')}</div>`;
}
const optToggle = (key) =>
  `<button class="toggle ${state.opts[key] ? 'on' : ''}" data-toggle="${key}" aria-pressed="${state.opts[key]}"><i aria-hidden="true"></i>${esc(t('opts.' + key))}</button>`;

function renderOpts() {
  const panel = $('#opts');
  panel.hidden = !state.optsOpen;
  if (!state.optsOpen) return;
  const o = state.opts, P = targetPos(), res = state.results;
  const ml = (m) => t('metric.' + m);
  const off = (m) => !metricOk(m, P, res);
  const sortKey = metricOk(o.sort, P, res) ? o.sort : 'total';
  const thenKey = o.then && o.then !== sortKey && metricOk(o.then, P, res) ? o.then : '';
  const hint = o.critOn ? t('crit.sorted') : thenKey ? t('opts.hint.then', { n: o.topN, a: ml(sortKey), b: ml(thenKey) }) : t('opts.hint.single', { a: ml(sortKey) });
  const slider = (k) => {
    const posOnly = (k === 'lane' || k === 'meta') && !P;
    return `<label class="wslider ${posOnly ? 'idle' : ''}" title="${esc(t('metric.' + k + '.title'))}">
      <span>${esc(ml(k))}</span>
      <input type="range" min="0" max="3" step="0.25" value="${o.w[k]}" data-w="${k}">
      <output>×${o.w[k].toFixed(2)}</output></label>`;
  };
  const roles = ROLE_KEYS.map((k) =>
    `<button class="chip ${state.roles.has(k) ? 'active' : ''}" data-role="${k}" aria-pressed="${state.roles.has(k)}">${esc(t('role.' + k))}</button>`).join('');
  const attrs = ATTRS.map((a) =>
    `<button class="chip ${state.attr === a.k ? 'active' : ''}" data-attr="${a.k}" aria-pressed="${state.attr === a.k}"><span class="dot" style="background:${a.color}"></span>${esc(t('attr.' + a.k))}</button>`).join('');
  const row = (label, body, title = '') => `<div class="opt-row"${title ? ` title="${esc(title)}"` : ''}><span class="opt-label">${esc(label)}</span>${body}</div>`;

  panel.innerHTML = `
    <div class="opt-group wide">
      <div class="opt-title">${esc(t('opts.sort'))}</div>
      ${row(t('opts.sort.by'), optSeg('sort', METRICS, ml, off))}
      ${row(t('opts.then'), optSeg('then', ['', ...METRICS], (m) => (m ? ml(m) : t('opts.then.none')), (m) => m && (m === sortKey || off(m))))}
      ${thenKey ? row(t('opts.top'), optSeg('topN', [5, 10, 15, 20, 30], String)) : ''}
      <p class="opt-hint">${esc(hint)}</p>
    </div>
    <div class="opt-group">
      <div class="opt-title">${esc(t('opts.weights'))}</div>
      <div class="wsliders">${WEIGHTS.map(slider).join('')}</div>
      <p class="opt-hint">${esc(t(P ? 'opts.weights.hint' : 'opts.weights.hint.any'))}</p>
    </div>
    <div class="opt-group">
      <div class="opt-title">${esc(t('opts.filters'))}</div>
      ${row(t('opts.atk'), optSeg('atk', ['', 'melee', 'ranged'], (v) => (v ? t('atk.' + v) : t('opts.any'))))}
      ${P ? row(t('opts.minShare'), optSeg('minShare', [0.1, 0.2, 0.35, 0.5], (v) => '≥ ' + Math.round(v * 100) + '%'), t('opts.minShare.title', { p: P })) : ''}
      ${row(t('opts.pop'), optSeg('pop', [0, 0.25, 0.5, 0.75], (v) => t('opts.pop.' + Math.round(v * 100))), t('opts.pop.title'))}
      ${res ? row(t('opts.hard'), optSeg('hard', [0, 3, 2, 1], (v) => (v ? t('opts.hard.n', { n: v }) : t('opts.off'))), t('opts.hard.title')) : ''}
      <div class="opt-row toggles">${metricOk('lane', P, res) ? optToggle('laneOk') : ''}${optToggle('metaOk')}</div>
    </div>
    <div class="opt-group wide">
      <div class="opt-title">${esc(t('opts.roles'))}</div>
      <div class="chips">${roles}</div>
      <div class="chips">${attrs}</div>
    </div>
    <div class="opt-foot"><button class="clear-btn" data-reset ${optsChanged() ? '' : 'disabled'}>${esc(t('opts.reset'))}</button></div>`;
}

function renderPicksSkeleton() {
  $('#picks-body').innerHTML = Array.from({ length: 8 }, () =>
    '<div class="pick skeleton"><div class="sk sk-img"></div><div><div class="sk sk-line"></div><div class="sk sk-line short"></div></div><div class="sk sk-score"></div></div>').join('');
}

// Cards of the picked enemies above the suggestions. With priority on, drag them (or use ← →)
// so that the enemy you hate most is first: counter-picks against it weigh the most.
let prioDrag = null; // key of the card being dragged
let critDrag = null;

// the criteria that can be used right now (lane needs a position and enemy positions, …)
const critActive = (P = targetPos(), res = state.results) => state.opts.critOrder.filter((k) => metricOk(k, P, res));

function renderCrit() {
  const el = $('#crit');
  if (!state.opts.critOn) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  const active = critActive();
  el.innerHTML = `<div class="prio-head"><span class="prio-hint">${esc(t('crit.hint'))}</span></div>
    <div class="crit-list" role="list">${state.opts.critOrder.map((k) => {
      const i = active.indexOf(k);
      const off = i === -1;
      const w = off ? '' : Math.round((CRIT_W[i] / CRIT_W.slice(0, active.length).reduce((a, b) => a + b, 0)) * 100) + '%';
      return `<div class="crit-chip${off ? ' off' : ''}${i === 0 ? ' first' : ''}${k === critDrag ? ' lifted' : ''}" data-key="${k}" role="listitem" tabindex="0"
        title="${esc(off ? t('crit.off') : t('metric.' + k + '.title') + ' · ' + t('crit.drag'))}">
        <b>${off ? '·' : i + 1}</b><span>${esc(t('metric.' + k))}</span>${off ? '' : `<em>${w}</em>`}</div>`;
    }).join('')}</div>`;
}
function renderPrio() {
  const el = $('#prio');
  const order = prioOrder();
  if (order.length < 2) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  const on = state.prio.on;
  const W = PRIO_STRENGTH[state.prio.strength] || PRIO_STRENGTH.strong;
  const strength = Object.keys(PRIO_STRENGTH).map((k) =>
    `<button class="${state.prio.strength === k ? 'active' : ''}" data-prio-strength="${k}" title="${esc(t('prio.s.' + k + '.title'))}" aria-pressed="${state.prio.strength === k}">${esc(t('prio.s.' + k))}</button>`).join('');
  patchHTML(el, `<div class="prio-head">
      <button class="toggle ${on ? 'on' : ''}" data-prio-toggle aria-pressed="${on}"><i aria-hidden="true"></i>${esc(t('prio.toggle'))}</button>
      ${on ? `<div class="seg small" role="group">${strength}</div>` : ''}
      <span class="prio-hint">${esc(t(on ? 'prio.hint.on' : 'prio.hint'))}</span>
    </div>
    <div class="prio-cards ${on ? 'on' : ''}" role="list" style="--n:${order.length}">${order.map((k, i) => {
      const h = hero(k);
      return `<div class="prio-card${k === prioDrag ? ' lifted' : ''}${on && i === 0 ? ' first' : ''}" data-key="${k}" role="listitem" tabindex="0"
        title="${esc(t('prio.card.title', { name: h.name }))}" aria-label="${esc(`${i + 1}. ${h.name}`)}">
        <img src="${h.img}" alt="" draggable="false">
        <span class="prio-rank">${i + 1}</span>
        ${on ? `<span class="prio-w">×${W[i]}</span>` : ''}
        <span class="prio-name">${esc(h.name)}</span>
      </div>`;
    }).join('')}</div>`);
}

function prioChanged() {
  writeHash();
  renderPrio();
  renderPicksList();
  renderPool();
}

function moveInList(list, key, to) {
  const from = list.indexOf(key);
  to = Math.max(0, Math.min(list.length - 1, to));
  if (from === -1 || from === to) return false;
  list.splice(from, 1);
  list.splice(to, 0, key);
  return true;
}
const moveEnemyPrio = (key, to) => moveInList(prioOrder(), key, to);

// Drag to reorder (pointer events: mouse and touch) plus ← → on a focused item.
// The list re-renders while dragging, so the pointer is captured by the container, not the item.
function sortable(box, sel, { start, move, end, step }) {
  let drag = null;
  box.addEventListener('pointerdown', (ev) => {
    const item = ev.target.closest(sel);
    if (!item || ev.button !== 0) return;
    ev.preventDefault();
    drag = { key: item.dataset.key, x: ev.clientX, y: ev.clientY, moved: false, id: ev.pointerId };
    try { box.setPointerCapture(ev.pointerId); } catch { /* synthetic pointer */ }
  });
  box.addEventListener('pointermove', (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    if (!drag.moved) {
      if (Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) < 6) return;
      drag.moved = true;
      box.classList.add('dragging');
      start(drag.key);
    }
    // new place = how many other items are before the pointer (rows first, then x)
    let to = 0;
    for (const el of $$(sel, box)) {
      if (el.dataset.key === drag.key) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom < ev.clientY || (r.top <= ev.clientY && ev.clientX > r.left + r.width / 2)) to++;
    }
    move(drag.key, to);
  });
  const stop = () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    box.classList.remove('dragging');
    if (moved) end();
  };
  box.addEventListener('pointerup', stop);
  box.addEventListener('pointercancel', stop);
  box.addEventListener('keydown', (ev) => {
    const item = ev.target.closest(sel);
    if (!item || (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight')) return;
    ev.preventDefault();
    const key = item.dataset.key;
    step(key, ev.key === 'ArrowLeft' ? -1 : 1);
    const again = box.querySelector(`${sel}[data-key="${key}"]`);
    if (again) again.focus();
  });
}

function renderPicks() {
  renderPosFilter();
  renderPresets();
  renderPrio();
  renderOpts();
  renderPicksList();
}

function renderPicksList() {
  const body = $('#picks-body');
  const res = state.results;
  const P = targetPos();
  const o = state.opts;
  if (!res && !P) {
    body.innerHTML = `<div class="empty-state">
      <div class="empty-icon" aria-hidden="true">⚔</div>
      <h3>${esc(t('empty.title'))}</h3>
      <p>${t('empty.p1')}</p>
      <p>${t('empty.p2')}</p>
      <p class="muted">${esc(t('empty.p3'))}</p>
    </div>`;
    return;
  }

  const busy = taken();
  const comp = teamComp();
  let list = state.heroes.filter((h) => !busy.has(h.key));
  if (P) list = list.filter((h) => posShares(h.key)[P] >= o.minShare);
  const parts = new Map(list.map((h) => [h.key, scoreParts(h.key, P, comp)]));
  const pp = (h) => parts.get(h.key);
  // popularity: cut the rarest share of the candidates (scale-free — sources count games very differently)
  if (o.pop) {
    const g = list.map((h) => pp(h).games).sort((a, b) => a - b);
    const min = g[Math.floor(g.length * o.pop)] || 0;
    list = list.filter((h) => pp(h).games >= min);
  }
  if (state.roles.size) list = list.filter((h) => [...state.roles].every((r) => h.roles.includes(r)));
  if (state.attr) list = list.filter((h) => h.attr === state.attr);
  if (o.atk) list = list.filter((h) => h.atk === o.atk);
  if (res && o.hard) list = list.filter((h) => pp(h).safe == null || pp(h).safe > -o.hard);
  if (o.laneOk && metricOk('lane', P, res)) list = list.filter((h) => pp(h).lane >= 0);
  if (o.metaOk) list = list.filter((h) => !pp(h).meta || pp(h).meta.wr >= 50);

  if (!list.length) {
    body.innerHTML = `<div class="empty-state"><p>${esc(t('picks.none'))}</p></div>`;
    return;
  }

  // "your own order": a 0–100 rating from percentiles of the criteria, weighted by their place
  if (o.critOn) {
    const active = critActive(P, res);
    const sumW = CRIT_W.slice(0, active.length).reduce((a, b) => a + b, 0) || 1;
    for (const h of list) pp(h).rank = 0;
    active.forEach((m, i) => {
      const vals = list.map((h) => metricVal(m, pp(h)) ?? -Infinity).sort((a, b) => a - b);
      const n = vals.length;
      for (const h of list) {
        const v = metricVal(m, pp(h)) ?? -Infinity;
        let lo = 0, hi = n; // share of candidates with a lower value (ties count half)
        while (lo < hi) { const mid = (lo + hi) >> 1; if (vals[mid] < v) lo = mid + 1; else hi = mid; }
        let eq = lo;
        while (eq < n && vals[eq] === v) eq++;
        const pct = n > 1 ? (lo + (eq - lo - 1) / 2) / (n - 1) : 1;
        pp(h).rank += (CRIT_W[i] * pct * 100) / sumW;
      }
    });
  }

  // sort by one metric; optionally take its top N and re-sort them by a second one
  const sortKey = o.critOn ? 'rank' : metricOk(o.sort, P, res) ? o.sort : 'total';
  const thenKey = !o.critOn && o.then && o.then !== sortKey && metricOk(o.then, P, res) ? o.then : '';
  const dir = state.tab === 'best' ? 1 : -1;
  const by = (m) => (a, b) => {
    const va = metricVal(m, pp(a)), vb = metricVal(m, pp(b));
    if (va == null || vb == null) return (va == null) - (vb == null);
    return dir * (vb - va) || pp(b).total - pp(a).total;
  };
  list.sort(by(sortKey));
  let head = list, rest = [];
  if (thenKey) {
    head = list.slice(0, o.topN).sort(by(thenKey));
    rest = list.slice(o.topN);
  }

  const note = !res ? t('note.meta', { p: P, role: posName(P) }) : P ? t('note.pos', { p: P, s: Math.round(o.minShare * 100) }) : '';
  const lack = comp.melee - comp.ranged >= 2 ? 'ranged' : comp.ranged - comp.melee >= 2 ? 'melee' : null;
  const compNote = comp.melee + comp.ranged
    ? `<div class="picks-note comp-note"><span class="comp-bar" aria-hidden="true">${
      state.ally.filter(Boolean).map((k) => `<i class="${atkOf(k) || ''}"></i>`).join('')}</span>${
      esc(t('note.comp', { m: comp.melee, r: comp.ranged }))}${lack && o.w.comp ? ` <b>${esc(t('note.comp.need.' + lack))}</b>` : ''}</div>`
    : '';
  const order = o.critOn
    ? `<div class="picks-order">${esc(t('crit.order', { list: critActive(P, res).map((k) => t('metric.' + k)).join(' → ') }))}</div>`
    : thenKey
    ? `<div class="picks-order">${esc(t('opts.hint.then', { n: o.topN, a: t('metric.' + sortKey), b: t('metric.' + thenKey) }))}</div>` : '';

  const limit = state.showAll ? list.length : Math.max(25, head.length);
  const shown = [...head.map((h) => [h, thenKey || sortKey]), ...rest.map((h) => [h, sortKey])].slice(0, limit);
  const maxOf = (m) => Math.max(1e-9, ...shown.filter(([, k]) => k === m).map(([h]) => Math.abs(metricVal(m, pp(h)) || 0)));
  const max = { [sortKey]: maxOf(sortKey) };
  if (thenKey) max[thenKey] = maxOf(thenKey);

  const cards = shown.map(([h, key], i) => {
    const card = pickCard(h, i, pp(h), key, max[key], P, res, comp);
    return thenKey && i === head.length
      ? `<div class="picks-divider"><span>${esc(t('picks.rest', { a: t('metric.' + sortKey) }))}</span></div>` + card : card;
  }).join('');
  patchHTML(body, (note ? `<div class="picks-note">${esc(note)}</div>` : '') + compNote + order + cards + (list.length > shown.length
    ? `<button class="btn ghost more" id="show-all">${esc(t('showall', { n: list.length }))}</button>` : ''));
}

function pickCard(h, i, p, key, max, P, res, comp) {
  const r = res && res.get(h.key);
  const sub = P ? t('pick.share', { p: P, s: Math.round(posShares(h.key)[P] * 100) }) : h.roles.slice(0, 3).map((x) => t('role.' + x)).join(' · ');
  const atk = h.atk ? `<span class="atk ${h.atk}">${esc(t('atk.' + h.atk))}</span>` : '';
  const order = state.prio.on ? prioOrder() : null;
  const vsList = r ? (order ? [...r.vs].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key)) : r.vs) : [];
  const vs = r ? vsList.map((v) => {
    const e = hero(v.key);
    const lane = isLaneFoe(v.key, P);
    const title = v.adv === null ? t('vs.nodata', { name: e.name })
      : `${e.name}: ${fmt(v.adv)}%` + (v.wr != null ? t('vs.wr', { wr: v.wr.toFixed(1) }) : '') +
        (v.games ? t('vs.games', { n: v.games.toLocaleString(LANG) }) : '') + (lane ? t('vs.lane') : '');
    return `<span class="vs ${lane ? 'lane' : ''}" title="${esc(title)}"><img src="${e.icon || e.img}" alt="">${lane ? `<em>${esc(t('vs.lane.short'))}</em>` : ''}<span class="${v.adv === null ? 'flat' : sign(v.adv)}">${v.adv === null ? '—' : fmt(v.adv)}</span></span>`;
  }).join('') : '';
  // what the hero's place is made of; the chip of the metric it is ranked by is highlighted
  const hl = key === 'rank' ? critActive(P, res)[0] : key;
  const chip = (m, cls, text, title) => `<span class="why ${cls}${m === hl ? ' key' : ''}" title="${esc(title)}">${esc(text)}</span>`;
  const why = [
    res ? chip('counter', sign(p.counter), t('why.counter', { v: fmt(p.counter) }), t('why.counter.title')) : '',
    p.laneN ? chip('lane', sign(p.lane), t('why.lane', { v: fmt(p.lane) }), t('why.lane.title')) : '',
    P && p.meta ? chip('meta', sign(p.metaPts), t('why.meta', { v: fmt(p.metaPts), wr: p.meta.wr.toFixed(1) }), t('why.meta.title', { p: P, wr: p.meta.wr.toFixed(1) }))
      : !P && p.meta && key === 'meta' ? chip('meta', sign(p.meta.delta), t('why.herowr', { wr: p.meta.wr.toFixed(1) }), t('why.herowr.title')) : '',
    p.compPts ? chip('comp', sign(p.compPts), t('why.comp', { v: fmt(p.compPts) }), t('why.comp.title', { m: comp.melee, r: comp.ranged })) : '',
    hl === 'wr' && p.wr != null ? chip('wr', sign(p.wr - 50), t('pick.wr', { wr: p.wr.toFixed(1) }), t('metric.wr')) : '',
    hl === 'safe' && p.safe != null ? chip('safe', sign(p.safe), t('why.safe', { v: fmt(p.safe) }), t('metric.safe.title')) : '',
    p.games ? chip('games', 'plain', t('why.games', { n: compact(p.games) }), P ? t('why.games.title.pos', { p: P }) : t('why.games.title')) : '',
  ].filter(Boolean).join('');
  const v = metricVal(key, p);
  const signed = !['games', 'share', 'wr', 'meta', 'rank'].includes(key);
  const pct = v == null ? 0 : key === 'rank' ? Math.round(v) : key === 'wr' || key === 'meta' && !signed
    ? Math.round(Math.max(0, Math.min(1, ((key === 'wr' ? v : p.meta.wr) - 44) / 12)) * 100)
    : Math.round((Math.abs(v) / max) * 100);
  const neg = v != null && (signed ? v < 0 : key === 'wr' ? v < 50 : key === 'meta' ? p.meta.wr < 50 : false);
  const title = P ? t('pick.title.pos', { p: P }) : t('pick.title');
  const top = state.tab === 'best' && i < 3 && !neg ? ' top' : '';
  return `<div class="pick${top} ${neg ? 'neg-score' : 'pos-score'}" data-pick="${h.key}" title="${esc(title)}" role="button" tabindex="0">
      <div class="pick-art">
        <img class="pick-img" src="${h.img}" alt="" loading="lazy">
        <span class="pick-rank">${i + 1}</span>
      </div>
      <div class="pick-main">
        <div class="pick-name"><span>${esc(h.name)}</span>${atk}</div>
        <div class="pick-sub">${esc(sub)}</div>
        ${why ? `<div class="pick-why">${why}</div>` : ''}
        ${vs ? `<div class="pick-vs">${vs}</div>` : ''}
      </div>
      <div class="pick-score">
        <b class="${metricSign(key, p)}">${metricText(key, p, res)}</b>
        <small>${esc(key === 'total' && r && r.wr != null ? t('pick.wr', { wr: r.wr.toFixed(1) }) : t(key === 'rank' ? 'crit.rating' : 'metric.' + key))}</small>
        <div class="bar"><span style="width:${pct}%"></span></div>
        <span class="pick-add" aria-hidden="true">+ ${esc(t('pick.add'))}</span>
      </div>
    </div>`;
}

function renderSource() {
  $$('#source-switch button').forEach((b) => {
    b.classList.toggle('active', b.dataset.source === state.source);
    b.setAttribute('aria-pressed', b.dataset.source === state.source);
    if (b.dataset.source !== 'opendota') {
      const has = !!state[b.dataset.source];
      b.disabled = !has;
      b.title = has ? '' : t('source.missing');
    }
  });
  const d = curData();
  const info = $('#data-info');
  const dot = $('#data-dot');
  let fresh = true;
  if (d) {
    const when = new Date(stamp(d)).toLocaleString(LANG, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    let txt = t(d.source === 'stratz' ? 'data.stratz' : 'data.dotabuff', { period: periodName(d), when });
    const age = Math.floor(dataAgeDays(d));
    if (age >= STALE_DAYS) { txt += t('data.stale', { n: age }); fresh = false; }
    info.textContent = txt;
  } else {
    info.textContent = state.heroes.length ? t('data.opendota') : t('data.loading');
  }
  dot.classList.toggle('stale', !fresh);
  dot.title = t(fresh ? 'data.fresh' : 'data.old');
}

function renderLang() {
  $$('#lang-switch button').forEach((b) => {
    b.classList.toggle('active', b.dataset.lang === LANG);
    b.setAttribute('aria-pressed', b.dataset.lang === LANG);
  });
}

function setLang(lang) {
  saveLang(lang);
  applyI18n();
  renderLang();
  renderSide();
  renderSource();
  renderAll();
}

let toastTimer;
function toast(msg, action) {
  const el = $('#toast');
  $('.toast-msg', el).textContent = msg;
  const btn = $('.toast-action', el);
  btn.hidden = !action;
  btn.onclick = action ? () => { el.classList.remove('show'); action.fn(); } : null;
  if (action) btn.textContent = action.label;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? 6000 : 2600);
}

/* ===================== events ===================== */

function bind() {
  const search = $('#search');

  search.addEventListener('input', () => { state.query = search.value; renderPool(); });
  search.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      const first = searchMatches()[0];
      if (state.query.trim() && first && add(first, ev.shiftKey || ev.altKey ? 'ally' : ev.ctrlKey || ev.metaKey ? 'ban' : state.mode)) {
        search.value = state.query = '';
        renderPool();
      }
    } else if (ev.key === 'Escape') {
      search.value = state.query = '';
      renderPool();
    } else if (ev.key === 'Backspace' && !search.value) {
      const last = [...state.enemy].reverse().find(Boolean);
      if (last) remove(last);
    }
  });

  // holding Alt = temporary "your team" mode: the grid shows advantages and clicks add allies
  let altPrevMode = null;
  const altUp = () => {
    if (altPrevMode === null) return;
    const prev = altPrevMode;
    altPrevMode = null;
    setMode(prev);
  };
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Alt' || ev.repeat || altPrevMode !== null || document.querySelector('dialog[open]')) return;
    altPrevMode = state.mode;
    if (state.mode !== 'ally') setMode('ally');
  });
  document.addEventListener('keyup', (ev) => {
    if (ev.key !== 'Alt') return;
    ev.preventDefault(); // don't let the browser focus its menu bar
    altUp();
  });
  window.addEventListener('blur', altUp);

  // typing anywhere focuses the search; "?" opens help
  document.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey || document.activeElement === search) return;
    if (document.querySelector('dialog[open]')) return;
    if (ev.key === '?') { ev.preventDefault(); $('#help-dialog').showModal(); return; }
    if (ev.key.length === 1 && /[a-zа-яіїєґ0-9']/i.test(ev.key)) search.focus();
  });

  const pool = $('#pool');
  pool.addEventListener('click', (ev) => {
    const tl = ev.target.closest('.tile');
    if (!tl) return;
    const k = tl.dataset.key;
    if (taken().has(k)) { remove(k); return; }
    add(k, ev.shiftKey ? 'ban' : state.mode);
    search.value = state.query = '';
    renderPool();
  });
  pool.addEventListener('contextmenu', (ev) => {
    const tl = ev.target.closest('.tile');
    if (!tl) return;
    ev.preventDefault();
    add(tl.dataset.key, 'ally');
  });

  $('#draft').addEventListener('click', (ev) => {
    const pb = ev.target.closest('button.pos');
    if (pb) { setPosition(pb.dataset.side, +pb.dataset.i, +pb.dataset.pos); return; }
    const rm = ev.target.closest('[data-remove]');
    if (rm) { remove(rm.dataset.remove); return; }
    const slot = ev.target.closest('.slot.empty');
    if (slot) { setMode(slot.dataset.side); search.focus(); return; }
    const clr = ev.target.closest('[data-clear]');
    if (clr) { clearSide(clr.dataset.clear); return; }
    if (ev.target.closest('[data-swap]')) swapSides();
  });

  $('#jump-builds').addEventListener('click', () => $('#builds').scrollIntoView({ behavior: 'smooth', block: 'start' }));

  $('#pick-mode').addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (b) setMode(b.dataset.mode);
  });

  $('#picks-tab').addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    state.tab = b.dataset.tab;
    state.showAll = false;
    $$('#picks-tab button').forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-pressed', x === b); });
    renderPicks();
    $('#picks-scroll').scrollTop = 0;
  });

  $('#pos-filter').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-pickpos]');
    if (!b) return;
    state.pickPos = +b.dataset.pickpos;
    state.showAll = false;
    renderPool();
    renderPicks();
  });

  const optsChangedNow = () => {
    saveOpts();
    state.showAll = false;
    renderPicks();
    renderPool();
  };
  // ---- enemy priority: toggle, strength, drag and drop (pointer events: mouse and touch) ----
  const prio = $('#prio');
  prio.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-prio-toggle]')) {
      state.prio.on = !state.prio.on;
    } else {
      const b = ev.target.closest('[data-prio-strength]');
      if (!b || b.dataset.prioStrength === state.prio.strength) return;
      state.prio.strength = b.dataset.prioStrength;
    }
    savePrio();
    prioChanged();
  });
  sortable(prio, '.prio-card', {
    start: (key) => {
      prioDrag = key;
      if (!state.prio.on) { state.prio.on = true; savePrio(); } // dragging turns priority on
      renderPrio();
    },
    move: (key, to) => { if (moveEnemyPrio(key, to)) renderPrio(); },
    end: () => { prioDrag = null; prioChanged(); },
    step: (key, d) => {
      if (!state.prio.on) { state.prio.on = true; savePrio(); }
      moveEnemyPrio(key, prioOrder().indexOf(key) + d);
      prioChanged();
    },
  });

  // ---- criteria order: the same drag and drop over the criteria chips ----
  const crit = $('#crit');
  sortable(crit, '.crit-chip', {
    start: (key) => { critDrag = key; renderCrit(); },
    move: (key, to) => { if (moveInList(state.opts.critOrder, key, to)) renderCrit(); },
    end: () => { critDrag = null; saveOpts(); renderCrit(); renderPicksList(); renderPool(); },
    step: (key, d) => {
      moveInList(state.opts.critOrder, key, state.opts.critOrder.indexOf(key) + d);
      saveOpts(); renderCrit(); renderPicksList(); renderPool();
    },
  });

  $('#btn-opts').addEventListener('click', () => {
    state.optsOpen = !state.optsOpen;
    store.set('dbcp_opts_open', state.optsOpen);
    renderPresets();
    renderOpts();
  });
  $('#presets').addEventListener('click', (ev) => {
    if (ev.target.closest('[data-crit-toggle]')) {
      state.opts.critOn = !state.opts.critOn;
      optsChangedNow();
      return;
    }
    const b = ev.target.closest('[data-preset]');
    if (!b) return;
    applyPreset(b.dataset.preset);
    optsChangedNow();
  });
  const opts = $('#opts');
  opts.addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b || b.disabled) return;
    const o = state.opts;
    if (b.dataset.opt) {
      const cur = o[b.dataset.opt];
      o[b.dataset.opt] = typeof OPT_DEFAULTS[b.dataset.opt] === 'number' ? +b.dataset.v : b.dataset.v;
      if (b.dataset.opt === 'sort' && o.then === o.sort) o.then = '';
      if (['sort', 'then', 'topN'].includes(b.dataset.opt)) o.critOn = false; // picking a sort here leaves "your own order"
      if (cur === o[b.dataset.opt]) return;
    } else if (b.dataset.toggle) {
      o[b.dataset.toggle] = !o[b.dataset.toggle];
    } else if (b.dataset.role) {
      if (state.roles.has(b.dataset.role)) state.roles.delete(b.dataset.role); else state.roles.add(b.dataset.role);
    } else if (b.dataset.attr) {
      state.attr = state.attr === b.dataset.attr ? null : b.dataset.attr;
    } else if ('reset' in b.dataset) {
      state.opts = { ...OPT_DEFAULTS, w: { ...OPT_DEFAULTS.w }, critOrder: [...OPT_DEFAULTS.critOrder] };
      state.roles.clear();
      state.attr = null;
    } else return;
    optsChangedNow();
  });
  // weight sliders: update the list live without re-rendering the panel (the slider keeps its drag)
  opts.addEventListener('input', (ev) => {
    const k = ev.target.dataset.w;
    if (!k) return;
    state.opts.w[k] = +ev.target.value;
    ev.target.nextElementSibling.textContent = '×' + state.opts.w[k].toFixed(2);
    saveOpts();
    renderPresets();
    renderPicksList();
    renderPool();
    const reset = $('[data-reset]', opts);
    if (reset) reset.disabled = !optsChanged();
  });

  const pickHero = (key) => {
    const P = targetPos();
    if (add(key, 'ally')) {
      if (P) setPosition('ally', state.ally.indexOf(key), P);
      toast(P ? t('toast.added.pos', { name: hero(key).name, p: P }) : t('toast.added', { name: hero(key).name }));
    }
  };
  $('#picks-body').addEventListener('click', (ev) => {
    if (ev.target.id === 'show-all') { state.showAll = true; renderPicks(); return; }
    const p = ev.target.closest('[data-pick]');
    if (p) pickHero(p.dataset.pick);
  });
  $('#picks-body').addEventListener('keydown', (ev) => {
    const p = ev.target.closest('[data-pick]');
    if (p && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); pickHero(p.dataset.pick); }
  });

  $('#source-switch').addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b || b.disabled) return;
    setSource(b.dataset.source);
  });

  $('#lang-switch').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-lang]');
    if (b && b.dataset.lang !== LANG) setLang(b.dataset.lang);
  });

  $('#btn-reset').addEventListener('click', () => {
    resetAll();
    search.value = state.query = '';
  });

  $('#btn-share').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); toast(t('toast.copied')); } catch { toast(location.href); }
  });

  $('#btn-help').addEventListener('click', () => $('#help-dialog').showModal());

  // close dialogs by clicking the backdrop
  $$('dialog').forEach((dlg) => dlg.addEventListener('click', (ev) => { if (ev.target === dlg) dlg.close(); }));

  // ---- manual data update ----
  const dlg = $('#update-dialog');
  $('#btn-update').addEventListener('click', () => dlg.showModal());
  $('#btn-copy-script').addEventListener('click', async () => {
    const src = typeof dbcpScrape === 'function' ? `(${dbcpScrape.toString()})();` : null;
    if (!src) { toast(t('toast.script.missing')); return; }
    try { await navigator.clipboard.writeText(src); toast(t('toast.script.copied')); } catch { toast(t('toast.script.fail')); }
  });
  $('#btn-forget').addEventListener('click', () => {
    store.del('dbcp_data');
    state.dotabuff = pickDotabuffData();
    setSource(state.dotabuff ? state.source : 'opendota');
    toast(t('toast.forget'));
  });

  const drop = $('#drop-zone');
  const importFile = async (file) => {
    try {
      const data = parseDataFile(await file.text());
      state.dotabuff = data;
      if (!store.set('dbcp_data', data)) toast(t('toast.import.nostore'));
      ensureHeroesFromDotabuff();
      setSource('dotabuff');
      dlg.close();
      toast(t('toast.import.ok', { d: data.updated }));
    } catch (e) {
      toast(t('toast.import.err', { e: e.message }));
    }
  };
  $('#file-input').addEventListener('change', (ev) => ev.target.files[0] && importFile(ev.target.files[0]));
  for (const el of [drop, document.body]) {
    el.addEventListener('dragover', (ev) => { ev.preventDefault(); drop.classList.add('over'); });
    el.addEventListener('dragleave', () => drop.classList.remove('over'));
    el.addEventListener('drop', (ev) => {
      ev.preventDefault();
      drop.classList.remove('over');
      const f = ev.dataTransfer.files[0];
      if (f) importFile(f);
    });
  }

  // mobile bottom navigation: highlight the section in view
  const navLinks = $$('.bottom-nav a');
  if ('IntersectionObserver' in window && navLinks.length) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) navLinks.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + en.target.id));
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    ['draft', 'picks', 'heroes', 'builds'].forEach((id) => { const el = document.getElementById(id); if (el) io.observe(el); });
  }
  navLinks.forEach((a) => a.addEventListener('click', (ev) => {
    const target = document.querySelector(a.getAttribute('href'));
    if (!target) return;
    ev.preventDefault();
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
}

function setMode(mode) {
  const changedMode = state.mode !== mode;
  state.mode = mode;
  $$('#pick-mode button').forEach((b) => { b.classList.toggle('active', b.dataset.mode === mode); b.setAttribute('aria-pressed', b.dataset.mode === mode); });
  if (changedMode && state.heroes.length) renderPool();
}

function setSource(src) {
  shareCache.clear(); // the data may have changed (import)
  state.source = src;
  store.set('dbcp_source', src);
  renderSource();
  calculate();
}

// heroes missing in OpenDota (or OpenDota is down) are taken from data.js
function ensureHeroesFromDotabuff() {
  const d = state.dotabuff;
  if (!d) return;
  const haveMeta = state.heroes.some((h) => h.id);
  for (const [key, h] of Object.entries(d.heroes)) {
    if (state.byKey.has(key)) continue;
    if (haveMeta) { console.warn('[Skalse] Dotabuff hero not found in OpenDota:', h.name, key); continue; }
    const entry = { key, id: null, name: h.name, attr: 'all', roles: [], atk: null, img: h.img || '', icon: h.img || '', wr: 50 };
    state.heroes.push(entry);
    state.byKey.set(key, entry);
  }
}

/* ===================== start ===================== */

async function init() {
  state.opts = loadOpts();
  state.optsOpen = !!store.get('dbcp_opts_open');
  state.side = store.get('dbcp_side') === 'radiant' ? 'radiant' : 'dire';
  const prio = store.get('dbcp_prio') || {};
  state.prio.on = !!prio.on;
  if (PRIO_STRENGTH[prio.strength]) state.prio.strength = prio.strength;
  applyI18n();
  renderLang();
  renderSide();
  bind();
  renderPicksSkeleton();
  const [meta] = await Promise.allSettled([loadHeroMeta(), loadDataScript('data.js'), loadDataScript('stratz.js')]);
  state.dotabuff = pickDotabuffData();
  state.stratz = window.DBCP_STRATZ && window.DBCP_STRATZ.m ? window.DBCP_STRATZ : null;

  try {
    if (meta.status === 'rejected') throw meta.reason;
    state.heroes = meta.value;
  } catch (e) {
    if (!state.dotabuff) {
      $('#pool').innerHTML = `<div class="empty-state"><h3>${esc(t('nodata.title'))}</h3>
        <p>${esc(t('nodata.p1', { e: e.message }))}</p><p>${esc(t('nodata.p2'))}</p></div>`;
      $('#picks-body').innerHTML = '';
      $('#data-info').textContent = t('data.none');
      return;
    }
    toast(t('toast.od.down'));
  }
  state.byKey = new Map(state.heroes.map((h) => [h.key, h]));
  ensureHeroesFromDotabuff();

  // source: the saved choice if its data is there and fresh, else Stratz → Dotabuff → OpenDota live
  const haveOd = state.heroes.some((h) => h.id);
  const fresh = (src) => state[src] && dataAgeDays(state[src]) < STALE_DAYS;
  const saved = store.get('dbcp_source');
  const order = ['stratz', 'dotabuff'];
  if (saved === 'opendota' && haveOd) state.source = 'opendota';
  else if (order.includes(saved) && fresh(saved)) state.source = saved;
  else state.source = order.find(fresh) || (haveOd ? 'opendota' : order.find((s) => state[s]) || 'opendota');
  if (saved && saved !== state.source && order.includes(saved) && state[saved]) toast(t('toast.od.stale'));

  readHash();
  renderSide();
  autoAssign('ally');
  autoAssign('enemy');
  if (!state.enemy.includes(null)) setMode('ally'); // a shared link with a full enemy team
  renderSource();
  await calculate();
  if (matchMedia('(min-width: 1101px)').matches) $('#search').focus({ preventScroll: true });
}

init();
