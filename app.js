'use strict';

const CDN = 'https://cdn.cloudflare.steamstatic.com';
const OD_API = 'https://api.opendota.com/api';
const DAY = 864e5;
const STALE_DAYS = 3; // старше — автоматически переключаемся на OpenDota live

const ATTRS = [
  { k: 'str', name: 'Сила', color: 'var(--str)' },
  { k: 'agi', name: 'Ловкость', color: 'var(--agi)' },
  { k: 'int', name: 'Интеллект', color: 'var(--int)' },
  { k: 'all', name: 'Универсальные', color: 'var(--all)' },
];

const ROLES = {
  Carry: 'Керри', Support: 'Саппорт', Nuker: 'Нюкер', Disabler: 'Контроль',
  Initiator: 'Инициатор', Durable: 'Танк', Escape: 'Мобильность', Pusher: 'Пуш',
};

// сокращения и старые имена для поиска (ключ — нормализованное имя)
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

// нормализация имени: «Nature's Prophet» → naturesprophet, плюс старые названия
const NAME_FIX = { outworlddevourer: 'outworlddestroyer', skeletonking: 'wraithking', windrunner: 'windranger' };
const norm = (s) => {
  const k = String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  return NAME_FIX[k] || k;
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v) => (v > 0 ? '+' : '') + v.toFixed(2);
const sign = (v) => (v > 0.05 ? 'pos' : v < -0.05 ? 'neg' : 'zero');

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
    if (hit) return hit.v; // офлайн — используем устаревший кэш
    throw e;
  }
}

/* ===================== состояние ===================== */

const state = {
  heroes: [],        // [{key, id, name, attr, roles, img, wr}]
  byKey: new Map(),
  dotabuff: null,    // window.DBCP_DATA или импорт
  source: 'opendota',
  enemy: [null, null, null, null, null],
  ally: [null, null, null, null, null],
  enemyPos: [null, null, null, null, null],     // позиции 1–5
  allyPos: [null, null, null, null, null],
  enemyManual: [false, false, false, false, false], // позицию задал пользователь
  allyManual: [false, false, false, false, false],
  pickPos: 0,        // для какой позиции подбираем героя: 0 (любая — чистый контрпик) | 1–5
  ban: [],
  mode: 'enemy',
  tab: 'best',
  roles: new Set(),
  attr: null,
  query: '',
  showAll: false,
  results: null,     // Map key -> {score, wr, vs:[...]}
  odMatchups: new Map(),
};

const hero = (k) => state.byKey.get(k);
const taken = () => new Set([...state.enemy, ...state.ally, ...state.ban].filter(Boolean));

/* ===================== данные ===================== */

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

// data.js грузим сами и в обход кэша — каждый заход получает последние данные с сервера
function loadDataScript() {
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = location.protocol.startsWith('http') ? 'data.js?v=' + Date.now() : 'data.js';
    s.onload = s.onerror = () => resolve();
    document.head.appendChild(s);
  });
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
  if (p.startsWith('patch_')) return 'патч ' + p.slice(6);
  return { week: 'последняя неделя', month: 'последний месяц', '3month': '3 месяца' }[p] || d.periodLabel || 'все матчи';
}

function parseDataFile(text) {
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  const data = JSON.parse(json);
  if (!data || !data.m || !data.heroes) throw new Error('Неверный формат файла');
  return data;
}

