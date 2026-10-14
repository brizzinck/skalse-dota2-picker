// Обновление data.js с Dotabuff для GitHub Actions (и любого Linux/macOS/Windows с Node и Chrome).
// Открывает dotabuff.com в настоящем Google Chrome и выполняет scraper.js через DevTools-протокол —
// так же, как update-data.ps1 на Windows. data.js перезаписывается только при успешном сборе.
//
//   npm i --no-save playwright
//   node scripts/update-data.mjs            # видимый Chrome (в CI — под xvfb-run)
//   HEADLESS=1 node scripts/update-data.mjs # без окна
import { chromium } from 'playwright';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scraper = await readFile(path.join(root, 'scraper.js'), 'utf8');
const date = process.env.DOTABUFF_DATE || '';

async function attempt(headless) {
  const browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL || 'chrome',
    headless,
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
  });
  try {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1366, height: 900 } });
    const page = await context.newPage();
    await page.goto('https://www.dotabuff.com/heroes', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // ждём, пока пройдёт возможная проверка Cloudflare
    await page.waitForFunction(() => /DOTABUFF/i.test(document.title), null, { timeout: 90_000 });
    console.log('Dotabuff открыт, собираю контрпики…');

    // Runtime.evaluate не подчиняется CSP страницы — как в update-data.ps1
    const cdp = await context.newCDPSession(page);
    const expression =
      `window.DBCP_NO_AUTORUN = true;\n${scraper}\n;` +
      `dbcpScrape({ download: false, date: ${JSON.stringify(date)} }).then((d) => JSON.stringify(d))`;
    const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 2_400_000 });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    return res.result.value;
  } finally {
    await browser.close();
  }
}

let json = null;
const modes = process.env.HEADLESS === '1' ? [true] : [false, true];
for (const headless of modes) {
  try {
    json = await attempt(headless);
    break;
  } catch (e) {
    console.warn(`Попытка (headless=${headless}) не удалась:`, e.message);
  }
}
if (!json) {
  console.error('Не удалось собрать данные — data.js не изменён');
  process.exit(1);
}

const data = JSON.parse(json);
const count = Object.keys(data.m).length;
if (count < 100) {
  console.error(`Собрано слишком мало героев (${count}) — data.js не изменён`);
  process.exit(1);
}

const file = path.join(root, 'data.js');
await writeFile(file + '.tmp', `window.DBCP_DATA = ${json};\n`, 'utf8');
await rename(file + '.tmp', file);
console.log(`Готово: ${count} героев, дата ${data.updated}` + (data.failed?.length ? `, проблемы: ${data.failed.join(', ')}` : ''));
