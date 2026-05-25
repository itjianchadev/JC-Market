/**
 * Verify the PO directUnitCost fix end-to-end against the real BC dev tenant.
 * Usage: node scripts/test-po-autofill.js <order_id>
 *
 * 1. Reads the given verified order + lines from SQLite.
 * 2. Creates a real Purchase Order in BC using items_cache.unit_cost as
 *    directUnitCost (mirrors postPOToBC in server.js but skips the DB write
 *    so a regression run doesn't poison the order's bc_po_no).
 * 3. Reads the PO lines back from BC and prints what BC stored.
 *
 * Pass: bc_directUnitCost > 0 AND ≠ line.unit_price (rules out the old bug
 * where the SO sales price leaked onto the PO).
 *
 * Side effect: creates a real BC PO each run — delete in BC if you want a
 * clean Dev tenant. The PO No is printed at the end so cleanup is easy.
 */
require('dotenv').config();
const Database = require('better-sqlite3');
const path = require('path');
const bc = require('../bc-client');

const db = new Database(path.join(__dirname, '..', 'data', 'stock-market.db'));

async function postPOToBC(orderId, vendorNo) {
  // Mirror of server.js postPOToBC — kept minimal for the test harness
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!order) throw new Error('Order not found');
  if (order.order_type !== 'jc_purchase' && !order.bc_so_no) {
    throw new Error('Order ยังไม่มี BC SO');
  }
  if (order.bc_po_no) return { already: true, bc_po_id: order.bc_po_id, bc_po_no: order.bc_po_no };
  vendorNo = (vendorNo || process.env.BC_DEFAULT_VENDOR_NO || '').trim();
  if (!vendorNo) throw new Error('ไม่มี vendor');

  const lines = db.prepare('SELECT * FROM order_lines WHERE order_id=?').all(orderId);
  if (!lines.length) throw new Error('Order has no lines');

  const po = await bc.createPurchaseOrder({ vendorNumber: vendorNo });
  const poId = po.id;
  const poNo = po.number || '';

  for (const line of lines) {
    const item = db.prepare('SELECT id, unit_cost FROM items_cache WHERE item_no=?').get(line.item_no);
    const created = await bc.addPurchaseOrderLine(poId, {
      itemId: item ? item.id : undefined,
      lineType: 'Item',
      quantity: line.quantity,
      description: line.item_name,
    });
    const desiredCost = item ? (item.unit_cost || 0) : 0;
    if (desiredCost > 0 && created && created.id && created['@odata.etag']) {
      await bc.patchPurchaseOrderLine(poId, created.id, created['@odata.etag'], {
        directUnitCost: desiredCost,
      });
    }
  }

  return { ok: true, bc_po_id: poId, bc_po_no: poNo, vendor_no: vendorNo };
}

(async () => {
  const orderId = process.argv[2];
  if (!orderId) {
    console.error('Usage: node scripts/test-po-autofill.js <order_id>');
    process.exit(1);
  }

  const order = db.prepare('SELECT id, order_number, branch_code, bc_so_no, bc_po_no FROM orders WHERE id=?').get(orderId);
  console.log('Order:', order);

  const lines = db.prepare('SELECT item_no, item_name, quantity, unit_price FROM order_lines WHERE order_id=?').all(orderId);
  console.log('Sales-side line prices (what the OLD buggy code set as directUnitCost):');
  console.table(lines.map(l => ({ item: l.item_no, name: l.item_name.slice(0, 30), qty: l.quantity, old_directUnitCost: l.unit_price })));

  console.log('\nCreating PO (directUnitCost pulled from items_cache.unit_cost)...');
  const result = await postPOToBC(orderId);
  console.log('Result:', result);

  console.log('\nReading PO lines back from BC...');
  const back = await bc.getPurchaseOrderLines(result.bc_po_id);
  const rows = (back.value || []).map(l => ({
    item: l.itemId ? '(itemId)' : l.lineObjectNumber,
    qty: l.quantity,
    bc_directUnitCost: l.directUnitCost,
    bc_lineAmount: l.amountExcludingTax,
  }));
  console.table(rows);

  console.log('\nNOTE: PO created in BC for test. Not saved to local DB — delete it manually in BC if you want to tidy up.');
  console.log('PO ID:', result.bc_po_id);
  console.log('PO No:', result.bc_po_no);
})().catch(e => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
