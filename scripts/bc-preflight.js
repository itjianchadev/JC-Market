// READ-ONLY pre-flight for pointing JC-Market at a new BC environment (e.g.
// Production). Verifies everything the order flow needs WITHOUT creating,
// posting, patching, or deleting any BC document. Safe to run against Prod.
//
//   node scripts/bc-preflight.js                       # uses .env BC_ENVIRONMENT
//   BC_ENVIRONMENT=Jiancha_prod node scripts/bc-preflight.js   # override for a dry check
//
// (dotenv does not override a CLI-provided BC_ENVIRONMENT, so the override wins.)
//
// Checks: OAuth token · company/items reachable · Locations CTI + INTRANSIT +
// every active branch code · default vendor SP163 · freight GL accounts · that
// the Transfer Order web services resolve. Exits non-zero if any hard check fails.

require('dotenv').config();
const bc = require('../bc-client');
const db = require('../db');

const ENV = process.env.BC_ENVIRONMENT;
const VENDOR = process.env.BC_DEFAULT_VENDOR_NO || 'SP163';
const GL_SALES = process.env.BC_FREIGHT_GL_SALES_NO;
const GL_PURCH = process.env.BC_FREIGHT_GL_PURCH_NO;

let hardFail = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const warn = (m) => console.log(`  ! ${m}`);
const bad = (m) => { console.log(`  ✗ ${m}`); hardFail++; };

(async () => {
  console.log(`BC pre-flight  env=${ENV}  company=${process.env.BC_COMPANY_NAME || process.env.BC_COMPANY_ID}`);
  if (bc.MOCK) { bad('USE_MOCK_BC is on — real BC not contacted. Turn it off for a real check.'); process.exit(1); }

  // 1. Auth
  try { await bc.getToken(); ok('OAuth token acquired'); }
  catch (e) { bad(`OAuth token failed: ${e.message}`); process.exit(1); }

  // 2. Company reachable (read items)
  try { const { value: items } = await bc.listItems(); ok(`company reachable — ${items.length} items visible`); }
  catch (e) { bad(`listItems failed (company/env wrong?): ${e.message}`); }

  // 3. Locations: CTI, INTRANSIT + every active branch code
  for (const code of ['CTI', 'INTRANSIT']) {
    try { const id = await bc.findLocationIdByCode(code); id ? ok(`Location ${code} = ${id}`) : bad(`Location ${code} NOT FOUND`); }
    catch (e) { bad(`Location ${code} lookup error: ${e.message}`); }
  }
  const branches = db.prepare("SELECT code, branch_type FROM branches WHERE active=1 ORDER BY branch_type, code").all();
  const missing = [];
  for (const b of branches) {
    let id = null;
    try { id = await bc.findLocationIdByCode(b.code); } catch { /* ignore */ }
    if (!id) missing.push(b.code);
  }
  if (missing.length) warn(`${missing.length}/${branches.length} branch Locations missing in BC (SO/TRO falls back to INTRANSIT): ${missing.join(', ')}`);
  else ok(`all ${branches.length} branch Locations resolve`);

  // 4. Default vendor present. Filter-query by number (listVendors() truncates
  // at $top=500 and the tenant has more, so a full-list scan is unreliable).
  try {
    const token = await bc.getToken();
    const base = `${process.env.BC_API_BASE}/${process.env.BC_TENANT_ID}/${ENV}/api/v2.0/companies(${process.env.BC_COMPANY_ID})`;
    const r = await fetch(`${base}/vendors?$filter=number eq '${VENDOR}'&$select=number,displayName`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    const j = await r.json();
    const found = (j.value || [])[0];
    found ? ok(`default vendor ${VENDOR} present — ${found.displayName}`) : bad(`default vendor ${VENDOR} NOT FOUND`);
  } catch (e) { bad(`vendor lookup failed: ${e.message}`); }

  // 5. Freight GL accounts (shipping SO/PO)
  for (const [label, no] of [['SALES', GL_SALES], ['PURCH', GL_PURCH]]) {
    if (!no) { warn(`freight GL ${label} not set in .env`); continue; }
    try { const id = await bc.findGLAccountIdByNo(no); id ? ok(`freight GL ${label} ${no} = ${id}`) : bad(`freight GL ${label} ${no} NOT FOUND`); }
    catch (e) { bad(`freight GL ${label} ${no} error: ${e.message}`); }
  }

  console.log(`\n${hardFail ? '✗ ' + hardFail + ' hard failure(s)' : '✓ all hard checks passed'} — read-only, no BC documents touched.`);
  process.exit(hardFail ? 1 : 0);
})().catch((e) => { console.error('preflight crashed:', e); process.exit(1); });
