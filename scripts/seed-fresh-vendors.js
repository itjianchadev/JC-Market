// Seed default vendor per fresh-goods item (Phase 1 vendor-based PO).
// Idempotent — safe to re-run. Vendor mapping is from the ops "fresh goods"
// sheet (2026-07). Kept in JC-Market (items_cache.vendor_no) because BC
// Item.Vendor_No is empty today; PO creation routes to these vendors instead
// of the single BC_DEFAULT_VENDOR_NO. All 7 vendor codes verified to exist in
// BC (SP004 = ดัชมิลล์; the sheet's "SP0004" had an extra zero).
//
//   node scripts/seed-fresh-vendors.js
const db = require('../db');

const MAP = {
  SP163: ['010001', '010002', '010003', '010004', '010008', '010010', '010011', '010012', '010016', '010042', '010043'], // ผลไม้สด — ทรีดี ฟู้ด
  SP023: ['030024'], // นมสด — มาลี เอ็นเตอร์ไพรส์
  SP162: ['030081'], // นมสดเมจิ (สาขาขายไอติม) — ซีพี-เมจิ
  SP011: ['030012'], // ครีมเทียมชนิดน้ำ (ice hot) — ริช โปรดักส์
  SP036: ['030013', '030014'], // ครีมชีส + วิปปิ้งครีม — โกลเบิล พรีเมี่ยม ไวน์
  SP004: ['030019'], // โยเกิร์ต — ดัชมิลล์
  SP053: ['130007', '130009', '130010', '130011', '130012', '130022'], // bakery ครัวซองต์ — Hourse Of Croissants
};

const upd = db.prepare('UPDATE items_cache SET vendor_no=? WHERE item_no=?');
let set = 0;
const missing = [];
const tx = db.transaction(() => {
  for (const [vendor, items] of Object.entries(MAP)) {
    for (const no of items) {
      const r = upd.run(vendor, no);
      if (r.changes) set++; else missing.push(no);
    }
  }
});
tx();

console.log(`seeded vendor_no on ${set} items`);
if (missing.length) console.log('NOT in items_cache (skipped):', missing.join(', '));

const rows = db.prepare("SELECT vendor_no, COUNT(*) n FROM items_cache WHERE vendor_no!='' GROUP BY vendor_no ORDER BY vendor_no").all();
console.log('\nvendor_no coverage:');
rows.forEach(r => console.log(`  ${r.vendor_no}: ${r.n} items`));
