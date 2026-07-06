// Seed default vendor per fresh-goods item (Phase 1 vendor-based PO).
// Idempotent — safe to re-run. Vendor mapping is from the ops "fresh goods"
// sheet (2026-07). Kept in JC-Market (items_cache.vendor_no) because BC
// Item.Vendor_No is empty today; PO creation routes to these vendors instead
// of the single BC_DEFAULT_VENDOR_NO. All vendor codes verified to exist in BC
// (SP004 = ดัชมิลล์; the sheet's "SP0004" had an extra zero).
//
//   node scripts/seed-fresh-vendors.js
const db = require('../db');

// All 'Fruit fresh' items → SP163 (ทรีดี ฟู้ด, the single fruit supplier). The
// ops sheet lists 11 but the category carries more seasonal fruit (peach/mango/
// kiwi/avocado/strawberry/mulberry/muscat) — same supplier, so map the whole
// category. Keeps the cart from splitting fruit across two vendor groups.
const setFruit = db.prepare("UPDATE items_cache SET vendor_no='SP163' WHERE category='Fruit fresh'");

// Explicit item→vendor for goods whose BC category isn't 'Fruit fresh':
//   - lychee (010042/010043) have an empty category in BC
//   - 030xxx dairy/cream/ice · 130xxx bakery
const EXPLICIT = {
  SP163: ['010042', '010043'],                 // lychee — empty category, seed directly
  SP023: ['030024'],                           // นมสด — มาลี เอ็นเตอร์ไพรส์
  SP162: ['030081'],                           // นมสดเมจิ — ซีพี-เมจิ
  SP011: ['030012'],                           // ครีมเทียมชนิดน้ำ (ice hot) — ริช โปรดักส์
  SP036: ['030013', '030014'],                 // ครีมชีส + วิปปิ้งครีม — โกลเบิล พรีเมี่ยม ไวน์
  SP004: ['030019'],                           // โยเกิร์ต — ดัชมิลล์
  SP053: ['130007', '130009', '130010', '130011', '130012', '130022'], // bakery — Hourse Of Croissants
};

const upd = db.prepare('UPDATE items_cache SET vendor_no=? WHERE item_no=?');
let fruitN = 0, explicitN = 0;
const missing = [];
const tx = db.transaction(() => {
  fruitN = setFruit.run().changes;
  for (const [vendor, items] of Object.entries(EXPLICIT)) {
    for (const no of items) {
      const r = upd.run(vendor, no);
      if (r.changes) explicitN++; else missing.push(no);
    }
  }
});
tx();

console.log(`seeded: ${fruitN} fruit → SP163, ${explicitN} explicit items`);
if (missing.length) console.log('NOT in items_cache (skipped):', missing.join(', '));

const rows = db.prepare("SELECT vendor_no, COUNT(*) n FROM items_cache WHERE vendor_no!='' GROUP BY vendor_no ORDER BY vendor_no").all();
console.log('\nvendor_no coverage:');
rows.forEach(r => console.log(`  ${r.vendor_no}: ${r.n} items`));
