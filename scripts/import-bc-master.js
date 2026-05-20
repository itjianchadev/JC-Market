// One-shot importer: pull Vendor / Unit of Measure / Item rows out of the
// .xlsx files under JC-Market/imports/ and POST them into the BC sandbox
// configured by .env (BC_TENANT_ID + BC_ENVIRONMENT + BC_COMPANY_ID).
//
// Idempotent: queries BC's existing list first, skips records whose primary
// key already exists. Writes a CSV report next to each input file:
//   imports/Vendors.report.csv
//   imports/Items.report.csv
//   imports/Units of Measure.report.csv
//
// Usage:
//   node scripts/import-bc-master.js               # all 3 files
//   node scripts/import-bc-master.js vendors       # one entity only
//   node scripts/import-bc-master.js --dry-run     # parse + map but don't POST
//
// Throttle: BC throttles around 600 req/min per environment — we sleep 110ms
// between writes (≈ 545/min) to stay safely under.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const fs = require('fs');
const xlsx = require('xlsx');
const fetch = require('node-fetch');

const IMPORTS_DIR = path.join(__dirname, '..', 'imports');
const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT_ARG = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split('=')[1], 10) : 0; // 0 = no limit
const ONLY = process.argv.filter(a => !a.startsWith('--') && a !== process.argv[0] && a !== process.argv[1]);

const TENANT = process.env.BC_TENANT_ID;
const ENV = process.env.BC_ENVIRONMENT;
const COMPANY = process.env.BC_COMPANY_ID;
const CLIENT_ID = process.env.BC_CLIENT_ID;
const SECRET = process.env.BC_CLIENT_SECRET;
const BASE = `https://api.businesscentral.dynamics.com/v2.0/${TENANT}/${ENV}/api/v2.0/companies(${COMPANY})`;
const COMPANY_NAME = process.env.BC_COMPANY_NAME;
const ODATA_BASE = COMPANY_NAME
  ? `https://api.businesscentral.dynamics.com/v2.0/${TENANT}/${ENV}/ODataV4/Company('${encodeURIComponent(COMPANY_NAME)}')`
  : null;

if (!TENANT || !ENV || !COMPANY || !CLIENT_ID || !SECRET) {
  console.error('Missing BC_* env vars. Check .env');
  process.exit(1);
}

let tokenCache = { value: null, exp: 0 };
async function token() {
  if (tokenCache.value && Date.now() < tokenCache.exp) return tokenCache.value;
  const r = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: SECRET,
      scope: 'https://api.businesscentral.dynamics.com/.default',
    }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('Auth failed: ' + JSON.stringify(j));
  tokenCache = { value: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return j.access_token;
}

