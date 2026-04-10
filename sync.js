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
      const upd = db.prepare('UPDATE items_cache SET inventory=?, synced_at=datetime("now","localtime") WHERE item_no=?');
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
    const result = await bc.listItems();
    const bcItems = result.value || [];
    if (!bcItems.length) {
      logSync('items', 'ok', 'BC returned 0 items', 0);
      return { ok: true, count: 0, mode: 'live', ms: Date.now() - start };
    }

    const upsert = db.prepare(`INSERT INTO items_cache (id, item_no, name, description, category, unit_price, inventory, uom, active, synced_at)
      VALUES (?,?,?,?,?,?,?,?,1,datetime('now','localtime'))
      ON CONFLICT(item_no) DO UPDATE SET
        name=excluded.name, description=excluded.description, category=excluded.category,
        unit_price=excluded.unit_price, inventory=excluded.inventory, uom=excluded.uom,
        active=1, synced_at=excluded.synced_at`);

    const tx = db.transaction(() => {
      // Mark all inactive first, then reactivate what BC returns
      db.prepare('UPDATE items_cache SET active=0').run();
      for (const it of bcItems) {
        upsert.run(
          it.id || crypto.randomUUID(),
          it.number || it.no || '',
          it.displayName || it.description || '',
          it.description2 || '',
          it.itemCategoryCode || '',
          it.unitPrice || 0,
          it.inventory || 0,
          it.baseUnitOfMeasureCode || 'PCS',
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
  return db.prepare('SELECT * FROM sync_log WHERE kind="items" ORDER BY id DESC LIMIT 1').get() || null;
}

module.exports = { syncItems, getLastSync };
