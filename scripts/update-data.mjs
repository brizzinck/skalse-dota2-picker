// Updates data.js from Dotabuff (GitHub Actions, or any Linux/macOS/Windows with Node and Chrome).
// Opens dotabuff.com in a real Google Chrome and runs scraper.js through the DevTools protocol —
// the same approach as update-data.ps1 on Windows. data.js is overwritten only on success.
//
// Dotabuff sits behind Cloudflare, which is strict with datacenter IPs. We first try Patchright
// (an undetected Playwright fork), then plain Playwright, headed (under xvfb in CI) and headless.
//
// GitHub's datacenter IPs are blocked outright, so in CI the browser goes through a proxy:
//   DOTABUFF_PROXY            HTTP proxy server, e.g. http://proxy.example.com:8080
//   DOTABUFF_PROXY_USER       proxy login; a {country} placeholder is replaced with each
//   DOTABUFF_PROXY_COUNTRIES  comma-separated country, tried in order until one gets through
//   DOTABUFF_PROXY_PASS       proxy password
// Chrome only sends credentials after a 407 challenge, and some proxies answer 502 instead,
// so Chrome talks to a local relay that adds Proxy-Authorization to every request itself.
//
//   npm i --no-save patchright playwright
//   node scripts/update-data.mjs              # headed Chrome (use xvfb-run in CI)
//   HEADLESS=1 node scripts/update-data.mjs   # headless only
//   CHROME_CHANNEL= node scripts/update-data.mjs  # bundled Chromium instead of Google Chrome
import { readFile, writeFile, rename, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scraper = await readFile(path.join(root, 'scraper.js'), 'utf8');
const date = process.env.DOTABUFF_DATE || '';
const channel = process.env.CHROME_CHANNEL ?? 'chrome';

const proxyServer = process.env.DOTABUFF_PROXY || '';
const proxyUser = process.env.DOTABUFF_PROXY_USER || '';
const proxyPass = process.env.DOTABUFF_PROXY_PASS || '';
const countries = (process.env.DOTABUFF_PROXY_COUNTRIES || '').split(',').map((c) => c.trim()).filter(Boolean);
const proxies = !proxyServer ? [null]
  : proxyUser.includes('{country}') && countries.length
    ? countries.map((c) => ({ server: proxyServer, username: proxyUser.replaceAll('{country}', c), password: proxyPass, label: c }))
    : [{ server: proxyServer, username: proxyUser || undefined, password: proxyPass || undefined, label: 'proxy' }];

async function loadEngine(name) {
  try { return (await import(name)).chromium; } catch { return null; }
}

// Local proxy on 127.0.0.1 that forwards to the upstream proxy with credentials preset.
async function startRelay({ server, username, password }) {
  const upstream = new URL(server);
  const auth = username ? `Proxy-Authorization: Basic ${Buffer.from(`${username}:${password || ''}`).toString('base64')}\r\n` : '';
  const relay = net.createServer((client) => {
    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      client.off('data', onData);
      const lineEnd = head.indexOf('\r\n') + 2;
      const remote = net.connect(Number(upstream.port) || 80, upstream.hostname, () => {
        remote.write(Buffer.concat([head.subarray(0, lineEnd), Buffer.from(auth), head.subarray(lineEnd)]));
        client.pipe(remote).pipe(client);
      });
      remote.on('error', () => client.destroy());
      client.on('close', () => remote.destroy());
    };
    client.on('data', onData);
    client.on('error', () => {});
  });
  await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve));
  return relay;
}

async function passChallenge(page) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (/DOTABUFF/i.test(await page.title().catch(() => ''))) return;
    const turnstile = page.frames().find((f) => f.url().includes('challenges.cloudflare.com'));
    const box = turnstile && await turnstile.frameElement().then((el) => el.boundingBox()).catch(() => null);
    if (box && box.width > 0) {
      // the checkbox sits at the left edge of the widget
      await page.mouse.click(box.x + 30, box.y + box.height / 2, { delay: 80 + Math.random() * 120 }).catch(() => {});
      await page.waitForTimeout(5_000);
    } else {
      await page.waitForTimeout(1_000);
    }
  }
  throw new Error(`Cloudflare check not passed (title: ${await page.title().catch(() => '?')})`);
}

