// BC snapshot exporter — pull the 3 ERP go-live data groups out of a Business
// Central environment into ONE Excel workbook (1 sheet per entity).
//
//   1) Setup / Configuration   — company info, COA, posting setups, no. series …
//   2) Master Data             — items, vendors, customers, UoM, prices …
//   3) Opening Balances        — trial balance, AR/AP aging, GL entries, stock …
//
// Read-only: only GETs. Every entity is fetched in its own try/catch so a
// missing/unpublished page never aborts the run — its status lands in the
// _INDEX sheet instead. Entities marked `pub:true` are NOT in BC's standard
// /api/v2.0 surface: publish the named page under Web Services in BC, then
// re-run and they fill in. Standard entities should populate as-is.
//
// Usage:
//   node scripts/export-bc-snapshot.js --env=Jiancha_dev2
//   node scripts/export-bc-snapshot.js --env=Jiancha_dev2 setup     # one group
//   node scripts/export-bc-snapshot.js --env=Jiancha_dev2 --max=50000
//   node scripts/export-bc-snapshot.js --env=Jiancha_dev2 --from=2026-01-01  # GL postingDate >=
//   node scripts/export-bc-snapshot.js --env=Jiancha_dev2 --out=imports/snap.xlsx
//
// Output: imports/bc-snapshot-<env>-<timestamp>.xlsx  (imports/ is gitignored)

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const fs = require('fs');
const xlsx = require('xlsx');
const fetch = require('node-fetch');

