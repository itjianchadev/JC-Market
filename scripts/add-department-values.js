// Add missing DEPARTMENT dimension values (branch codes) to BC so orders can
// stamp Department = branch_code (Phase 1 vendor-based PO). Read-only by default
// (lists what's missing); pass --commit to POST them. dev2 ONLY (refuses prod).
//
//   node scripts/add-department-values.js            # dry-run (safe)
//   node scripts/add-department-values.js --commit   # write to BC
const ROOT = __dirname + '/..';
require(ROOT + '/node_modules/dotenv').config({ path: ROOT + '/.env' });
const fetch = require(ROOT + '/node_modules/node-fetch');
const bc = require(ROOT + '/bc-client');
const db = require(ROOT + '/db');
const E = process.env;
const ENV = E.BC_ENVIRONMENT || '';
if (ENV.toLowerCase().includes('production')) { console.error('REFUSE: BC_ENVIRONMENT=production — dev2 only'); process.exit(1); }
const COMMIT = process.argv.includes('--commit');
const AB = E.BC_API_BASE || 'https://api.businesscentral.dynamics.com/v2.0';
const API = `${AB}/${E.BC_TENANT_ID}/${ENV}/api/v2.0/companies(${E.BC_COMPANY_ID})`;
const OD = `${AB}/${E.BC_TENANT_ID}/${ENV}/ODataV4/Company('${encodeURIComponent(E.BC_COMPANY_NAME)}')`;
const DEPT_ID = '3f089041-753c-f011-be59-000d3ac901b1'; // DEPARTMENT dimension (dev2)
// OData web service for Page 538 "Dimension Values" — must be published in BC
// (Web Services → Page 538 → set a service name). API v2.0 dimensionValues is
// read-only (405 on insert), so writes go through this OData page instead.
const SERVICE = process.env.BC_WS_DIMENSION_VALUE || 'DimensionValues';

async function req(url, opts = {}) {
  const t = await bc.getToken();
  const r = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + t, Accept: 'application/json', 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  return { ok: r.ok, s: r.status, b: await r.text() };
}

(async () => {
  console.log('ENV:', ENV, '| mode:', COMMIT ? 'COMMIT' : 'dry-run');
  const r = await req(`${API}/dimensions(${DEPT_ID})/dimensionValues?$top=500`);
  if (!r.ok) { console.error('fetch DEPARTMENT failed:', r.s, r.b.slice(0, 200)); process.exit(1); }
  const existing = new Set((JSON.parse(r.b).value || []).map(v => v.code));
  console.log('DEPARTMENT existing values:', existing.size);

  const branches = db.prepare("SELECT code, name FROM branches WHERE code != '' AND active = 1 ORDER BY code").all();
  const missing = branches.filter(b => !existing.has(b.code));
  console.log(`branches (active): ${branches.length} | missing in DEPARTMENT: ${missing.length}`);
  missing.forEach(b => console.log('  +', b.code, '—', b.name || b.code));

  if (!missing.length) { console.log('\nnothing to add.'); return; }
  if (!COMMIT) { console.log('\n(dry-run — re-run with --commit to POST these to BC dev2)'); return; }

  console.log('\nPOSTing to BC dev2...');
  let ok = 0, fail = 0;
  for (const b of missing) {
    const res = await req(`${OD}/${SERVICE}`, {
      method: 'POST', body: JSON.stringify({ Dimension_Code: 'DEPARTMENT', Code: b.code, Name: (b.name || b.code).slice(0, 50) }),
    });
    if (res.ok) { ok++; console.log('  OK  ', b.code); }
    else { fail++; console.log('  FAIL', b.code, res.s, res.b.slice(0, 150)); }
  }
  console.log(`\ndone: ${ok} added, ${fail} failed`);
})();