// OpenDota: матчапы врага против всех героев → преимущество кандидата.
// Выборка маленькая (матчи высокого уровня), поэтому сглаживаем к нулю.
async function odMatchupsFor(enemyKey) {
  if (state.odMatchups.has(enemyKey)) return state.odMatchups.get(enemyKey);
  const e = hero(enemyKey);
  const rows = await cachedJson(`${OD_API}/heroes/${e.id}/matchups`, DAY);
  const byId = new Map(state.heroes.map((h) => [h.id, h]));
  const logit = (p) => Math.log(p / (1 - p));
  // винрейт врага в самой выборке — базовая линия, чтобы не смешивать пабы и high-level
  let wins = 0, games = 0;
  for (const r of rows) { wins += r.wins; games += r.games_played; }
  const enemyWr = games ? Math.min(0.9, Math.max(0.1, wins / games)) : e.wr / 100;
  const out = {};
  for (const r of rows) {
    const c = byId.get(r.hero_id);
    if (!c || !r.games_played) continue;
    const candWr = 1 - r.wins / r.games_played;
    const expected = 1 / (1 + Math.exp(-(logit(c.wr / 100) - logit(enemyWr))));
    // байесовское сглаживание: шум ~50/√n %, реальный эффект матчапа ~±3%
    const shrink = r.games_played / (r.games_played + 250);
    out[c.key] = [(candWr - expected) * 100 * shrink, candWr * 100, r.games_played];
  }
  state.odMatchups.set(enemyKey, out);
  return out;
}

async function matchupsFor(enemyKey) {
  if (state.source === 'dotabuff' && state.dotabuff) return state.dotabuff.m[enemyKey] || {};
  return odMatchupsFor(enemyKey);
}