const arg = (k, d) => {
  const hit = process.argv.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const ENV = arg('env', process.env.BC_ENVIRONMENT);
const MAX = parseInt(arg('max', '200000'), 10);     // row cap per paginated entity
const GL_FROM = arg('from', '');                     // GL postingDate >= this (YYYY-MM-DD)
const OUT = arg('out', '');
const GROUPS = process.argv
  .filter(a => !a.startsWith('--') && a !== process.argv[0] && a !== process.argv[1])
  .map(s => s.toLowerCase());

const TENANT = process.env.BC_TENANT_ID;
const COMPANY = process.env.BC_COMPANY_ID;
const COMPANY_NAME = process.env.BC_COMPANY_NAME;
const CLIENT_ID = process.env.BC_CLIENT_ID;
const SECRET = process.env.BC_CLIENT_SECRET;

if (!TENANT || !ENV || !COMPANY || !CLIENT_ID || !SECRET) {
  console.error('Missing BC_* env vars (need BC_TENANT_ID, BC_COMPANY_ID, BC_CLIENT_ID, BC_CLIENT_SECRET) + --env or BC_ENVIRONMENT in .env');
  process.exit(1);
}

const API_BASE = `https://api.businesscentral.dynamics.com/v2.0/${TENANT}/${ENV}/api/v2.0/companies(${COMPANY})`;
const ODATA_BASE = COMPANY_NAME
  ? `https://api.businesscentral.dynamics.com/v2.0/${TENANT}/${ENV}/ODataV4/Company('${encodeURIComponent(COMPANY_NAME)}')`
  : null;

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

// Follow @odata.nextLink to page through a list endpoint, capped at MAX rows.
async function fetchAll(base, relPath) {
  const t = await token();
  let url = base + relPath;
  const all = [];
  let capped = false;
  for (let guard = 0; url && guard < 1000; guard++) {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + t, Accept: 'application/json' } });
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 300)}`);
    const j = await r.json();
    if (Array.isArray(j.value)) all.push(...j.value);
    else if (j && typeof j === 'object') all.push(j); // single object (e.g. companyInformation)
    if (all.length >= MAX) { all.length = MAX; capped = true; break; }
    url = j['@odata.nextLink'] || null;
  }
  // url still set => we bailed on the page guard before draining nextLink:
  // the pull is incomplete, so flag it like a cap (derivations must not treat
  // a partial GL/item-ledger as authoritative).
  return { rows: all, capped: capped || !!url };
}

// ─── Entity registry ───────────────────────────────────────────────────────
// kind: 'api' = standard /api/v2.0 entity · 'odata' = published OData page
// pub:  true  = NOT in standard API → user must publish this page in BC, then
//               re-run. `path` here is the expected Web Service name.
const ENTITIES = [
  // 1) Setup / Configuration
  { group: 'setup', sheet: 'companyInformation', kind: 'api', path: '/companyInformation' },
  { group: 'setup', sheet: 'accounts',           kind: 'api', path: '/accounts?$top=5000' },
  { group: 'setup', sheet: 'paymentTerms',       kind: 'api', path: '/paymentTerms' },
  { group: 'setup', sheet: 'paymentMethods',     kind: 'api', path: '/paymentMethods' },
  { group: 'setup', sheet: 'currencies',         kind: 'api', path: '/currencies' },
  { group: 'setup', sheet: 'dimensions',         kind: 'api', path: '/dimensions' },
  { group: 'setup', sheet: 'dimensionValues',    kind: 'api', path: '/dimensionValues?$top=5000' },
  { group: 'setup', sheet: 'taxGroups',          kind: 'api', path: '/taxGroups' },
  { group: 'setup', sheet: 'taxAreas',           kind: 'api', path: '/taxAreas' },
  { group: 'setup', sheet: 'shipmentMethods',    kind: 'api', path: '/shipmentMethods' },
  { group: 'setup', sheet: 'unitsOfMeasure',     kind: 'api', path: '/unitsOfMeasure' },
  { group: 'setup', sheet: 'locations',          kind: 'api', path: '/locations' },
  // ⚠ need publishing (names = expected Web Service "Service Name")
  { group: 'setup', sheet: 'GeneralPostingSetup',    kind: 'odata', path: '/GeneralPostingSetup',    pub: true },
  { group: 'setup', sheet: 'VATPostingSetup',        kind: 'odata', path: '/VATPostingSetup',        pub: true },
  { group: 'setup', sheet: 'InventoryPostingSetup',  kind: 'odata', path: '/InventoryPostingSetup',  pub: true },
  { group: 'setup', sheet: 'CustomerPostingGroup',   kind: 'odata', path: '/CustomerPostingGroup',   pub: true },
  { group: 'setup', sheet: 'VendorPostingGroup',     kind: 'odata', path: '/VendorPostingGroup',     pub: true },
  { group: 'setup', sheet: 'InventoryPostingGroup',  kind: 'odata', path: '/InventoryPostingGroup',  pub: true },
  { group: 'setup', sheet: 'GenBusPostingGroup',     kind: 'odata', path: '/GenBusinessPostingGroup', pub: true },
  { group: 'setup', sheet: 'GenProdPostingGroup',    kind: 'odata', path: '/GenProductPostingGroup',  pub: true },
  { group: 'setup', sheet: 'NoSeries',               kind: 'odata', path: '/NoSeries',               pub: true },
  { group: 'setup', sheet: 'NoSeriesLine',           kind: 'odata', path: '/NoSeriesLine',           pub: true },

  // 2) Master Data
  { group: 'master', sheet: 'items',            kind: 'api',   path: '/items' },
  { group: 'master', sheet: 'itemCategories',   kind: 'api',   path: '/itemCategories' },
  { group: 'master', sheet: 'vendors',          kind: 'api',   path: '/vendors?$top=5000' },
  { group: 'master', sheet: 'customers',        kind: 'api',   path: '/customers?$top=5000' },
  { group: 'master', sheet: 'employees',        kind: 'api',   path: '/employees' },
  { group: 'master', sheet: 'bankAccounts',     kind: 'api',   path: '/bankAccounts' },
  { group: 'master', sheet: 'itemCard',         kind: 'odata', path: "/ItemCard?$select=No,Description,Base_Unit_of_Measure,Sales_Unit_of_Measure,Purch_Unit_of_Measure,Gen_Prod_Posting_Group,Inventory_Posting_Group,VAT_Prod_Posting_Group,Item_Category_Code&$top=10000" },
  { group: 'master', sheet: 'itemUnitOfMeasure', kind: 'odata', path: '/ItemUnitOfMeasure?$select=Item_No,Code,Qty_per_Unit_of_Measure&$top=20000' },
  { group: 'master', sheet: 'salesPrices',      kind: 'odata', path: "/SalesPrice?$filter=Item_No ne ''&$top=20000" },
  { group: 'master', sheet: 'fixedAssets',      kind: 'api',   path: '/fixedAssets', pub: true }, // not on every BC version

  // 3) Opening Balances (current snapshot of the env)
  // AR/AP headline balances ride along in the customers (balanceDue) and vendors
  // (balance) sheets above; the ledger pages below add per-entry aging detail.
  // trialBalance + stockByLocation are DERIVED post-fetch (see below) — BC's
  // /trialBalance + /agedAccounts* report APIs 404 on this tenant's /api/v2.0.
  { group: 'balances', sheet: 'generalLedgerEntries',  kind: 'api',   path: '/generalLedgerEntries' + (GL_FROM ? `?$filter=postingDate ge ${GL_FROM}` : '') },
  { group: 'balances', sheet: 'customerLedgerEntries', kind: 'odata', path: '/CustomerLedgerEntries?$top=50000', pub: true }, // AR detail / aging
  { group: 'balances', sheet: 'vendorLedgerEntries',   kind: 'odata', path: '/VendorLedgerEntries?$top=50000',   pub: true }, // AP detail / aging
  { group: 'balances', sheet: 'itemLedgerEntries',     kind: 'odata', path: '/ItemLedgerEntries' }, // per-location stock (already published) — paginated in full via nextLink
];

function flatten(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith('@odata.')) continue;
    if (v === null || v === undefined) out[k] = '';
    else if (typeof v === 'object') out[k] = JSON.stringify(v);
    else out[k] = v;
  }
  return out;
}

function toSheet(rows) {
  const flat = rows.map(flatten);
  const header = [...new Set(flat.flatMap(r => Object.keys(r)))];
  return xlsx.utils.json_to_sheet(flat, { header });
}

(async () => {
  const selected = GROUPS.length ? ENTITIES.filter(e => GROUPS.includes(e.group)) : ENTITIES;
  console.log(`BC snapshot · env=${ENV} · company=${COMPANY_NAME} · ${selected.length} entities\n`);

  const wb = xlsx.utils.book_new();
  const index = [];
  const store = {};
  const CAPTURE = new Set(['accounts', 'itemLedgerEntries']);
  const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

  for (const e of selected) {
    // GL detail is transaction history (200k+ rows) — opt-in only, to keep the
    // workbook focused on balances. The trial balance is derived from
    // accounts.netChange, so it doesn't need the raw GL lines.
    if (e.sheet === 'generalLedgerEntries' && !GL_FROM) {
      index.push({ group: 'balances', sheet: 'generalLedgerEntries', kind: 'api', endpoint: '/generalLedgerEntries', status: 'SKIP', rows: 0, note: 'pass --from=YYYY-MM-DD to include GL detail (TB is from accounts.netChange)' });
      console.log('  SKIP generalLedgerEntries — pass --from=YYYY-MM-DD to include');
      continue;
    }
    const base = e.kind === 'odata' ? ODATA_BASE : API_BASE;
    if (!base) {
      index.push({ group: e.group, sheet: e.sheet, kind: e.kind, endpoint: e.path, status: 'SKIP', rows: 0, note: 'BC_COMPANY_NAME not set (OData unavailable)' });
      continue;
    }
    try {
      const { rows, capped } = await fetchAll(base, e.path);
      if (CAPTURE.has(e.sheet)) store[e.sheet] = { rows, capped };
      const note = capped ? `CAPPED at --max=${MAX}` : '';
      if (rows.length) {
        xlsx.utils.book_append_sheet(wb, toSheet(rows), e.sheet.slice(0, 31));
      }
      index.push({ group: e.group, sheet: e.sheet, kind: e.kind, endpoint: e.path, status: rows.length ? 'OK' : 'EMPTY', rows: rows.length, note });
      console.log(`  ${rows.length ? 'OK  ' : 'EMPTY'} ${e.sheet.padEnd(24)} ${rows.length} rows ${note}`);
    } catch (err) {
      const msg = String(err.message || err).slice(0, 200);
      const needsPub = e.pub && /\b40[34]\b|not found|does not exist|could not find/i.test(msg);
      index.push({
        group: e.group, sheet: e.sheet, kind: e.kind, endpoint: e.path,
        status: needsPub ? 'NEEDS PUBLISH' : 'ERROR',
        rows: 0,
        note: needsPub ? `Publish page in BC Web Services as "${e.path.split('?')[0].replace('/', '')}", then re-run` : msg,
      });
      console.log(`  ${needsPub ? 'PUB ' : 'ERR '} ${e.sheet.padEnd(24)} ${needsPub ? 'publish page then re-run' : msg}`);
    }
  }

  // ─── Derived sheets (post-fetch aggregations) ───────────────────────────
  const appendDerived = (sheet, rows, note) => {
    if (!rows.length) return;
    xlsx.utils.book_append_sheet(wb, toSheet(rows), sheet.slice(0, 31));
    index.push({ group: 'balances', sheet, kind: 'derived', endpoint: '(computed)', status: 'OK', rows: rows.length, note });
    console.log(`  DERV ${sheet.padEnd(24)} ${rows.length} rows ${note}`);
  };

  // Trial balance — current net balance per account from the G/L Account
  // `netChange` flowfield. With no date filter BC sums it server-side over all
  // dates, so it's the authoritative current balance — no need to drain 200k+
  // GL lines. sum across accounts should be ~0 if the books balance.
  if (store.accounts?.rows?.length) {
    const tb = store.accounts.rows
      .filter(a => round2(a.netChange) !== 0)
      .map(a => ({ accountNumber: a.number, accountName: a.displayName, category: a.category, accountType: a.accountType, netChange: round2(a.netChange) }))
      .sort((a, b) => String(a.accountNumber).localeCompare(String(b.accountNumber)));
    const check = round2(tb.reduce((s, r) => s + r.netChange, 0));
    appendDerived('trialBalance', tb, `BC netChange per account · sum=${check} (~0 = balanced)`);
  }

  // Stock on hand by item × location, from item ledger entries.
  const il = store.itemLedgerEntries;
  if (il && !il.capped && il.rows.length) {
    const agg = new Map();
    for (const e of il.rows) {
      const k = `${e.Item_No}|${e.Location_Code}`;
      const c = agg.get(k) || { Item_No: e.Item_No, Item_Description: e.Item_Description, Location_Code: e.Location_Code, Remaining_Quantity: 0, Cost_Amount_Actual: 0 };
      c.Remaining_Quantity += Number(e.Remaining_Quantity) || 0;
      c.Cost_Amount_Actual += Number(e.Cost_Amount_Actual) || 0;
      agg.set(k, c);
    }
    const stock = [...agg.values()]
      .map(r => ({ ...r, Remaining_Quantity: round2(r.Remaining_Quantity), Cost_Amount_Actual: round2(r.Cost_Amount_Actual) }))
      .filter(r => r.Remaining_Quantity !== 0 || r.Cost_Amount_Actual !== 0)
      .sort((a, b) => a.Item_No === b.Item_No ? String(a.Location_Code).localeCompare(String(b.Location_Code)) : String(a.Item_No).localeCompare(String(b.Item_No)));
    appendDerived('stockByLocation', stock, 'sum remaining qty + actual cost per item x location');
  } else if (il && il.capped) {
    index.push({ group: 'balances', sheet: 'stockByLocation', kind: 'derived', endpoint: '(computed)', status: 'SKIP', rows: 0, note: 'itemLedgerEntries capped — re-run with higher --max' });
  }

  // _INDEX first so it's the landing tab
  const idxWs = xlsx.utils.json_to_sheet(index, { header: ['group', 'sheet', 'kind', 'status', 'rows', 'endpoint', 'note'] });
  wb.SheetNames.unshift('_INDEX');
  wb.Sheets['_INDEX'] = idxWs;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = OUT || path.join(__dirname, '..', 'imports', `bc-snapshot-${ENV}-${stamp}.xlsx`);
  xlsx.writeFile(wb, outPath);

  const ok = index.filter(i => i.status === 'OK').length;
  const pub = index.filter(i => i.status === 'NEEDS PUBLISH').length;
  const err = index.filter(i => i.status === 'ERROR').length;
  console.log(`\nWrote ${outPath}`);
  console.log(`Summary: ${ok} OK · ${index.filter(i => i.status === 'EMPTY').length} empty · ${pub} need publish · ${err} error`);
})().catch(e => { console.error(e); process.exit(1); });
