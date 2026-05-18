/**
 * Item Sync Service — ดึงสินค้าจาก D365 BC มา cache ใน SQLite
 * ถ้า MOCK mode จะ refresh mock data (inventory สุ่มเปลี่ยน)
 */
const db = require('./db');
const bc = require('./bc-client');
const crypto = require('crypto');

async function syncItems() {
  const start = Date.now();
  try {
    if (bc.MOCK) {
      // Mock: สุ่มปรับ inventory เล็กน้อย เพื่อจำลองการ sync
      const items = db.prepare('SELECT item_no, inventory FROM items_cache').all();
      const upd = db.prepare("UPDATE items_cache SET inventory=?, synced_at=datetime('now','localtime') WHERE item_no=?");
      const tx = db.transaction(() => {
        for (const it of items) {
          const change = Math.floor(Math.random() * 5) - 1; // -1 to +3
          const newInv = Math.max(0, it.inventory + change);
          upd.run(newInv, it.item_no);
        }
      });
      tx();
      logSync('items', 'ok', `Mock sync: ${items.length} items refreshed`, items.length);
      return { ok: true, count: items.length, mode: 'mock', ms: Date.now() - start };
    }

    // ─── LIVE: ดึงจาก BC ───
    // /items = id, inventory(base UoM), base UoM | ItemCard = Purch. UoM | SalesPrice = Unit Price | ItemUoM = qty per base (สำหรับแปลงหน่วย)
    const [result, catResult, cardResult, spResult, iumResult] = await Promise.all([
      bc.listItems(),
      bc.listItemCategories(),
      bc.listItemCards().catch(e => { console.warn('[sync] ItemCard OData failed:', e.message); return { value: [] }; }),
      bc.listSalesPrices().catch(e => { console.warn('[sync] SalesPrice OData failed:', e.message); return { value: [] }; }),
      bc.listItemUnitsOfMeasure().catch(e => { console.warn('[sync] ItemUnitOfMeasure OData failed:', e.message); return { value: [] }; }),
    ]);
    const bcItems = result.value || [];
    if (!bcItems.length) {
      logSync('items', 'ok', 'BC returned 0 items', 0);
      return { ok: true, count: 0, mode: 'live', ms: Date.now() - start };
    }

    // Build category code → displayName map
    const catMap = {};
    for (const c of (catResult.value || [])) {
      catMap[c.code] = c.displayName || c.code;
    }

    // Build item No. → Purch. UoM map
    const purchUomMap = {};
    for (const card of (cardResult.value || [])) {
      if (card.No) purchUomMap[card.No] = card.Purch_Unit_of_Measure || '';
    }

    // Build item No. → { uomCode → qtyPerBase } map (สำหรับแปลง inventory จาก base → purch UoM)
    const uomConvMap = {};
    for (const row of (iumResult.value || [])) {
      const no = row.Item_No;
      if (!no) continue;
      if (!uomConvMap[no]) uomConvMap[no] = {};
      uomConvMap[no][row.Code] = row.Qty_per_Unit_of_Measure || 1;
    }

    // Build item No. → Unit Price map (Sales Type = All Customers, active วันนี้, matching UoM ถ้ามี)
    // ถ้า item มีหลาย row ที่ valid → เอา min_qty ต่ำสุด (ราคา retail หน่วยละ 1)
    const today = new Date().toISOString().slice(0, 10);
    const priceMap = {};
    for (const sp of (spResult.value || [])) {
      if (sp.Sales_Type !== 'All Customers') continue;
      const start = (sp.Starting_Date || '').slice(0, 10);
      const end = (sp.Ending_Date || '').slice(0, 10);
      if (start && start !== '0001-01-01' && start > today) continue;
      if (end && end !== '0001-01-01' && end < today) continue;
      const itemNo = sp.Item_No;
      const uom = sp.Unit_of_Measure_Code || '';
      const minQty = sp.Minimum_Quantity || 0;
      const price = sp.Unit_Price || 0;
      const prefUom = purchUomMap[itemNo] || '';
      const existing = priceMap[itemNo];
      // เลือก row ที่ดีที่สุด: UoM ตรงกับ Purch UoM > UoM ว่าง > UoM อื่น; ภายในกลุ่มเดียวกันเลือก min_qty ต่ำสุด
      const score = (uom === prefUom ? 2 : uom === '' ? 1 : 0);
      if (!existing || score > existing.score || (score === existing.score && minQty < existing.minQty)) {
        priceMap[itemNo] = { price, uom, minQty, score };
      }
    }

    const upsert = db.prepare(`INSERT INTO items_cache (id, item_no, name, name_en, description, category, unit_price, inventory, uom, active, synced_at)
      VALUES (?,?,?,?,?,?,?,?,?,1,datetime('now','localtime'))
      ON CONFLICT(item_no) DO UPDATE SET
        name=excluded.name, name_en=excluded.name_en, description=excluded.description, category=excluded.category,
        unit_price=excluded.unit_price,
        inventory=excluded.inventory, uom=excluded.uom,
        active=1, synced_at=excluded.synced_at`);

    const tx = db.transaction(() => {
      db.prepare('UPDATE items_cache SET active=0').run();
      for (const it of bcItems) {
        const catCode = it.itemCategoryCode || '';
        const catName = catMap[catCode] || catCode;
        const nameEn = it.displayName || '';
        // TH ใช้ displayName2, fallback เป็น displayName ถ้า BC ไม่มี TH
        const nameTh = it.displayName2 || it.displayName || it.description || '';
        const itemNo = it.number || it.no || '';
        // ใช้ Purch. UoM จาก Item Card (หน่วยใหญ่), fallback เป็น Base UoM ถ้าว่าง
        const purchUom = purchUomMap[itemNo] || '';
        const uom = purchUom || it.baseUnitOfMeasureCode || 'PCS';
        // ราคาจาก Sales Price (All Customers, active), fallback เป็น Item Card Unit Price, 0 = "ติดต่อ HQ"
        const price = (priceMap[itemNo] && priceMap[itemNo].price) || it.unitPrice || 0;
        // แปลง inventory จาก Base UoM → Purch UoM (เช่น 638000 G / 1000 = 638 KG)
        const baseInv = it.inventory || 0;
        const qtyPerPurch = (uomConvMap[itemNo] && uomConvMap[itemNo][uom]) || 1;
        const inventory = qtyPerPurch > 1 ? Math.round((baseInv / qtyPerPurch) * 100) / 100 : baseInv;
        upsert.run(
          it.id || crypto.randomUUID(),
          itemNo,
          nameTh,
          nameEn,
          it.description2 || '',
          catName,
          price,
          inventory,
          uom,
        );
      }
    });
    tx();

    logSync('items', 'ok', `Synced ${bcItems.length} items from BC`, bcItems.length);
    return { ok: true, count: bcItems.length, mode: 'live', ms: Date.now() - start };
  } catch (e) {
    logSync('items', 'error', e.message, 0);
    return { ok: false, error: e.message, ms: Date.now() - start };
  }
}

function logSync(kind, status, message, count) {
  db.prepare('INSERT INTO sync_log (kind, status, message, count) VALUES (?,?,?,?)').run(kind, status, message, count);
}

function getLastSync() {
  return db.prepare("SELECT * FROM sync_log WHERE kind='items' ORDER BY id DESC LIMIT 1").get() || null;
}

module.exports = { syncItems, getLastSync };
