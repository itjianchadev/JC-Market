// Quick ERP go-live readiness analysis over a bc-snapshot workbook.
// Reads the latest (or --file=) snapshot and prints the key data-quality gaps.
//   node scripts/analyze-snapshot-readiness.js
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

const arg = (k, d) => {
  const h = process.argv.find(a => a.startsWith(`--${k}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
let file = arg('file', '');
if (!file) {
  const dir = path.join(__dirname, '..', 'imports');
  const snaps = fs.readdirSync(dir)
    .filter(f => /^bc-snapshot-.*\.xlsx$/.test(f))
    .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!snaps.length) { console.error('no snapshot found'); process.exit(1); }
  file = path.join(dir, snaps[0].f);
}
console.log('Analyzing:', path.basename(file), '\n');

const wb = xlsx.readFile(file);
const sheet = n => (wb.Sheets[n] ? xlsx.utils.sheet_to_json(wb.Sheets[n]) : null);
const blank = v => v === undefined || v === null || String(v).trim() === '';
const pct = (n, d) => d ? `${Math.round((n / d) * 1000) / 10}%` : '-';

// 1) Vendors — tax reg (WHT / ภงด.)
const vendors = sheet('vendors') || [];
const vNoTax = vendors.filter(v => blank(v.taxRegistrationNumber));
console.log(`VENDORS: ${vendors.length} total · missing taxRegistrationNumber: ${vNoTax.length} (${pct(vNoTax.length, vendors.length)})`);

// 2) Customers — tax reg (billing / e-tax)
const customers = sheet('customers') || [];
const cNoTax = customers.filter(c => blank(c.taxRegistrationNumber));
console.log(`CUSTOMERS: ${customers.length} total · missing taxRegistrationNumber: ${cNoTax.length} (${pct(cNoTax.length, customers.length)})`);

// 3) Items — price, blocked, posting groups
const items = sheet('items') || [];
const zeroPrice = items.filter(i => Number(i.unitPrice || 0) === 0);
const blocked = items.filter(i => i.blocked === true || i.blocked === 'true' || i.itemBlocked === true);
console.log(`ITEMS: ${items.length} total · unitPrice=0: ${zeroPrice.length} (${pct(zeroPrice.length, items.length)}) · blocked: ${blocked.length}`);

// 3b) itemCard — posting group coverage (Gen_Prod / Inventory / VAT_Prod)
const itemCard = sheet('itemCard') || [];
const missGPP = itemCard.filter(i => blank(i.Gen_Prod_Posting_Group));
const missIPG = itemCard.filter(i => blank(i.Inventory_Posting_Group));
const missVPP = itemCard.filter(i => blank(i.VAT_Prod_Posting_Group));
console.log(`ITEM POSTING GROUPS (itemCard ${itemCard.length}): missing Gen.Prod ${missGPP.length} · Inventory ${missIPG.length} · VAT.Prod ${missVPP.length}`);

// 4) Stock by location — in-transit duplication + location spread
const stock = sheet('stockByLocation') || [];
const byLoc = {};
for (const r of stock) {
  const k = r.Location_Code || '(blank)';
  byLoc[k] = byLoc[k] || { qty: 0, cost: 0, lines: 0 };
  byLoc[k].qty += Number(r.Remaining_Quantity || 0);
  byLoc[k].cost += Number(r.Cost_Amount_Actual || 0);
  byLoc[k].lines++;
}
console.log(`\nLOCATIONS with stock (${Object.keys(byLoc).length}):`);
Object.entries(byLoc).sort((a, b) => b[1].cost - a[1].cost).forEach(([k, v]) =>
  console.log(`  ${String(k).padEnd(14)} lines ${String(v.lines).padStart(5)} · qty ${Math.round(v.qty).toLocaleString().padStart(12)} · cost ${Math.round(v.cost).toLocaleString().padStart(14)}`));
const intransit = Object.keys(byLoc).filter(k => /^IN-?TRANSIT$/i.test(k));
if (intransit.length > 1) console.log(`  >> IN-TRANSIT DUPLICATED across: ${intransit.join(' + ')} (consolidate before go-live)`);

// 5) Sales prices
const sp = sheet('salesPrices') || [];
console.log(`\nSALES PRICES: ${sp.length} rows`);

// 6) Empty / skipped entities from _INDEX
const idx = sheet('_INDEX') || [];
const notOk = idx.filter(r => r.status && !['OK'].includes(r.status));
console.log(`\n_INDEX non-OK entities:`);
notOk.forEach(r => console.log(`  ${String(r.status).padEnd(14)} ${r.sheet}  ${r.note || ''}`));

// 7) Locations master vs Inventory Posting Setup coverage
const locs = sheet('locations') || [];
const ips = sheet('InventoryPostingSetup') || [];
const ipsLocs = new Set(ips.map(r => r.Location_Code || r.locationCode).filter(Boolean));
const locsNoIPS = locs.filter(l => !ipsLocs.has(l.code));
console.log(`\nLOCATIONS master: ${locs.length} · with Inventory Posting Setup rows: ${ipsLocs.size}` +
  (locsNoIPS.length ? ` · WITHOUT setup: ${locsNoIPS.map(l => l.code).join(', ')}` : ' · all covered'));
