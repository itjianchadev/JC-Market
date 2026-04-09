const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'data', 'stock-market.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'fc',           -- admin, fc
  branch_code TEXT DEFAULT '',               -- JF039 ...
  branch_name TEXT DEFAULT '',
  bc_customer_no TEXT DEFAULT '',            -- Customer No. in D365 BC
  phone TEXT DEFAULT '',
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS items_cache (
  id TEXT PRIMARY KEY,                       -- BC item id (GUID)
  item_no TEXT UNIQUE NOT NULL,              -- BC No.
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  category TEXT DEFAULT '',
  unit_price REAL DEFAULT 0,
  inventory REAL DEFAULT 0,
  uom TEXT DEFAULT 'PCS',
  image_url TEXT DEFAULT '',
  active INTEGER DEFAULT 1,
  synced_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS cart_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  item_no TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_price REAL NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(user_id, item_no)
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  order_number TEXT UNIQUE NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  branch_code TEXT,
  subtotal REAL DEFAULT 0,
  total REAL DEFAULT 0,
  payment_status TEXT DEFAULT 'pending',     -- pending, paid, verified, failed
  payment_method TEXT DEFAULT 'promptpay',
  bc_invoice_id TEXT DEFAULT '',
  bc_invoice_no TEXT DEFAULT '',
  bc_posted INTEGER DEFAULT 0,
  note TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  paid_at TEXT,
  posted_at TEXT
);

CREATE TABLE IF NOT EXISTS order_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id),
  item_no TEXT NOT NULL,
  item_name TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_price REAL NOT NULL,
  line_total REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id),
  qr_ref TEXT DEFAULT '',
  amount REAL NOT NULL,
  slip_path TEXT DEFAULT '',
  verified INTEGER DEFAULT 0,
  verified_by TEXT DEFAULT '',
  verified_at TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                        -- items, invoice_post
  status TEXT NOT NULL,                      -- ok, error
  message TEXT DEFAULT '',
  count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
`);

// ─── Seed admin + demo FC users ───
const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
if (userCount === 0) {
  const uid = () => crypto.randomUUID();
  const hash = (p) => bcrypt.hashSync(p, 10);
  const stmt = db.prepare(`INSERT INTO users (id, username, password, full_name, role, branch_code, branch_name, bc_customer_no)
    VALUES (?,?,?,?,?,?,?,?)`);
  stmt.run(uid(), 'admin', hash('admin1234'), 'HQ Admin', 'admin', '', 'HQ', '');
  stmt.run(uid(), 'jf039', hash('fc1234'), 'FC JF039', 'fc', 'JF039', 'สาขา JF039', 'C-JF039');
  stmt.run(uid(), 'jf049', hash('fc1234'), 'FC JF049', 'fc', 'JF049', 'สาขา JF049', 'C-JF049');
  console.log('[db] Seeded users: admin/admin1234, jf039/fc1234, jf049/fc1234');
}

// ─── Seed mock items (ใช้ก่อนยังไม่มี BC creds) ───
const itemCount = db.prepare('SELECT COUNT(*) c FROM items_cache').get().c;
if (itemCount === 0) {
  const mock = [
    ['RM-001', 'ใบชาเขียวเจียนชา', 'วัตถุดิบ', 100, 20, 'KG'],
    ['RM-002', 'ใบชาดำอัสสัม', 'วัตถุดิบ', 120, 15, 'KG'],
    ['RM-003', 'น้ำตาลทรายขาว', 'วัตถุดิบ', 25, 200, 'KG'],
    ['RM-004', 'นมข้นหวาน', 'วัตถุดิบ', 35, 80, 'กระป๋อง'],
    ['PK-001', 'แก้วพลาสติก 16oz', 'บรรจุภัณฑ์', 1.5, 5000, 'PCS'],
    ['PK-002', 'ฝาโดม', 'บรรจุภัณฑ์', 0.8, 5000, 'PCS'],
    ['PK-003', 'หลอดไบโอ', 'บรรจุภัณฑ์', 0.5, 10000, 'PCS'],
    ['TP-001', 'ไข่มุกดำ', 'ท็อปปิ้ง', 80, 30, 'KG'],
    ['TP-002', 'เยลลี่มะพร้าว', 'ท็อปปิ้ง', 60, 25, 'KG'],
  ];
  const ins = db.prepare(`INSERT INTO items_cache (id, item_no, name, category, unit_price, inventory, uom)
    VALUES (?,?,?,?,?,?,?)`);
  for (const [no, name, cat, price, inv, uom] of mock) {
    ins.run(crypto.randomUUID(), no, name, cat, price, inv, uom);
  }
  console.log(`[db] Seeded ${mock.length} mock items`);
}

module.exports = db;
