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
  sort: 'score',     // with a position: 'score' (counter-pick + meta) | 'share' (% of the hero's games on it)
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
const LANE_WEIGHT = 1.5;    // your lane opponent weighs more

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
const META_WEIGHT = 0.5; // counter-picks matter more: meta adds ±2–3% at most, counters vs five heroes up to ±10%
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

function enemyWeight(ek, P) {
  if (!P) return 1;
  const ep = state.enemyPos[state.enemy.indexOf(ek)];
  return ep && LANE_FOES[P].includes(ep) ? LANE_WEIGHT : 1;
}

function scoreFor(key, P) {
  const r = state.results && state.results.get(key);
  if (!r) return 0;
  return r.vs.reduce((s, v) => s + (v.adv == null ? 0 : v.adv * enemyWeight(v.key, P)), 0);
}

function totalScore(key, P) {
  const m = posMeta(key, P);
  return scoreFor(key, P) + (m ? META_WEIGHT * m.delta : 0);
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
}

/* ===================== rendering ===================== */

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

function renderRoleFilter() {
  const chips = ROLE_KEYS.map((k) =>
    `<button class="chip ${state.roles.has(k) ? 'active' : ''}" data-role="${k}" aria-pressed="${state.roles.has(k)}">${esc(t('role.' + k))}</button>`);
  const attrs = ATTRS.map((a) =>
    `<button class="chip ${state.attr === a.k ? 'active' : ''}" data-attr="${a.k}" aria-pressed="${state.attr === a.k}"><span class="dot" style="background:${a.color}"></span>${esc(t('attr.' + a.k))}</button>`);
  $('#role-filter').innerHTML = chips.join('') + attrs.join('');
}

function renderPosFilter() {
  const btn = (v, label, title) =>
    `<button class="${state.pickPos === v ? 'active' : ''}" data-pickpos="${v}" title="${esc(title)}" aria-pressed="${state.pickPos === v}">${label}</button>`;
  $('#pos-filter').innerHTML =
    `<span class="pos-label">${esc(t('picks.for'))}</span><div class="seg small">` +
    btn(0, esc(t('picks.any')), t('picks.any.title')) +
    [1, 2, 3, 4, 5].map((p) => btn(p, `<b>${p}</b> ${esc(posName(p))}`, t('picks.pos.title', { p }))).join('') +
    '</div>' +
    (state.pickPos ? `<span class="pos-label">${esc(t('sort.label'))}</span><div class="seg small">` +
      ['score', 'share'].map((s) => `<button class="${state.sort === s ? 'active' : ''}" data-sort="${s}" aria-pressed="${state.sort === s}">${esc(t('sort.' + s))}</button>`).join('') +
      '</div>' : '');
}

function renderPicksSkeleton() {
  $('#picks-body').innerHTML = Array.from({ length: 8 }, () =>
    '<div class="pick skeleton"><span></span><div class="sk sk-img"></div><div><div class="sk sk-line"></div><div class="sk sk-line short"></div></div><div class="sk sk-score"></div></div>').join('');
}