let calcToken = 0;
async function calculate() {
  const enemies = state.enemy.filter(Boolean);
  const token = ++calcToken;
  if (!enemies.length) { state.results = null; renderAll(); return; }

  let tables;
  try {
    tables = await Promise.all(enemies.map(matchupsFor));
  } catch (e) {
    toast('Не удалось загрузить матчапы: ' + e.message);
    return;
  }
  if (token !== calcToken) return;

  const results = new Map();
  for (const h of state.heroes) {
    let score = 0, wrSum = 0, wrN = 0;
    const vs = enemies.map((ek, i) => {
      const row = tables[i][h.key];
      if (!row) return { key: ek, adv: null };
      score += row[0];
      wrSum += row[1]; wrN++;
      return { key: ek, adv: row[0], wr: row[1], games: row[2] };
    });
    results.set(h.key, { score, wr: wrN ? wrSum / wrN : null, vs });
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

/* ===================== позиции ===================== */

const MIN_POS_SHARE = 0.1;  // герой «играет» позицию, если ≥10% его игр на ней
const LANE_WEIGHT = 1.5;    // враг на твоей линии весит больше

// Доли игр героя по позициям: линии Dotabuff + GPM (на одной линии кор фармит заметно больше саппорта)
const shareCache = new Map();
function posShares(key) {
  if (shareCache.has(key)) return shareCache.get(key);
  const s = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const lanes = state.dotabuff && state.dotabuff.lanes && state.dotabuff.lanes[key];
  if (lanes) {
    for (const [lane, [presence, , gpm]] of Object.entries(lanes)) {
      if (lane === 'safe') s[gpm >= 430 ? 1 : 5] += presence;
      else if (lane === 'mid') s[2] += presence;
      else if (lane === 'off') s[gpm >= 420 ? 3 : 4] += presence;
      else if (lane === 'roaming') s[4] += presence;
    }
  } else {
    // без данных Dotabuff — грубо по ролям OpenDota
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

// Раскладываем героев команды по позициям: заданные вручную остаются,
// остальные — самая вероятная расстановка (перебор, максимум 5! вариантов).
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
  if (other !== -1) manual[other] = false; // освобождаем — его переразложит autoAssign
  pos[i] = p;
  manual[i] = true;
  changed();
}

// Для какой позиции сейчас подбираем (null — любая, чистый контрпик)
function targetPos() {
  return state.pickPos || null;
}

// Мета позиции: винрейт героя на линии этой позиции в текущем патче (Dotabuff)
const META_WEIGHT = 0.5; // контрпик важнее: мета даёт максимум ±2–3%, контрпик против пятёрки — до ±10%
function posMeta(key, P) {
  if (!P) return null;
  const lanes = state.dotabuff && state.dotabuff.lanes && state.dotabuff.lanes[key];
  const lane = { 1: 'safe', 5: 'safe', 2: 'mid', 3: 'off', 4: 'off' }[P];
  let row = lanes && lanes[lane];
  if (P === 4 && lanes && lanes.roaming && (!row || lanes.roaming[0] > row[0])) row = lanes.roaming;
  if (!row) return null;
  // редкие офф-пики на позиции (Lycan мид и т. п.) играют в основном спецы — их винрейт завышен,
  // поэтому вес меты растёт с долей игр героя на этой позиции (полный — от 40%)
  const conf = Math.min(1, posShares(key)[P] / 0.4);
  return { wr: row[1], delta: (row[1] - 50) * conf, conf };
}

function totalScore(key, P) {
  const m = posMeta(key, P);
  return scoreFor(key, P) + (m ? META_WEIGHT * m.delta : 0);
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

/* ===================== действия ===================== */

function add(key, side = state.mode) {
  if (!key || !hero(key) || taken().has(key)) return false;
  if (side === 'ban') {
    state.ban.push(key);
  } else {
    const arr = state[side];
    const i = arr.indexOf(null);
    if (i === -1) { toast(side === 'enemy' ? 'Все 5 врагов уже выбраны' : 'Ваша команда уже собрана'); return false; }
    arr[i] = key;
  }
  changed();
  return true;
}

function remove(key) {
  for (const side of ['enemy', 'ally']) {
    const i = state[side].indexOf(key);
    if (i !== -1) { state[side][i] = null; state[side + 'Manual'][i] = false; }
  }
  state.ban = state.ban.filter((k) => k !== key);
  changed();
}

function clearSide(side) {
  if (side === 'ban') state.ban = [];
  else {
    state[side] = [null, null, null, null, null];
    state[side + 'Manual'] = [false, false, false, false, false];
  }
  changed();
}

function changed() {
  autoAssign('ally');
  autoAssign('enemy');
  writeHash();
  renderSlots();
  renderPool();
  calculate();
}

/* ===================== поиск ===================== */

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
  // герой.позиция — позиция пишется, только если её задали вручную
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
    // старый формат DotaBuffCP: #Anti-Mage/Axe/...
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

/* ===================== рендер ===================== */

function renderSlots() {
  for (const side of ['enemy', 'ally']) {
    $('#slots-' + side).innerHTML = state[side].map((k, i) => {
      if (!k) return `<div class="slot-wrap"><div class="slot empty" data-side="${side}" data-i="${i}" title="Добавлять сюда по клику"></div></div>`;
      const h = hero(k);
      const cur = state[side + 'Pos'][i];
      const manual = state[side + 'Manual'][i];
      const sh = posShares(k);
      const pos = [1, 2, 3, 4, 5].map((p) =>
        `<button class="pos ${p === cur ? 'active' : ''} ${p === cur && !manual ? 'auto' : ''}" data-side="${side}" data-i="${i}" data-pos="${p}"
          title="Позиция ${p} · ${POS_NAMES[p]} · ${Math.round(sh[p] * 100)}% игр героя${p === cur && !manual ? ' (определено автоматически)' : ''}">${p}</button>`).join('');
      return `<div class="slot-wrap">
        <div class="slot filled" data-remove="${k}" title="Убрать ${esc(h.name)}">
          <img src="${h.img}" alt="" loading="lazy"><span class="slot-name">${esc(h.name)}</span><span class="slot-x">×</span></div>
        <div class="pos-pick">${pos}</div>
      </div>`;
    }).join('');
  }
  $('#slots-ban').innerHTML = state.ban.length
    ? state.ban.map((k) => `<div class="ban" data-remove="${k}" title="Разбанить ${esc(hero(k).name)}"><img src="${hero(k).img}" alt=""></div>`).join('')
    : '<span class="empty-note">Нет банов — забаненные герои не попадут в рекомендации.</span>';
}

function renderPool() {
  const q = state.query.trim();
  const matches = q ? new Set(searchMatches()) : null;
  const first = q ? searchMatches()[0] : null;
  const res = state.results;

  $('#pool').innerHTML = ATTRS.map((a) => {
    const list = state.heroes.filter((h) => h.attr === a.k).sort((x, y) => x.name.localeCompare(y.name));
    if (!list.length) return '';
    return `<div class="attr-group">
      <div class="attr-title"><i style="background:${a.color}"></i>${a.name}</div>
      <div class="tiles">${list.map((h) => tile(h, matches, first, res)).join('')}</div>
    </div>`;
  }).join('');
}

function tile(h, matches, first, res) {
  const cls = ['tile'];
  let badge = '';
  if (state.enemy.includes(h.key)) cls.push('taken-enemy');
  else if (state.ally.includes(h.key)) cls.push('taken-ally');
  else if (state.ban.includes(h.key)) cls.push('taken');
  else if (res) {
    const P = targetPos();
    const s = totalScore(h.key, P);
    const n = state.enemy.filter(Boolean).length;
    if (s >= 1.5 * n) cls.push('great'); else if (s >= 0.6 * n) cls.push('good'); else if (s <= -0.6 * n) cls.push('bad');
    if (P && posShares(h.key)[P] < MIN_POS_SHARE) cls.push('offpos');
    badge = `<span class="tile-score ${sign(s)}">${fmt(s)}</span>`;
  }
  if (matches) cls.push(matches.has(h.key) ? 'match' : 'dim');
  if (h.key === first) cls.push('first');
  return `<div class="${cls.join(' ')}" data-key="${h.key}" title="${esc(h.name)}">
    <img src="${h.img}" alt="" loading="lazy">${badge}<span class="tile-name">${esc(h.name)}</span></div>`;
}

function renderRoleFilter() {
  const chips = Object.entries(ROLES).map(([k, n]) =>
    `<button class="chip ${state.roles.has(k) ? 'active' : ''}" data-role="${k}">${n}</button>`);
  const attrs = ATTRS.map((a) =>
    `<button class="chip ${state.attr === a.k ? 'active' : ''}" data-attr="${a.k}"><span class="dot" style="background:${a.color}"></span>${a.name}</button>`);
  $('#role-filter').innerHTML = chips.join('') + attrs.join('');
}

function renderPosFilter() {
  const btn = (v, label, title) =>
    `<button class="${state.pickPos === v ? 'active' : ''}" data-pickpos="${v}" title="${esc(title)}">${label}</button>`;
  $('#pos-filter').innerHTML =
    `<span class="pos-label">Пикаю на</span><div class="seg small">` +
    btn(0, 'Любая', 'Чистый контрпик, без учёта позиции') +
    [1, 2, 3, 4, 5].map((p) => btn(p, `${p} · ${POS_NAMES[p]}`, `Только герои позиции ${p}: контрпик + мета позиции`)).join('') +
    '</div>';
}

function renderPicks() {
  renderPosFilter();
  renderRoleFilter();
  const body = $('#picks-body');
  const res = state.results;
  const P = targetPos();
  if (!res && !P) {
    body.innerHTML = `<div class="empty-state">
      <h3>Выберите героев противника</h3>
      <p>Кликните по портрету или начните печатать имя — <kbd>Enter</kbd> добавит первого найденного.</p>
      <p>Сокращения работают: <code>am</code>, <code>qop</code>, <code>sf</code>, <code>wk</code>…</p>
      <p>Выберите позицию выше («Пикаю на») — увидите мету этой позиции ещё до пика врагов.</p>
    </div>`;
    return;
  }

  const busy = taken();
  let list = state.heroes.filter((h) => !busy.has(h.key));
  if (P) list = list.filter((h) => posShares(h.key)[P] >= MIN_POS_SHARE);
  if (state.roles.size) list = list.filter((h) => [...state.roles].every((r) => h.roles.includes(r)));
  if (state.attr) list = list.filter((h) => h.attr === state.attr);
  // итог = контрпик (если враги выбраны) + мета позиции (если позиция выбрана)
  const parts = new Map(list.map((h) => {
    const counter = res ? scoreFor(h.key, P) : 0;
    const meta = posMeta(h.key, P);
    const metaPts = meta ? META_WEIGHT * meta.delta : 0;
    return [h.key, { counter, meta, metaPts, total: counter + metaPts }];
  }));
  list.sort((a, b) => (state.tab === 'best' ? 1 : -1) * (parts.get(b.key).total - parts.get(a.key).total));

  const limit = state.showAll ? list.length : 25;
  const max = Math.max(1, ...list.map((h) => Math.abs(parts.get(h.key).total)));

  if (!list.length) {
    body.innerHTML = '<div class="empty-state"><p>Нет героев под выбранные фильтры.</p></div>';
    return;
  }

  const head = !res
    ? `<div class="picks-note">Мета позиции ${P} (${POS_NAMES[P]}) в текущем патче — винрейт героев на этой позиции. Добавьте врагов, чтобы учесть контрпик.</div>`
    : P ? `<div class="picks-note">Позиция ${P}: только герои, которые её играют. Итог = контрпик + мета позиции (вес меты ×${META_WEIGHT} — контрпик важнее).</div>`
    : '';

  body.innerHTML = head + list.slice(0, limit).map((h, i) => {
    const r = res && res.get(h.key);
    const p = parts.get(h.key);
    const s = p.total;
    const sub = P ? `поз. ${P}: ${Math.round(posShares(h.key)[P] * 100)}% игр героя` : h.roles.slice(0, 3).map((x) => ROLES[x] || x).join(' · ');
    const vs = r ? r.vs.map((v) => {
      const e = hero(v.key);
      const lane = enemyWeight(v.key, P) > 1;
      const title = v.adv === null ? `${e.name}: нет данных`
        : `${e.name}: ${fmt(v.adv)}%` + (v.wr != null ? `, винрейт ${v.wr.toFixed(1)}%` : '') + (v.games ? `, ${v.games.toLocaleString('ru')} матчей` : '') +
          (lane ? ' · стоит против вас на линии (×1.5)' : '');
      return `<span class="vs ${lane ? 'lane' : ''}" title="${esc(title)}"><img src="${e.icon || e.img}" alt=""><span class="${v.adv === null ? 'zero' : sign(v.adv)}">${v.adv === null ? '—' : fmt(v.adv)}</span></span>`;
    }).join('') : '';
    // почему герой в списке: контрпик и мета отдельно
    const why = [
      res ? `<span class="why ${sign(p.counter)}" title="Сумма преимуществ против выбранных врагов">контрпик ${fmt(p.counter)}</span>` : '',
      p.meta ? `<span class="why ${sign(p.metaPts)}" title="Винрейт героя на позиции ${P} в патче: ${p.meta.wr.toFixed(1)}%">мета ${fmt(p.metaPts)} · WR ${p.meta.wr.toFixed(1)}%</span>` : '',
    ].filter(Boolean).join('');
    const pct = Math.round((Math.abs(s) / max) * 100);
    const color = s >= 0 ? 'var(--good)' : 'var(--bad)';
    return `<div class="pick" data-pick="${h.key}" title="Клик — добавить в свою команду${P ? ' на позицию ' + P : ''}">
      <span class="pick-rank">${i + 1}</span>
      <img class="pick-img" src="${h.img}" alt="" loading="lazy">
      <div class="pick-main">
        <div class="pick-name">${esc(h.name)}<small>${esc(sub)}</small></div>
        ${why ? `<div class="pick-why">${why}</div>` : ''}
        ${vs ? `<div class="pick-vs">${vs}</div>` : ''}
      </div>
      <div class="pick-score">
        <b class="${sign(s)}">${fmt(s)}${res ? '%' : ''}</b>
        <small>${r && r.wr != null ? 'WR vs врагов ' + r.wr.toFixed(1) + '%' : ''}</small>
        <div class="bar"><span style="width:${pct}%;background:${color}"></span></div>
      </div>
    </div>`;
  }).join('') + (list.length > limit
    ? `<button class="btn ghost more" id="show-all">Показать всех (${list.length})</button>` : '');
}
function renderSource() {
  $$('#source-switch button').forEach((b) => {
    b.classList.toggle('active', b.dataset.source === state.source);
    if (b.dataset.source === 'dotabuff') {
      b.disabled = !state.dotabuff;
      b.title = state.dotabuff ? '' : 'Нет data.js — нажмите «Обновить данные»';
    }
  });
  const d = state.dotabuff;
  const info = $('#data-info');
  info.style.color = '';
  if (state.source === 'dotabuff' && d) {
    const when = new Date(stamp(d)).toLocaleString('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    info.textContent = `Dotabuff · ${periodName(d)} · обновлено ${when}`;
    const age = Math.floor(dataAgeDays(d));
    if (age >= STALE_DAYS) {
      info.textContent += ` · данные старше ${age} дн.`;
      info.style.color = 'var(--accent)';
    }
  } else {
    info.textContent = 'OpenDota live · свежие матчи высокого уровня';
  }
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ===================== события ===================== */

function bind() {
  const search = $('#search');

  search.addEventListener('input', () => { state.query = search.value; renderPool(); });
  search.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      const first = searchMatches()[0];
      if (state.query.trim() && first && add(first, ev.shiftKey ? 'ally' : ev.altKey ? 'ban' : state.mode)) {
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

  // начали печатать где угодно — фокус в поиск
  document.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey || document.activeElement === search) return;
    if ($('#update-dialog').open) return;
    if (ev.key.length === 1 && /[a-zа-я0-9']/i.test(ev.key)) search.focus();
  });

  const pool = $('#pool');
  pool.addEventListener('click', (ev) => {
    const t = ev.target.closest('.tile');
    if (!t) return;
    const k = t.dataset.key;
    if (taken().has(k)) { remove(k); return; }
    add(k, ev.shiftKey ? 'ban' : state.mode);
    search.value = state.query = '';
    renderPool();
  });
  pool.addEventListener('contextmenu', (ev) => {
    const t = ev.target.closest('.tile');
    if (!t) return;
    ev.preventDefault();
    add(t.dataset.key, 'ally');
  });

  $('.draft').addEventListener('click', (ev) => {
    const pb = ev.target.closest('button.pos');
    if (pb) { setPosition(pb.dataset.side, +pb.dataset.i, +pb.dataset.pos); return; }
    const rm = ev.target.closest('[data-remove]');
    if (rm) { remove(rm.dataset.remove); return; }
    const slot = ev.target.closest('.slot.empty');
    if (slot) { setMode(slot.dataset.side); search.focus(); return; }
    const clr = ev.target.closest('[data-clear]');
    if (clr) clearSide(clr.dataset.clear);
  });

  $('#pick-mode').addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (b) setMode(b.dataset.mode);
  });

  $('#picks-tab').addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    state.tab = b.dataset.tab;
    state.showAll = false;
    $$('#picks-tab button').forEach((x) => x.classList.toggle('active', x === b));
    renderPicks();
    $('#picks-body').scrollTop = 0;
  });

  $('#pos-filter').addEventListener('click', (ev) => {
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
      state.roles.has(b.dataset.role) ? state.roles.delete(b.dataset.role) : state.roles.add(b.dataset.role);
    } else {
      state.attr = state.attr === b.dataset.attr ? null : b.dataset.attr;
    }
    renderPicks();
  });

  $('#picks-body').addEventListener('click', (ev) => {
    if (ev.target.id === 'show-all') { state.showAll = true; renderPicks(); return; }
    const p = ev.target.closest('[data-pick]');
    if (!p) return;
    const P = targetPos();
    if (add(p.dataset.pick, 'ally')) {
      if (P) setPosition('ally', state.ally.indexOf(p.dataset.pick), P);
      toast(hero(p.dataset.pick).name + ' добавлен в вашу команду' + (P ? ` на позицию ${P}` : ''));
    }
  });

  $('#source-switch').addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b || b.disabled) return;
    setSource(b.dataset.source);
  });

  $('#btn-reset').addEventListener('click', () => {
    state.enemy = [null, null, null, null, null];
    state.ally = [null, null, null, null, null];
    state.enemyManual = [false, false, false, false, false];
    state.allyManual = [false, false, false, false, false];
    state.ban = [];
    state.pickPos = 0;
    search.value = state.query = '';
    changed();
    toast('Драфт очищен');
  });

  $('#btn-share').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); toast('Ссылка скопирована'); }
    catch { toast(location.href); }
  });

  // ---- обновление данных ----
  const dlg = $('#update-dialog');
  $('#btn-update').addEventListener('click', () => dlg.showModal());
  $('#btn-copy-script').addEventListener('click', async () => {
    const src = typeof dbcpScrape === 'function' ? `(${dbcpScrape.toString()})();` : null;
    if (!src) { toast('scraper.js не найден рядом с index.html'); return; }
    try { await navigator.clipboard.writeText(src); toast('Скрипт скопирован — вставьте его в консоль на dotabuff.com'); }
    catch { toast('Не удалось скопировать — откройте scraper.js и скопируйте вручную'); }
  });
  $('#btn-forget').addEventListener('click', () => {
    store.del('dbcp_data');
    state.dotabuff = pickDotabuffData();
    setSource(state.dotabuff ? state.source : 'opendota');
    toast('Импортированные данные удалены');
  });

  const drop = $('#drop-zone');
  const importFile = async (file) => {
    try {
      const data = parseDataFile(await file.text());
      state.dotabuff = data;
      if (!store.set('dbcp_data', data)) toast('Данные загружены, но не сохранены в браузере (нет места)');
      ensureHeroesFromDotabuff();
      setSource('dotabuff');
      dlg.close();
      toast(`Загружены данные Dotabuff от ${data.updated}`);
    } catch (e) {
      toast('Ошибка импорта: ' + e.message);
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
}

function setMode(mode) {
  state.mode = mode;
  $$('#pick-mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
}

function setSource(src) {
  shareCache.clear(); // данные могли поменяться (импорт)
  state.source = src;
  store.set('dbcp_source', src);
  renderSource();
  calculate();
}

// герои, которых нет в OpenDota (или OpenDota недоступен), берём из data.js
function ensureHeroesFromDotabuff() {
  const d = state.dotabuff;
  if (!d) return;
  const haveMeta = state.heroes.some((h) => h.id);
  for (const [key, h] of Object.entries(d.heroes)) {
    if (state.byKey.has(key)) continue;
    if (haveMeta) { console.warn('[DotaBuffCP] герой из Dotabuff не найден в OpenDota:', h.name, key); continue; }
    const entry = { key, id: null, name: h.name, attr: 'all', roles: [], img: h.img || '', icon: h.img || '', wr: 50 };
    state.heroes.push(entry);
    state.byKey.set(key, entry);
  }
}

/* ===================== старт ===================== */

async function init() {
  bind();
  const [meta] = await Promise.allSettled([loadHeroMeta(), loadDataScript()]);
  state.dotabuff = pickDotabuffData();

  try {
    if (meta.status === 'rejected') throw meta.reason;
    state.heroes = meta.value;
  } catch (e) {
    if (!state.dotabuff) {
      $('#pool').innerHTML = `<div class="empty-state"><h3>Нет данных</h3>
        <p>OpenDota недоступен (${esc(e.message)}), а data.js не найден.</p>
        <p>Проверьте интернет или загрузите data.js через «Обновить данные».</p></div>`;
      $('#data-info').textContent = 'нет данных';
      return;
    }
    toast('OpenDota недоступен — работаем только на данных Dotabuff');
  }
  state.byKey = new Map(state.heroes.map((h) => [h.key, h]));
  ensureHeroesFromDotabuff();

  const saved = store.get('dbcp_source');
  const haveOd = state.heroes.some((h) => h.id);
  const stale = state.dotabuff && dataAgeDays(state.dotabuff) >= STALE_DAYS;
  state.source = state.dotabuff && saved !== 'opendota' ? 'dotabuff' : 'opendota';
  if (state.source === 'dotabuff' && stale && haveOd) {
    state.source = 'opendota';
    toast('Данные Dotabuff устарели — показываю свежие данные OpenDota');
  }
  if (!haveOd) state.source = 'dotabuff';

  readHash();
  autoAssign('ally');
  autoAssign('enemy');
  renderSource();
  await calculate();
  if (matchMedia('(min-width: 1101px)').matches) $('#search').focus({ preventScroll: true });
}

init();
