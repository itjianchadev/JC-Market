// Clear all TRANSACTIONAL test data for a clean go-live, keeping master data.
//
// KEEPS: branches, items_cache (BC sync), license_info, users (handle those via
//        seed-real-users.js), sync_log.
// CLEARS: orders + every downstream fulfilment / payment / TMS row.
//
//   node scripts/clear-test-data.js            # dry-run (shows counts)
//   node scripts/clear-test-data.js --yes      # apply
//
// Respects DB_PATH via db.js. Children deleted before parents so it works
// whether or not FK enforcement is on.

const db = require('../db');

const APPLY = process.argv.includes('--yes');

// Ordered children → parents. carriers/drivers are referenced by trips/pods,
// so they must be deleted LAST (after trips, pods, driver_pings are gone).
const CLEAR = [
  // fulfilment / delivery events
  'driver_pings', 'pod_photos', 'pods',
  'goods_receipt_lines', 'goods_receipts',
  'stock_issue_lines', 'stock_issues',
  'shipments', 'trips',
  // billing / payment
  'payment_receipts', 'slip_fraud_log',
  'shipping_invoices', 'sale_billing_payments', 'credit_invoices',
  'payments',
  // orders / cart
  'cart_items', 'order_lines', 'orders',
  // per-branch test settings
  'branch_item_settings',
  // TMS master (referenced by trips/pods above — delete last)
  'carrier_driver_phones', 'carrier_drivers', 'carriers',
];

const KEEP = ['branches', 'items_cache', 'license_info', 'users', 'sync_log'];

function count(t) {
  try { return db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n; } catch { return null; }
}

console.log('=== BEFORE ===');
let total = 0;
for (const t of CLEAR) { const n = count(t); total += n || 0; console.log(`  ${t.padEnd(24)} ${n === null ? 'MISSING' : n}`); }
console.log(`  ${'—'.repeat(24)} total ${total} rows to delete`);
console.log('KEEP:', KEEP.map((t) => `${t}(${count(t)})`).join(', '));

if (!APPLY) {
  console.log('\nDRY-RUN. Re-run with --yes to apply.');
  process.exit(0);
}

const wipe = db.transaction(() => {
  for (const t of CLEAR) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch (e) { console.warn(`  skip ${t}: ${e.message}`); }
  }
});
wipe();

console.log('\n=== AFTER ===');
for (const t of CLEAR) console.log(`  ${t.padEnd(24)} ${count(t)}`);
console.log('\nDone. Master data (branches, items, license, users) untouched.');