function renderPicks() {
  renderPosFilter();
  renderRoleFilter();
  const body = $('#picks-body');
  const res = state.results;
  const P = targetPos();
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
  let list = state.heroes.filter((h) => !busy.has(h.key));
  if (P) list = list.filter((h) => posShares(h.key)[P] >= MIN_POS_SHARE);
  if (state.roles.size) list = list.filter((h) => [...state.roles].every((r) => h.roles.includes(r)));
  if (state.attr) list = list.filter((h) => h.attr === state.attr);
  // score = counter-pick (when enemies are picked) + position meta (when a position is chosen)
  const parts = new Map(list.map((h) => {
    const counter = res ? scoreFor(h.key, P) : 0;
    const meta = posMeta(h.key, P);
    const metaPts = meta ? META_WEIGHT * meta.delta : 0;
    return [h.key, { counter, meta, metaPts, total: counter + metaPts }];
  }));
  const sortKey = (h) => (P && state.sort === 'share' ? posShares(h.key)[P] : parts.get(h.key).total);
  list.sort((a, b) => (state.tab === 'best' ? 1 : -1) * (sortKey(b) - sortKey(a)) || parts.get(b.key).total - parts.get(a.key).total);

  const limit = state.showAll ? list.length : 25;
  const max = Math.max(1, ...list.map((h) => Math.abs(parts.get(h.key).total)));

  if (!list.length) {
    body.innerHTML = `<div class="empty-state"><p>${esc(t('picks.none'))}</p></div>`;
    return;
  }

  const head = !res
    ? `<div class="picks-note">${esc(t('note.meta', { p: P, role: posName(P) }))}</div>`
    : P ? `<div class="picks-note">${esc(t('note.pos', { p: P, w: META_WEIGHT }))}</div>` : '';

  patchHTML(body, head + list.slice(0, limit).map((h, i) => {
    const r = res && res.get(h.key);
    const p = parts.get(h.key);
    const s = p.total;
    const sub = P ? t('pick.share', { p: P, s: Math.round(posShares(h.key)[P] * 100) }) : h.roles.slice(0, 3).map((x) => t('role.' + x)).join(' · ');
    const vs = r ? r.vs.map((v) => {
      const e = hero(v.key);
      const lane = enemyWeight(v.key, P) > 1;
      const title = v.adv === null ? t('vs.nodata', { name: e.name })
        : `${e.name}: ${fmt(v.adv)}%` + (v.wr != null ? t('vs.wr', { wr: v.wr.toFixed(1) }) : '') +
          (v.games ? t('vs.games', { n: v.games.toLocaleString(LANG) }) : '') + (lane ? t('vs.lane') : '');
      return `<span class="vs ${lane ? 'lane' : ''}" title="${esc(title)}"><img src="${e.icon || e.img}" alt=""><span class="${v.adv === null ? 'flat' : sign(v.adv)}">${v.adv === null ? '—' : fmt(v.adv)}</span></span>`;
    }).join('') : '';
    // why the hero is here: counter-pick and meta separately
    // (only with a position — otherwise the big number on the right already is the counter-pick)
    const why = !P ? '' : [
      res ? `<span class="why ${sign(p.counter)}" title="${esc(t('why.counter.title'))}">${esc(t('why.counter', { v: fmt(p.counter) }))}</span>` : '',
      p.meta ? `<span class="why ${sign(p.metaPts)}" title="${esc(t('why.meta.title', { p: P, wr: p.meta.wr.toFixed(1) }))}">${esc(t('why.meta', { v: fmt(p.metaPts), wr: p.meta.wr.toFixed(1) }))}</span>` : '',
    ].filter(Boolean).join('');
    const pct = Math.round((Math.abs(s) / max) * 100);
    const color = s >= 0 ? 'var(--good)' : 'var(--bad)';
    const title = P ? t('pick.title.pos', { p: P }) : t('pick.title');
    return `<div class="pick" data-pick="${h.key}" title="${esc(title)}" role="button" tabindex="0">
      <span class="pick-rank">${i + 1}</span>
      <img class="pick-img" src="${h.img}" alt="" loading="lazy">
      <div class="pick-main">
        <div class="pick-name">${esc(h.name)}<small>${esc(sub)}</small></div>
        ${why ? `<div class="pick-why">${why}</div>` : ''}
        ${vs ? `<div class="pick-vs">${vs}</div>` : ''}
      </div>
      <div class="pick-score">
        <b class="${sign(s)}">${fmt(s)}${res ? '%' : ''}</b>
        <small>${r && r.wr != null ? esc(t('pick.wr', { wr: r.wr.toFixed(1) })) : ''}</small>
        <div class="bar"><span style="width:${pct}%;background:${color}"></span></div>
      </div>
      <span class="pick-add" aria-hidden="true">+ ${esc(t('pick.add'))}</span>
    </div>`;
  }).join('') + (list.length > limit
    ? `<button class="btn ghost more" id="show-all">${esc(t('showall', { n: list.length }))}</button>` : ''));
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
    if (clr) clearSide(clr.dataset.clear);
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
    $('#picks-body').scrollTop = 0;
  });

  $('#pos-filter').addEventListener('click', (ev) => {
    const s = ev.target.closest('[data-sort]');
    if (s) { state.sort = s.dataset.sort; state.showAll = false; renderPicks(); return; }
    const b = ev.target.closest('[data-pickpos]');
    if (!b) return;
    state.pickPos = +b.dataset.pickpos;
    state.showAll = false;
    renderPool();
    renderPicks();
  });

  $('#role-filter').addEventListener('click', (ev) => {
    const b = ev.target.closest('.chip');
    if (!b) return;
    if (b.dataset.role) {
      if (state.roles.has(b.dataset.role)) state.roles.delete(b.dataset.role); else state.roles.add(b.dataset.role);
    } else {
      state.attr = state.attr === b.dataset.attr ? null : b.dataset.attr;
    }
    renderPicks();
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
    const entry = { key, id: null, name: h.name, attr: 'all', roles: [], img: h.img || '', icon: h.img || '', wr: 50 };
    state.heroes.push(entry);
    state.byKey.set(key, entry);
  }
}

/* ===================== start ===================== */

async function init() {
  applyI18n();
  renderLang();
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
  autoAssign('ally');
  autoAssign('enemy');
  if (!state.enemy.includes(null)) setMode('ally'); // a shared link with a full enemy team
  renderSource();
  await calculate();
  if (matchMedia('(min-width: 1101px)').matches) $('#search').focus({ preventScroll: true });
}

init();
