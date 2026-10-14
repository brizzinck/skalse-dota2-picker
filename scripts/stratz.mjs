// Collects Stratz data into stratz.js — no browser needed, plain HTTPS requests to the Stratz GraphQL API.
//
// Stratz gives per-position statistics for all ranked games of the current patch:
//   • hero win rate and game share on each position 1–5
//   • matchups (hero vs hero)
//   • item purchases per hero per position with purchase minutes
//
// Token: a free key from https://stratz.com/api — env STRATZ_TOKEN or a local file .stratz-token (gitignored).
//
//   node scripts/stratz.mjs            # collect → stratz.js
//   node scripts/stratz.mjs --schema   # print the relevant parts of the API schema (debugging)
import { readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.stratz.com/graphql';
const POSITIONS = ['POSITION_1', 'POSITION_2', 'POSITION_3', 'POSITION_4', 'POSITION_5'];
const BATCH = Number(process.env.STRATZ_BATCH || 8);     // heroes per request (GraphQL aliases)
const PAUSE_MS = Number(process.env.STRATZ_PAUSE || 400); // stay well below the free rate limit

const token = (process.env.STRATZ_TOKEN || await readFile(path.join(root, '.stratz-token'), 'utf8').catch(() => '')).trim();
if (!token) {
  console.error('No Stratz token: set STRATZ_TOKEN or create .stratz-token (https://stratz.com/api)');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// same normalization as app.js
const NAME_FIX = { outworlddevourer: 'outworlddestroyer', skeletonking: 'wraithking', windrunner: 'windranger' };
const norm = (s) => {
  const k = String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  return NAME_FIX[k] || k;
};

let calls = 0;
async function gql(query, variables = {}) {
  for (let attempt = 0; attempt < 6; attempt++) {
    calls++;
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': 'STRATZ_API' },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429 || res.status >= 500) { await sleep(3000 * (attempt + 1)); continue; }
    const body = await res.json().catch(() => null);
    if (!res.ok || !body) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
    if (body.errors && !body.data) throw new Error(body.errors.map((e) => e.message).join('; '));
    if (body.errors) console.warn('  GraphQL warnings:', body.errors.map((e) => e.message).join('; ').slice(0, 300));
    await sleep(PAUSE_MS);
    return body.data;
  }
  throw new Error('Too many retries');
}

/* ---------- schema check ---------- */

const TYPE_REF = 'name kind ofType { name kind ofType { name kind ofType { name kind } } }';
async function typeFields(name) {
  const d = await gql(`{ __type(name: "${name}") { fields { name args { name type { ${TYPE_REF} } } type { ${TYPE_REF} } } } }`);
  return d.__type ? d.__type.fields : [];
}
const typeName = (t) => (t ? t.name || typeName(t.ofType) : null);

if (process.argv.includes('--schema')) {
  const fields = await typeFields('HeroStatsQuery');
  for (const f of fields) {
    console.log(`${f.name}(${f.args.map((a) => `${a.name}: ${typeName(a.type)}`).join(', ')}): ${typeName(f.type)}`);
  }
  for (const tn of ['HeroDryType', 'HeroStatsHeroDryType', 'HeroItemPurchaseType', 'HeroItemPurchaseEventType', 'HeroWinGameVersionType', 'HeroPositionTimeDetailType']) {
    const fs = await typeFields(tn);
    if (fs.length) console.log(`\n${tn}: ${fs.map((f) => `${f.name}: ${typeName(f.type)}`).join(', ')}`);
  }
  process.exit(0);
}

// fail early with a clear message if the API changed
const heroStatsFields = new Map((await typeFields('HeroStatsQuery')).map((f) => [f.name, f]));
for (const need of ['stats', 'matchUp', 'itemFullPurchase']) {
  if (!heroStatsFields.has(need)) {
    console.error(`Stratz API has no heroStats.${need}. Available: ${[...heroStatsFields.keys()].join(', ')}`);
    process.exit(1);
  }
}

/* ---------- constants ---------- */

console.log('Constants…');
const c = (await gql(`{ constants {
  heroes { id displayName shortName }
  items { id shortName displayName }
  gameVersions { id name asOfDateTime }
} }`)).constants;

const heroes = c.heroes.filter((h) => h.displayName && h.id);
const heroKey = new Map(heroes.map((h) => [h.id, norm(h.displayName)]));
const itemKey = new Map(c.items.filter((i) => i.shortName).map((i) => [i.id, i.shortName.replace(/^item_/, '')]));
const patch = [...c.gameVersions].sort((a, b) => b.id - a.id)[0];
const patchName = patch.name.replace(/[a-z]$/i, ''); // "7.41f" → "7.41"
console.log(`  ${heroes.length} heroes, ${itemKey.size} items, patch ${patch.name}`);

/* ---------- positions: game share and win rate per position (latest week, all ranked games) ---------- */

console.log('Positions…');
const pos = {}; // key -> {1: [matches, wr], …}
{
  const d = await gql(`{ heroStats { stats(groupByPosition: true) { heroId position matchCount winCount } } }`);
  for (const r of d.heroStats.stats) {
    const k = heroKey.get(r.heroId);
    const p = POSITIONS.indexOf(r.position) + 1;
    if (!k || !p || !r.matchCount) continue;
    (pos[k] = pos[k] || {})[p] = [r.matchCount, +((r.winCount / r.matchCount) * 100).toFixed(2)];
  }
}
console.log(`  ${Object.keys(pos).length} heroes with position data`);

/* ---------- matchups ---------- */

console.log('Matchups…');
const m = {}; // enemyKey -> candKey -> [candidate advantage, candidate win rate, matches]
const ids = heroes.map((h) => h.id);
for (let i = 0; i < ids.length; i += BATCH) {
  const part = ids.slice(i, i + BATCH);
  const q = `{ heroStats { ${part.map((id) => `h${id}: matchUp(heroId: ${id}, matchLimit: 0, take: 200) { heroId vs { heroId2 matchCount winCount synergy } }`).join('\n')} } }`;
  const d = await gql(q);
  for (const id of part) {
    const ek = heroKey.get(id);
    const row = (m[ek] = {});
    for (const block of [].concat(d.heroStats['h' + id] || [])) {
      for (const v of block.vs || []) {
        const ck = heroKey.get(v.heroId2);
        if (!ck || !v.matchCount) continue;
        // "vs" is from the enemy's side: synergy = the enemy's advantage over the candidate.
        // Stratz matchup samples are a few thousand games per pair — shrink a little towards zero.
        const shrink = v.matchCount / (v.matchCount + 800);
        row[ck] = [+(-v.synergy * shrink).toFixed(2), +(100 - (v.winCount / v.matchCount) * 100).toFixed(2), v.matchCount];
      }
    }
  }
  process.stdout.write(`  ${Math.min(i + BATCH, ids.length)}/${ids.length}\r`);
}
console.log();

/* ---------- item purchases per position ---------- */

console.log('Items per position…');
const guides = {}; // key -> pos -> {n, w, items: {itemKey: [matches, medianSec]}}
const allItems = {}; // key -> Map(itemKey -> [matches, wins]) over all positions
const games = {};  // key -> item sample size over all positions
const MIN_POS_SHARE = 0.05;
for (let p = 1; p <= 5; p++) {
  const onPos = ids.filter((id) => {
    const k = heroKey.get(id);
    if (!pos[k] || !pos[k][p]) return false;
    const total = Object.values(pos[k]).reduce((s, x) => s + x[0], 0);
    return pos[k][p][0] / total >= MIN_POS_SHARE;
  });
  for (let i = 0; i < onPos.length; i += BATCH) {
    const part = onPos.slice(i, i + BATCH);
    const q = `{ heroStats { ${part.map((id) => `h${id}: itemFullPurchase(heroId: ${id}, positionIds: [${POSITIONS[p - 1]}], matchLimit: 0) { itemId instance time matchCount winCount }`).join('\n')} } }`;
    const d = await gql(q);
    for (const id of part) {
      const k = heroKey.get(id);
      const byItem = new Map(); // item -> {c, w, t: [[minute, count]]}
      for (const r of [].concat(d.heroStats['h' + id] || [])) {
        if (r.instance !== 0) continue; // first purchase of the item only
        const ik = itemKey.get(r.itemId);
        if (!ik || !r.matchCount) continue;
        const a = byItem.get(ik) || { c: 0, w: 0, t: [] };
        a.c += r.matchCount; a.w += r.winCount; a.t.push([r.time, r.matchCount]);
        byItem.set(ik, a);
      }
      if (!byItem.size) continue;
      // sample size: the item bought most often on this position (core items are bought ~every game)
      const n = Math.max(...[...byItem.values()].map((a) => a.c));
      const out = {};
      for (const [ik, a] of byItem) {
        if (a.c / n < 0.03) continue; // drop rare items to keep the file small
        a.t.sort((x, y) => x[0] - y[0]);
        let acc = 0, median = a.t[a.t.length - 1][0];
        for (const [minute, cnt] of a.t) { acc += cnt; if (acc >= a.c / 2) { median = minute; break; } }
        out[ik] = [a.c, median * 60];
        const all = (allItems[k] = allItems[k] || new Map());
        const prev = all.get(ik) || [0, 0];
        all.set(ik, [prev[0] + a.c, prev[1] + a.w]);
      }
      const wr = pos[k][p][1];
      (guides[k] = guides[k] || {})[p] = { n, w: Math.round((n * wr) / 100), items: out };
      games[k] = (games[k] || 0) + n;
    }
    process.stdout.write(`  pos ${p}: ${Math.min(i + BATCH, onPos.length)}/${onPos.length}\r`);
  }
  console.log();
}
const items = {}; // key -> [[itemKey, matches, wr]] over all positions
for (const [k, map] of Object.entries(allItems)) {
  items[k] = [...map]
    .map(([ik, [cnt, w]]) => [ik, cnt, +((w / cnt) * 100).toFixed(2)])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 60);
}

/* ---------- output ---------- */

const out = {
  source: 'stratz',
  version: 1,
  updated: new Date().toISOString().slice(0, 10),
  updatedAt: new Date().toISOString(),
  period: 'patch_' + patchName,
  periodLabel: 'Patch ' + patch.name,
  heroes: Object.fromEntries(heroes.map((h) => [norm(h.displayName), { name: h.displayName, id: h.id }])),
  games, pos, m, items, guides,
};
const count = Object.keys(m).filter((k) => Object.keys(m[k]).length > 50).length;
if (count < 100) {
  console.error(`Too few heroes with matchups (${count}) — stratz.js left unchanged`);
  process.exit(1);
}
const file = path.join(root, 'stratz.js');
await writeFile(file + '.tmp', `window.DBCP_STRATZ = ${JSON.stringify(out)};\n`, 'utf8');
await rename(file + '.tmp', file);
console.log(`Done: ${count} heroes, patch ${patch.name}, ${calls} API calls`);