async function attempt(engineName, headless, proxy) {
  const chromium = await loadEngine(engineName);
  if (!chromium) throw new Error(`${engineName} is not installed`);
  // a persistent context with default settings looks the most like a regular browser
  const userDir = await mkdtemp(path.join(tmpdir(), 'dbcp-'));
  const context = await chromium.launchPersistentContext(userDir, {
    channel: channel || undefined, headless, viewport: null,
    ...(proxy ? { proxy: { server: `http://127.0.0.1:${proxy.port}` } } : {}),
    ...(engineName === 'playwright' ? { args: ['--disable-blink-features=AutomationControlled'], locale: 'en-US' } : {}),
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto('https://www.dotabuff.com/heroes', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // wait until a possible Cloudflare check passes, ticking the Turnstile checkbox if one shows up
    await passChallenge(page).catch(async (e) => {
      const shot = path.join(tmpdir(), `dotabuff-${engineName}-${headless ? 'headless' : 'headed'}.png`);
      await page.screenshot({ path: shot }).then(() => console.warn(`  screenshot: ${shot}`), () => {});
      throw e;
    });
    console.log('Dotabuff is open, collecting data…');

    // Runtime.evaluate is not subject to the page's CSP — same as update-data.ps1
    const cdp = await context.newCDPSession(page);

    // window.dbcpLoad(path): the scraper falls back to it when Cloudflare challenges fetch().
    // Each request opens the page in a spare tab, which passes where fetch() does not.
    const idle = [];
    const loadViaTab = async (url) => {
      let tab = idle.pop();
      if (!tab) {
        tab = await context.newPage();
        // only the HTML is needed: skip images, fonts and third-party scripts, keep what Cloudflare runs
        await tab.route('**/*', (route) => {
          const req = route.request();
          const type = req.resourceType();
          const keep = type === 'document' || /cloudflare|\/cdn-cgi\//.test(req.url()) ||
            (type !== 'image' && type !== 'media' && type !== 'font' && type !== 'script' && type !== 'stylesheet');
          return keep ? route.continue() : route.abort();
        });
      }
      try {
        const res = await tab.goto(new URL(url, 'https://www.dotabuff.com').href, { waitUntil: 'commit', timeout: 60_000 });
        if (res?.headers()['cf-mitigated'] === 'challenge') {
          await passChallenge(tab);
          return { status: 200, text: await tab.content() };
        }
        return { status: res ? res.status() : 0, text: res?.ok() ? await res.text() : '' };
      } catch {
        return { status: 0, text: '' };
      } finally {
        idle.push(tab);
      }
    };
    await cdp.send('Runtime.addBinding', { name: 'dbcpLoadRaw' });
    cdp.on('Runtime.bindingCalled', async ({ name, payload }) => {
      if (name !== 'dbcpLoadRaw') return;
      const { id, path: url } = JSON.parse(payload);
      const result = await loadViaTab(url);
      await cdp.send('Runtime.evaluate', { expression: `window.dbcpLoadDone(${id}, ${JSON.stringify(result)})` }).catch(() => {});
    });
    const loadShim =
      '{ const waiting = new Map(); let next = 0;' +
      ' window.dbcpLoadDone = (id, r) => { waiting.get(id)(r); waiting.delete(id); };' +
      ' window.dbcpLoad = (path) => new Promise((resolve) => { const id = ++next; waiting.set(id, resolve); dbcpLoadRaw(JSON.stringify({ id, path })); }); }\n';

    const expression = loadShim +
      `window.DBCP_NO_AUTORUN = true;\n${scraper}\n;` +
      `dbcpScrape({ download: false, date: ${JSON.stringify(date)} }).then((d) => JSON.stringify(d))`;
    const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 19_800_000 });
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
attempts: for (const proxy of proxies) {
  const relay = proxy && await startRelay(proxy);
  try {
    for (const [engine, headless] of plans) {
      try {
        console.log(`Trying ${engine} (headless=${headless})${proxy ? ` via ${proxy.label}` : ''}…`);
        json = await attempt(engine, headless, relay && { port: relay.address().port });
        break attempts;
      } catch (e) {
        console.warn(`  failed: ${e.message.split('\n')[0]}`);
      }
    }
  } finally {
    relay?.close();
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
