// Drive a headless browser through the TMS happy-path (CTI warehouse admin +
// driver PWA) and dump screenshots for the TMS training manual.
//
// Runs against a THROWAWAY copy of the dev DB on a separate port so the real
// dev DB is never touched. Bring that server up first:
//   cp data/stock-market.db /tmp/jcm-tms-shots.db
//   # (trip 7 bumped to today so the driver "today" view is populated)
//   preview server "jcm-tms-shots" on :3902  (DB_PATH=/tmp/jcm-tms-shots.db)
//
// Run:
//   node scripts/capture-tms-screenshots.js
//
// Output: docs/training/screenshots/{tms-cti,tms-driver}/*.png
//
// Admin auth: mints a super_admin JWT in-process (no password/CSV needed).
// Driver auth: real phone-number login through the PWA form.

const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const { chromium } = require('/Users/jiancha/AgenAi_Jiancha/FoodStory/node_modules/playwright');

const ROOT = path.join(__dirname, '..');
const BASE = 'http://localhost:3902';
const DB_PATH = '/tmp/jcm-tms-shots.db';
const SHOTS = path.join(ROOT, 'docs', 'training', 'screenshots');

const DRIVER_PHONE = '0989490996';   // ต่อพงศ์ — owns trip 7 (today, planned)
const TRIP_ID = 7;
const STOP_SHIPMENT_ID = 12;         // JC002 stop in trip 7
const STOP_BRANCH = 'JC002';

function mintAdminToken() {
  const m = fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^JWT_SECRET=(.*)$/m);
  const SECRET = m ? m[1].trim() : 'jc-stock-market-dev-secret';
  const db = new Database(DB_PATH, { readonly: true });
  const u = db.prepare("SELECT * FROM users WHERE username='itmanager'").get();
  db.close();
  const token = jwt.sign(
    { id: u.id, username: u.username, role: u.role, branch_code: u.branch_code || '', branch_type: 'fc' },
    SECRET, { expiresIn: '2h' }
  );
  const user = { id: u.id, username: u.username, role: u.role, name: u.username, branch_code: '', branch_name: '', branch_type: 'fc' };
  return { token, user };
}

async function shot(page, role, name) {
  const dir = path.join(SHOTS, role);
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: false });
  console.log(`  📸 ${role}/${name}.png`);
}

// ─── CTI warehouse (admin / dispatcher) ──────────────────────────────
async function captureCTI(browser, auth) {
  console.log('\n🏭 CTI warehouse — TMS admin (tms-admin.html)');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();

  // Establish origin, inject auth, then enter the guarded admin page.
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ token, user }) => {
    localStorage.setItem('jcsm_token', token);
    localStorage.setItem('jcsm_user', JSON.stringify(user));
  }, auth);

  await page.goto(BASE + '/tms-admin.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await shot(page, 'tms-cti', '01-carriers');

  // Expand drivers under a carrier (KEX/JC Global = id 5)
  await page.evaluate(() => { if (typeof selectCarrier === 'function') selectCarrier(5); });
  await page.waitForTimeout(500);
  await shot(page, 'tms-cti', '02-drivers');

  // Trips tab
  await page.evaluate(() => switchTab('trips'));
  await page.waitForTimeout(500);
  await shot(page, 'tms-cti', '03-trips');

  // Create-trip modal — shows the pool of unassigned shipments + carrier/driver/date
  await page.evaluate(() => openTripModal());
  await page.waitForTimeout(700);
  await shot(page, 'tms-cti', '04-create-trip');
  await page.keyboard.press('Escape').catch(() => {});

  // Printable manifest (ใบนำส่งสินค้า)
  await page.goto(BASE + `/trip-manifest.html?id=${TRIP_ID}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await shot(page, 'tms-cti', '05-manifest');

  await ctx.close();
}

// ─── Transport (driver PWA) ──────────────────────────────────────────
async function captureDriver(browser) {
  console.log('\n🚚 Transport — driver PWA (driver.html)');
  const ctx = await browser.newContext({ viewport: { width: 414, height: 896 }, isMobile: true });
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept().catch(() => {}));   // auto-confirm the dispatch prompt

  await page.goto(BASE + '/driver.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await shot(page, 'tms-driver', '01-login');

  // Phone-number login
  await page.fill('input[name=phone]', DRIVER_PHONE);
  await page.click('button[type=submit]');
  await page.waitForFunction(() => localStorage.getItem('jcsm_driver_token') != null, { timeout: 10000 });
  await page.waitForTimeout(900);
  await shot(page, 'tms-driver', '02-today-trip');

  // Dispatch the trip → in-transit, POD buttons appear
  await page.evaluate(() => { if (typeof doDispatch === 'function') return doDispatch(); });
  await page.waitForTimeout(1200);
  await shot(page, 'tms-driver', '03-in-transit');

  // Open the POD form for the stop
  await page.evaluate(({ id, branch }) => { if (typeof openPod === 'function') openPod(id, branch, 1); }, { id: STOP_SHIPMENT_ID, branch: STOP_BRANCH });
  await page.waitForTimeout(700);
  await shot(page, 'tms-driver', '04-pod-form');

  await ctx.close();
}

(async () => {
  const auth = mintAdminToken();
  console.log('🚀 Launching browser (TMS screenshots, server :3902)...');
  const browser = await chromium.launch({ headless: true });
  try {
    await captureCTI(browser, auth);
    await captureDriver(browser);
  } finally {
    await browser.close();
  }
  console.log('\n✅ Done — screenshots under docs/training/screenshots/{tms-cti,tms-driver}/');
})().catch(e => { console.error('❌', e.message); console.error(e.stack); process.exit(1); });
