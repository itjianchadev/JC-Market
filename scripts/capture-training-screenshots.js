// Drive a real browser through each role's happy-path on the local
// JC-Market and dump screenshots for the training docs.
//
// Reads passwords from the latest CSVs in imports/ so creds don't sit in
// source. Launches headless Chromium via the playwright install in the
// sibling FoodStory project (no need to install a second copy here).
//
// Run:
//   node scripts/capture-training-screenshots.js
//
// Output: docs/training/screenshots/{jf,jc,finance,it}/*.png
//
// Expects the dev server to already be up on http://localhost:3863.

const path = require('path');
const fs = require('fs');
const { chromium } = require('/Users/jiancha/AgenAi_Jiancha/FoodStory/node_modules/playwright');

const ROOT = path.join(__dirname, '..');
const BASE = 'http://localhost:3863';
const SHOTS = path.join(ROOT, 'docs', 'training', 'screenshots');

function latestCsv(prefix) {
  const files = fs.readdirSync(path.join(ROOT, 'imports'))
    .filter(f => f.startsWith(prefix) && f.endsWith('.csv'))
    .sort();
  if (!files.length) throw new Error('No CSV found with prefix ' + prefix);
  return path.join(ROOT, 'imports', files[files.length - 1]);
}

function parseCsv(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const headers = lines.shift().split(',');
  return lines.filter(Boolean).map(line => {
    // Naïve CSV — quoted-comma is the only escape we care about.
    const cells = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') inQ = !inQ;
      else if (c === ',' && !inQ) { cells.push(cur); cur = ''; }
      else cur += c;
    }
    cells.push(cur);
    const row = {};
    headers.forEach((h, i) => row[h] = cells[i]);
    return row;
  });
}

function findCred(rows, username) {
  return rows.find(r => r.username === username);
}

async function login(page, username, password) {
  await page.goto(BASE + '/login.html', { waitUntil: 'networkidle' });
  await page.fill('input[name=username]', username);
  await page.fill('input[name=password]', password);
  await page.click('button[type=submit]');
  // Login does the redirect via location.href AFTER the /api/login fetch resolves,
  // so 'networkidle' returns before the URL changes. Wait until the token is set
  // (setAuth happens just before the redirect) so subsequent navigations see auth.
  await page.waitForFunction(() => localStorage.getItem('jcsm_token') != null, { timeout: 10000 });
  await page.waitForLoadState('networkidle');
}

async function shot(page, role, name) {
  const dir = path.join(SHOTS, role);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`  📸 ${role}/${name}.png`);
}

// Drop something orderable in the cart via the API — UI clicks on "+ สั่ง" are
// flaky because the page can render items beyond the viewport / accordion
// state varies per role. Picks any item with a price and inventory.
async function seedCart(page, opts = {}) {
  return page.evaluate(async (filter) => {
    const tok = localStorage.getItem('jcsm_token');
    const headers = { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' };
    const itemsRes = await fetch('/api/items', { headers });
    const items = await itemsRes.json();
    const orderable = items.find(it =>
      it.unit_price > 0 && it.inventory > 0
      && (!filter.category || (it.category || '') === filter.category)
    );
    if (!orderable) return { ok: false, error: 'no orderable item matching filter' };
    const r = await fetch('/api/cart/add', {
      method: 'POST', headers,
      body: JSON.stringify({ item_no: orderable.item_no, quantity: 1 }),
    });
    return { ok: r.ok, item: orderable.item_no, name: orderable.name };
  }, opts);
}

// ─── Per-role journeys ───────────────────────────────────────────────
async function captureJF(browser, creds) {
  console.log('\n🏪 JF (franchise) — Owner JF049');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await login(page, 'jf049', creds.jf049);
  await shot(page, 'jf', '01-shop-home');

  await page.click('text=ผลไม้สด');
  await page.waitForTimeout(400);
  await shot(page, 'jf', '02-shop-fruit-group');

  const seed = await seedCart(page, { category: 'Fruit fresh' });
  console.log('     seeded JF cart:', seed);

  await page.goto(BASE + '/cart.html', { waitUntil: 'networkidle' });
  await shot(page, 'jf', '03-cart');

  await page.click('text=ดำเนินการชำระเงิน');
  await page.waitForLoadState('networkidle');
  await shot(page, 'jf', '04-checkout-confirm');

  await ctx.close();
}

async function captureJC(browser, creds) {
  console.log('\n🏢 JC (master) — Owner JC002');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await login(page, 'jc002', creds.jc002);
  await shot(page, 'jc', '01-shop-home');

  await page.click('text=สินค้าทั่วไป');
  await page.waitForTimeout(400);
  await shot(page, 'jc', '02-shop-general-group');

  const seed = await seedCart(page);
  console.log('     seeded JC cart:', seed);

  await page.goto(BASE + '/cart.html', { waitUntil: 'networkidle' });
  await shot(page, 'jc', '03-cart');

  await page.click('text=ดำเนินการชำระเงิน');
  await page.waitForLoadState('networkidle');
  await shot(page, 'jc', '04-checkout-confirm-no-payment');

  await page.goto(BASE + '/orders.html', { waitUntil: 'networkidle' });
  await shot(page, 'jc', '05-orders-list');
  await ctx.close();
}

async function captureFinance(browser, creds) {
  console.log('\n💰 Finance');
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await login(page, 'finance', creds.finance);
  // Finance is auto-redirected to /approvals.html — capture that landing
  await shot(page, 'finance', '01-pending-tab');

  await page.click('text=อนุมัติแล้ว');
  await page.waitForTimeout(500);
  await shot(page, 'finance', '02-approved-tab');

  await page.click('text=ปฏิเสธ');
  await page.waitForTimeout(500);
  await shot(page, 'finance', '03-rejected-tab');
  await ctx.close();
}

async function captureIT(browser, creds) {
  console.log('\n🛠 IT / Admin');
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await login(page, 'itmanager', creds.itmanager);
  // IT lands on /index.html shop view; admin dashboard is /admin.html
  await page.goto(BASE + '/admin.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000); // let the dashboard fetch fill in
  await shot(page, 'it', '01-admin-dashboard');

  await page.goto(BASE + '/team.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  await shot(page, 'it', '02-team-management');

  await page.goto(BASE + '/orders.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  await shot(page, 'it', '03-orders-all-branches');
  await ctx.close();
}

// ─── Main ────────────────────────────────────────────────────────────
(async () => {
  const fsRows = parseCsv(latestCsv('foodstory-users-'));
  const hqRows = parseCsv(latestCsv('hq-users-'));

  const creds = {
    jf049:     findCred(fsRows, 'jf049').password,
    jc002:     findCred(fsRows, 'jc002').password,
    finance:   findCred(hqRows, 'finance').new_password,
    itmanager: findCred(hqRows, 'itmanager').new_password,
  };

  for (const [k, v] of Object.entries(creds)) {
    if (!v || /unchanged/.test(v)) {
      throw new Error(`Missing/unchanged password for ${k} — re-run sync-foodstory-users.js --reset first`);
    }
  }

  console.log('🚀 Launching browser...');
  const browser = await chromium.launch({ headless: true });

  try {
    await captureJF(browser, creds);
    await captureJC(browser, creds);
    await captureFinance(browser, creds);
    await captureIT(browser, creds);
  } finally {
    await browser.close();
  }
  console.log('\n✅ Done — screenshots under docs/training/screenshots/');
})().catch(e => { console.error('❌', e.message); console.error(e.stack); process.exit(1); });
