// BC Web Services diagnostic — list what's actually published as OData in an
// environment, and probe specific service names for reachability. Read-only.
//
//   node scripts/bc-list-services.js --env=Jiancha_dev2
//   node scripts/bc-list-services.js --env=Jiancha_dev2 --probe=GeneralPostingSetup,NoSeries
//
// Reads the OData $metadata (authoritative entity-set list) + the service
// document, then GETs each expected/--probe name and prints its HTTP status so
// a name/env/company mismatch is obvious.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fetch = require('node-fetch');

const arg = (k, d) => {
  const h = process.argv.find(a => a.startsWith(`--${k}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const ENV = arg('env', process.env.BC_ENVIRONMENT);
const T = process.env.BC_TENANT_ID, CN = process.env.BC_COMPANY_NAME;
const CID = process.env.BC_CLIENT_ID, S = process.env.BC_CLIENT_SECRET;
const ODATA = `https://api.businesscentral.dynamics.com/v2.0/${T}/${ENV}/ODataV4/Company('${encodeURIComponent(CN)}')`;

const DEFAULT_PROBE = [
  'GeneralPostingSetup', 'VATPostingSetup', 'InventoryPostingSetup',
  'CustomerPostingGroup', 'VendorPostingGroup', 'InventoryPostingGroup',
  'GenBusinessPostingGroup', 'GenProductPostingGroup', 'NoSeries',
  'NoSeriesLine', 'CustomerLedgerEntries',
  // known-good controls (these already work — confirms env/company/auth are fine)
  'ItemCard', 'VendorLedgerEntries',
];
const probes = (arg('probe', '') || '').split(',').filter(Boolean);
const PROBE = probes.length ? probes : DEFAULT_PROBE;

async function token() {
  const r = await fetch(`https://login.microsoftonline.com/${T}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials', client_id: CID, client_secret: S,
      scope: 'https://api.businesscentral.dynamics.com/.default',
    }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('Auth failed: ' + JSON.stringify(j));
  return j.access_token;
}

(async () => {
  const tok = await token();
  const H = { Authorization: 'Bearer ' + tok, Accept: 'application/json' };
  console.log(`ENV=${ENV} · company=${CN}\n`);

  // 1) service document
  let svc = [];
  try {
    const r = await fetch(ODATA + '/', { headers: H });
    if (r.ok) { const j = await r.json(); svc = (j.value || []).map(s => s.name); }
    else console.log(`service-doc → HTTP ${r.status}`);
  } catch (e) { console.log('service-doc error: ' + e.message); }

  // 2) $metadata (XML) — usually the authoritative list
  let meta = [];
  try {
    const r = await fetch(ODATA + '/$metadata', { headers: { Authorization: 'Bearer ' + tok, Accept: 'application/xml' } });
    if (r.ok) { const xml = await r.text(); meta = [...xml.matchAll(/EntitySet Name="([^"]+)"/g)].map(m => m[1]); }
    else console.log(`$metadata → HTTP ${r.status}`);
  } catch (e) { console.log('$metadata error: ' + e.message); }

  const all = [...new Set([...svc, ...meta])].sort();
  console.log(`Published OData services (service-doc:${svc.length}, metadata:${meta.length}, union:${all.length}):`);
  all.forEach(n => console.log('  ' + n));

  // 3) direct probe per expected name
  console.log('\nProbe (GET each name ?$top=1):');
  for (const name of PROBE) {
    try {
      const r = await fetch(`${ODATA}/${encodeURIComponent(name)}?$top=1`, { headers: H });
      console.log(`  ${String(r.status).padEnd(3)} ${r.status === 200 ? 'OK  ' : '    '}${name}`);
    } catch (e) {
      console.log(`  ERR ${name}: ${e.message}`);
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