async function bcGet(path) {
  const t = await token();
  const r = await fetch(BASE + path, { headers: { Authorization: 'Bearer ' + t, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}: ${(await r.text()).slice(0, 400)}`);
  return r.json();
}

async function bcPost(path, body) {
  const t = await token();
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`POST ${path} → ${r.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

async function bcPatch(path, etag, body) {
  const t = await token();
  const r = await fetch(BASE + path, {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer ' + t,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'If-Match': etag,
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`PATCH ${path} → ${r.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

// OData v4 — used for fields the standard API v2.0 doesn't expose
// (Sales/Purch Unit of Measure on the Item table).
async function odataGet(path) {
  if (!ODATA_BASE) throw new Error('BC_COMPANY_NAME env var required for OData');
  const t = await token();
  const r = await fetch(ODATA_BASE + path, { headers: { Authorization: 'Bearer ' + t, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`OData GET ${path} → ${r.status}: ${(await r.text()).slice(0, 400)}`);
  return r.json();
}

async function odataPatch(path, etag, body) {
  if (!ODATA_BASE) throw new Error('BC_COMPANY_NAME env var required for OData');
  const t = await token();
  const r = await fetch(ODATA_BASE + path, {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer ' + t,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'If-Match': etag,
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`OData PATCH ${path} → ${r.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function readSheet(fileName) {
  const wb = xlsx.readFile(path.join(IMPORTS_DIR, fileName));
  const ws = wb.Sheets[wb.SheetNames[0]];
  return xlsx.utils.sheet_to_json(ws, { defval: null, blankrows: false });
}

function appendReport(file, rows) {
  const lines = rows.map(r => r.map(c => {
    if (c == null) return '';
    const s = String(c).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  }).join(','));
  fs.writeFileSync(file, lines.join('\n'));
}

// ─── Importers ───────────────────────────────────────────────────────────
async function importUoM() {
  console.log('\n📦 Units of Measure');
  const rows = readSheet('Units of Measure.xlsx');
  const existing = (await bcGet('/unitsOfMeasure?$select=code&$top=500')).value || [];
  const existingCodes = new Set(existing.map(v => v.code));
  const report = [['code', 'description', 'status', 'message']];
  let ok = 0, skip = 0, err = 0, written = 0;
  for (const row of rows) {
    if (LIMIT && written >= LIMIT) break;
    const code = (row['Code'] || '').toString().trim();
    if (!code) { report.push(['', '', 'skip', 'empty code']); skip++; continue; }
    if (existingCodes.has(code)) { report.push([code, row['Description'] || '', 'skip', 'already exists']); skip++; continue; }
    const payload = {
      code,
      displayName: (row['Description'] || code).toString(),
      internationalStandardCode: (row['International Standard Code'] || '').toString(),
    };
    written++;
    if (DRY_RUN) { report.push([code, payload.displayName, 'dry-run', JSON.stringify(payload)]); ok++; continue; }
    try {
      await bcPost('/unitsOfMeasure', payload);
      report.push([code, payload.displayName, 'ok', '']);
      ok++;
    } catch (e) {
      report.push([code, payload.displayName, 'error', e.message]);
      err++;
    }
    await sleep(110);
  }
  appendReport(path.join(IMPORTS_DIR, 'Units of Measure.report.csv'), report);
  console.log(`   ok=${ok} skip=${skip} err=${err}`);
  return { ok, skip, err };
}

async function importVendors() {
  console.log('\n🏢 Vendors');
  const rows = readSheet('Vendors.xlsx');
  const existing = (await bcGet('/vendors?$select=number&$top=2000')).value || [];
  const existingNos = new Set(existing.map(v => v.number));
  const report = [['number', 'name', 'status', 'message']];
  let ok = 0, skip = 0, err = 0, written = 0;
  for (const row of rows) {
    if (LIMIT && written >= LIMIT) break;
    const number = (row['No.'] || '').toString().trim();
    const name = (row['Name'] || '').toString();
    if (!number) { report.push(['', name, 'skip', 'empty No.']); skip++; continue; }
    if (existingNos.has(number)) { report.push([number, name, 'skip', 'already exists']); skip++; continue; }
    const payload = {
      number,
      displayName: name || number,
      phoneNumber: (row['Phone No.'] || '').toString(),
    };
    written++;
    if (DRY_RUN) { report.push([number, name, 'dry-run', JSON.stringify(payload)]); ok++; continue; }
    try {
      await bcPost('/vendors', payload);
      report.push([number, name, 'ok', '']);
      ok++;
    } catch (e) {
      report.push([number, name, 'error', e.message]);
      err++;
    }
    await sleep(110);
  }
  appendReport(path.join(IMPORTS_DIR, 'Vendors.report.csv'), report);
  console.log(`   ok=${ok} skip=${skip} err=${err}`);
  return { ok, skip, err };
}

async function importItems() {
  console.log('\n📋 Items');
  const rows = readSheet('Items.xlsx');
  const existing = (await bcGet('/items?$select=number&$top=5000')).value || [];
  const existingNos = new Set(existing.map(v => v.number));
  const report = [['number', 'description', 'status', 'message']];
  let ok = 0, skip = 0, err = 0, written = 0;
  for (const row of rows) {
    if (LIMIT && written >= LIMIT) break;
    const number = (row['No.'] || '').toString().trim();
    const desc = (row['Description'] || '').toString();
    if (!number) { report.push(['', desc, 'skip', 'empty No.']); skip++; continue; }
    if (existingNos.has(number)) { report.push([number, desc, 'skip', 'already exists']); skip++; continue; }
    const baseUoM = (row['Base Unit of Measure'] || '').toString();
    const genPostingGroup = (row['Gen. Prod. Posting Group'] || '').toString();
    const payload = {
      number,
      displayName: desc || number,
      type: (row['Type'] || 'Inventory').toString(),
      baseUnitOfMeasureCode: baseUoM,
      unitPrice: Number(row['Unit Price'] || 0),
      unitCost: Number(row['Unit Cost'] || 0),
      gtin: '',
    };
    if (genPostingGroup) {
      payload.generalProductPostingGroupCode = genPostingGroup;
      payload.inventoryPostingGroupCode = genPostingGroup;
    }
    written++;
    if (DRY_RUN) { report.push([number, desc, 'dry-run', JSON.stringify(payload)]); ok++; continue; }
    try {
      await bcPost('/items', payload);
      report.push([number, desc, 'ok', '']);
      ok++;
    } catch (e) {
      report.push([number, desc, 'error', e.message]);
      err++;
    }
    await sleep(110);
  }
  appendReport(path.join(IMPORTS_DIR, 'Items.report.csv'), report);
  console.log(`   ok=${ok} skip=${skip} err=${err}`);
  return { ok, skip, err };
}

// Second pass: BC API v2.0 doesn't expose Sales/Purch Unit of Measure on the
// Item entity, so we use the OData ItemCard page (table 27 with full fields)
// to PATCH those two columns. Reads Items.xlsx → for each row, GETs the
// matching ItemCard, PATCHes only when Excel differs from Dev.
async function patchItemUoM() {
  console.log('\n🔧 Item Sales/Purch UoM (OData ItemCard)');
  const rows = readSheet('Items.xlsx');
  const report = [['number', 'description', 'status', 'message']];
  let patched = 0, skip = 0, err = 0, written = 0;
  for (const row of rows) {
    if (LIMIT && written >= LIMIT) break;
    const number = (row['No.'] || '').toString().trim();
    const desc = (row['Description'] || '').toString();
    const salesUoM = (row['Sales Unit of Measure'] || '').toString();
    const purchUoM = (row['Purch. Unit of Measure'] || '').toString();
    if (!number) { report.push(['', desc, 'skip', 'empty No.']); skip++; continue; }
    if (!salesUoM && !purchUoM) { report.push([number, desc, 'skip', 'no UoM in source']); skip++; continue; }
    let card;
    try {
      const j = await odataGet(`/ItemCard?$filter=No eq '${number.replace(/'/g, "''")}'&$top=1&$select=No,Sales_Unit_of_Measure,Purch_Unit_of_Measure`);
      card = (j.value || [])[0];
    } catch (e) {
      report.push([number, desc, 'error', 'lookup: ' + e.message]);
      err++;
      continue;
    }
    if (!card) { report.push([number, desc, 'skip', 'not in Dev (insert failed earlier?)']); skip++; continue; }
    const patch = {};
    if (salesUoM && card.Sales_Unit_of_Measure !== salesUoM) patch.Sales_Unit_of_Measure = salesUoM;
    if (purchUoM && card.Purch_Unit_of_Measure !== purchUoM) patch.Purch_Unit_of_Measure = purchUoM;
    if (Object.keys(patch).length === 0) {
      report.push([number, desc, 'skip', 'UoM up-to-date']);
      skip++;
      continue;
    }
    written++;
    if (DRY_RUN) { report.push([number, desc, 'dry-run-patch', JSON.stringify(patch)]); patched++; continue; }
    try {
      // OData PATCH with key in URL: /ItemCard('010001')
      await odataPatch(`/ItemCard('${number.replace(/'/g, "''")}')`, card['@odata.etag'] || '*', patch);
      report.push([number, desc, 'patched', JSON.stringify(patch)]);
      patched++;
    } catch (e) {
      report.push([number, desc, 'error', e.message]);
      err++;
    }
    await sleep(110);
  }
  appendReport(path.join(IMPORTS_DIR, 'Items.uom.report.csv'), report);
  console.log(`   patched=${patched} skip=${skip} err=${err}`);
  return { ok: patched, skip, err };
}

// ─── Main ────────────────────────────────────────────────────────────────
(async () => {
  console.log(`Target: ${ENV} (company ${COMPANY})`);
  if (DRY_RUN) console.log('🛟 DRY RUN — no writes to BC');
  const run = (name) => ONLY.length === 0 || ONLY.includes(name);
  const totals = { ok: 0, skip: 0, err: 0 };
  // UoM first → Vendors → Items (item references UoM via baseUnitOfMeasureCode)
  if (run('uom')) {
    const r = await importUoM();
    totals.ok += r.ok; totals.skip += r.skip; totals.err += r.err;
  }
  if (run('vendors')) {
    const r = await importVendors();
    totals.ok += r.ok; totals.skip += r.skip; totals.err += r.err;
  }
  if (run('items')) {
    const r = await importItems();
    totals.ok += r.ok; totals.skip += r.skip; totals.err += r.err;
  }
  if (run('item-uom') || run('items')) {
    const r = await patchItemUoM();
    totals.ok += r.ok; totals.skip += r.skip; totals.err += r.err;
  }
  console.log(`\n═══ TOTAL ═══`);
  console.log(`OK:   ${totals.ok}`);
  console.log(`Skip: ${totals.skip}`);
  console.log(`Err:  ${totals.err}`);
  console.log(`\nReports in ${IMPORTS_DIR}/`);
})().catch(e => { console.error(e); process.exit(1); });
