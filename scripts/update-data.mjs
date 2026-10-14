// Updates data.js from Dotabuff (GitHub Actions, or any Linux/macOS/Windows with Node and Chrome).
// Opens dotabuff.com in a real Google Chrome and runs scraper.js through the DevTools protocol —
// the same approach as update-data.ps1 on Windows. data.js is overwritten only on success.
//
// Dotabuff sits behind Cloudflare, which is strict with datacenter IPs. We first try Patchright
// (an undetected Playwright fork), then plain Playwright, headed (under xvfb in CI) and headless.
//
//   npm i --no-save patchright playwright
//   node scripts/update-data.mjs              # headed Chrome (use xvfb-run in CI)
//   HEADLESS=1 node scripts/update-data.mjs   # headless only
import { readFile, writeFile, rename, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scraper = await readFile(path.join(root, 'scraper.js'), 'utf8');
const date = process.env.DOTABUFF_DATE || '';
const channel = process.env.CHROME_CHANNEL || 'chrome';

async function loadEngine(name) {
  try { return (await import(name)).chromium; } catch { return null; }
}

async function attempt(engineName, headless) {
  const chromium = await loadEngine(engineName);
  if (!chromium) throw new Error(`${engineName} is not installed`);
  // a persistent context with default settings looks the most like a regular browser
  const userDir = await mkdtemp(path.join(tmpdir(), 'dbcp-'));
  const context = await chromium.launchPersistentContext(userDir, {
    channel, headless, viewport: null,
    ...(engineName === 'playwright' ? { args: ['--disable-blink-features=AutomationControlled'], locale: 'en-US' } : {}),
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto('https://www.dotabuff.com/heroes', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // wait until a possible Cloudflare check passes
    await page.waitForFunction(() => /DOTABUFF/i.test(document.title), null, { timeout: 120_000 });
    console.log('Dotabuff is open, collecting data…');

    // Runtime.evaluate is not subject to the page's CSP — same as update-data.ps1
    const cdp = await context.newCDPSession(page);
    const expression =
      `window.DBCP_NO_AUTORUN = true;\n${scraper}\n;` +
      `dbcpScrape({ download: false, date: ${JSON.stringify(date)} }).then((d) => JSON.stringify(d))`;
    const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 2_400_000 });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    return res.result.value;
  } finally {
    await context.close();
  }
}

const plans = process.env.HEADLESS === '1'
  ? [['patchright', true], ['playwright', true]]
  : [['patchright', false], ['playwright', false], ['playwright', true]];

let json = null;
for (const [engine, headless] of plans) {
  try {
    console.log(`Trying ${engine} (headless=${headless})…`);
    json = await attempt(engine, headless);
    break;
  } catch (e) {
    console.warn(`  failed: ${e.message.split('\n')[0]}`);
  }
}
if (!json) {
  console.error('Could not collect the data — data.js left unchanged');
  process.exit(1);
}

const data = JSON.parse(json);
const count = Object.keys(data.m).length;
if (count < 100) {
  console.error(`Too few heroes collected (${count}) — data.js left unchanged`);
  process.exit(1);
}

const file = path.join(root, 'data.js');
await writeFile(file + '.tmp', `window.DBCP_DATA = ${json};\n`, 'utf8');
await rename(file + '.tmp', file);
console.log(`Done: ${count} heroes, ${data.period}, ${data.updated}` + (data.failed?.length ? `, problems: ${data.failed.join(', ')}` : ''));
