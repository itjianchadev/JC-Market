const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'data', 'stock-market.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS branches (
  code TEXT PRIMARY KEY,                    -- JF039, JF050, ...
  name TEXT NOT NULL,                        -- สาขา JF039
  bc_customer_no TEXT DEFAULT '',            -- Customer No. ใน D365 BC
  address TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  manager_email TEXT DEFAULT '',
  tax_id TEXT DEFAULT '',
  show_tax_id INTEGER DEFAULT 1,             -- 1=โชว์, 0=ซ่อน
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'fc',           -- super_admin, admin_scm, branch_owner, store_manager, cashier, fc
  branch_code TEXT DEFAULT '',               -- FK → branches.code
  branch_name TEXT DEFAULT '',
  bc_customer_no TEXT DEFAULT '',            -- Customer No. in D365 BC (denormalized)
  phone TEXT DEFAULT '',
  can_order INTEGER DEFAULT 1,               -- 1=สั่งของได้, 0=สั่งไม่ได้
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS items_cache (
  id TEXT PRIMARY KEY,                       -- BC item id (GUID)
  item_no TEXT UNIQUE NOT NULL,              -- BC No.
  name TEXT NOT NULL,                        -- TH (BC displayName2) หรือ fallback
  name_en TEXT DEFAULT '',                   -- EN (BC displayName)
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
  vat_rate REAL DEFAULT 7,
  vat_amount REAL DEFAULT 0,
  total REAL DEFAULT 0,
  payment_status TEXT DEFAULT 'pending',     -- pending, paid, verified, failed
  payment_method TEXT DEFAULT 'promptpay',
  bc_so_id TEXT DEFAULT '',
  bc_so_no TEXT DEFAULT '',
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

// ─── Migrate: add bc_po columns if missing ───
try { db.exec("ALTER TABLE orders ADD COLUMN bc_po_id TEXT DEFAULT ''"); } catch (e) { /* already exists */ }
try { db.exec("ALTER TABLE orders ADD COLUMN bc_po_no TEXT DEFAULT ''"); } catch (e) { /* already exists */ }
// BC Vendor on the PO — Finance picks this after approving the slip; null until then.
try { db.exec("ALTER TABLE orders ADD COLUMN po_vendor_no TEXT DEFAULT ''"); } catch (e) { /* already exists */ }

// ─── Migrate: fulfillment tracking ───
try { db.exec("ALTER TABLE orders ADD COLUMN fulfillment_status TEXT DEFAULT 'pending'"); } catch (e) {}
try { db.exec("ALTER TABLE orders ADD COLUMN shipped_at TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE orders ADD COLUMN shipped_by TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE orders ADD COLUMN fully_received_at TEXT"); } catch (e) {}

// ─── Migrate: bc_po_line_id on order_lines ───
try { db.exec("ALTER TABLE order_lines ADD COLUMN bc_po_line_id TEXT DEFAULT ''"); } catch (e) {}

// ─── Migrate: received_date on goods_receipts ───
// Business date of when goods arrived at the branch. Distinct from created_at
// (which records when the user pressed "Confirm receive" in the app — they
// may enter goods received yesterday into the app today). When the order
// becomes fully received, orders.fully_received_at is set to the GR's
// received_date rather than NOW(), so reports line up with reality.
try { db.exec("ALTER TABLE goods_receipts ADD COLUMN received_date TEXT DEFAULT ''"); } catch (e) {}

// ─── Goods Receipts ───
db.exec(`
CREATE TABLE IF NOT EXISTS goods_receipts (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  receipt_number TEXT UNIQUE NOT NULL,
  received_by TEXT NOT NULL REFERENCES users(id),
  bc_receipt_no TEXT DEFAULT '',
  bc_posted INTEGER DEFAULT 0,
  note TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS goods_receipt_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id TEXT NOT NULL REFERENCES goods_receipts(id),
  order_line_id INTEGER NOT NULL REFERENCES order_lines(id),
  item_no TEXT NOT NULL,
  item_name TEXT NOT NULL,
  ordered_qty REAL NOT NULL,
  received_qty REAL NOT NULL,
  note TEXT DEFAULT ''
);
`);

// ─── Stock issues (FC consumes stock from branch on-hand) ───
// goods_receipts → stock IN (received from HQ).
// stock_issues  → stock OUT (issued by FC to sell / damage / transfer /
// adjustment). on_hand = SUM(received) − SUM(issued) per item per branch.
db.exec(`
CREATE TABLE IF NOT EXISTS stock_issues (
  id TEXT PRIMARY KEY,
  issue_number TEXT UNIQUE NOT NULL,
  branch_code TEXT NOT NULL,
  issued_by TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL DEFAULT 'sale',  -- sale / damage / transfer / adjustment / other
  note TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS stock_issue_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id TEXT NOT NULL REFERENCES stock_issues(id) ON DELETE CASCADE,
  item_no TEXT NOT NULL,
  item_name TEXT NOT NULL,
  qty REAL NOT NULL CHECK(qty > 0),
  note TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_stock_issues_branch ON stock_issues(branch_code, created_at);
CREATE INDEX IF NOT EXISTS idx_stock_issue_lines_item ON stock_issue_lines(item_no);

-- Reorder-point settings per (branch, item). When stock-balance.on_hand falls
-- at or below reorder_point, the item is flagged low_stock so the branch can
-- act before stock-out. reorder_qty is the recommended order quantity (next
-- step: surface this as a one-click "เติมสต๊อก" in the shop page).
CREATE TABLE IF NOT EXISTS branch_item_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_code TEXT NOT NULL,
  item_no TEXT NOT NULL,
  reorder_point REAL NOT NULL DEFAULT 0,
  reorder_qty REAL DEFAULT 0,
  note TEXT DEFAULT '',
  updated_by TEXT,
  updated_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(branch_code, item_no)
);
CREATE INDEX IF NOT EXISTS idx_bis_branch ON branch_item_settings(branch_code);

-- Software license — singleton row (CHECK id=1). Super admin sets product
-- name, license key, licensee, issue/expiry dates. The UI computes days
-- remaining client-side so admin can see the countdown without server work.
CREATE TABLE IF NOT EXISTS license_info (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  product_name TEXT DEFAULT 'JC-Market',
  license_key  TEXT DEFAULT '',
  licensed_to  TEXT DEFAULT '',
  issued_at    TEXT,
  expires_at   TEXT,
  features     TEXT DEFAULT '',
  notes        TEXT DEFAULT '',
  updated_by   TEXT,
  updated_at   TEXT DEFAULT (datetime('now','localtime'))
);
INSERT OR IGNORE INTO license_info (id, product_name) VALUES (1, 'JC-Market');
`);

// ─── Per-branch license fields ─────────────────────────────────────────────
// Each FC has its own software-licence expiry (franchise contract / SaaS
// subscription). Stored directly on branches so the branches grid can show
// status without a join.
try { db.exec("ALTER TABLE branches ADD COLUMN license_key TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE branches ADD COLUMN license_issued_at TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE branches ADD COLUMN license_expires_at TEXT"); } catch (e) {}

// branch_type: 'fc' (franchise — pays, goes through Finance, SO+PO in BC) or
// 'jc' (master — company-owned outlet, no payment, Transfer Order for general
// goods and PO for fresh fruit in BC). branches.code for JC branches equals
// the BC location code (JC001-JCxxx).
try { db.exec("ALTER TABLE branches ADD COLUMN branch_type TEXT DEFAULT 'fc'"); } catch (e) {}

// ─── Strict-mode Finance gate: record SlipOK auto-verify outcome on the
// payment but DON'T let it auto-promote the order. Finance review (via
// /api/orders/:id/verify) is now the single approval channel.
try { db.exec("ALTER TABLE payments ADD COLUMN auto_verify_passed INTEGER DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE payments ADD COLUMN auto_verify_reason TEXT DEFAULT ''"); } catch (e) {}

// ─── Rejection audit (Finance rejects a slip → record the reason) ──────────
// Distinct from cancellation (FC cancels their own pending order).
try { db.exec("ALTER TABLE orders ADD COLUMN reject_reason TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE orders ADD COLUMN rejected_at TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE orders ADD COLUMN rejected_by TEXT DEFAULT ''"); } catch (e) {}
// How many times FC has re-uploaded a slip after a Finance rejection. 0 = original upload.
try { db.exec("ALTER TABLE orders ADD COLUMN slip_retry_count INTEGER DEFAULT 0"); } catch (e) {}

// Fruit-order payment mode: 'immediate' (default — pay now via slip) or
// 'credit_7d' (settle within 7 days). credit_due_at is the deadline when
// 'credit_7d' is chosen.
try { db.exec("ALTER TABLE orders ADD COLUMN payment_method TEXT DEFAULT 'immediate'"); } catch (e) {}
try { db.exec("ALTER TABLE orders ADD COLUMN credit_due_at TEXT DEFAULT ''"); } catch (e) {}

// order_type marks which workflow created the order in BC:
//   fc_purchase  — FC franchise ordering through Finance (SO + PO)
//   jc_transfer  — JC master outlet, general goods (Transfer Order CTI→JC0xx)
//   jc_purchase  — JC master outlet, fresh fruit (PO only, no SO)
try { db.exec("ALTER TABLE orders ADD COLUMN order_type TEXT DEFAULT 'fc_purchase'"); } catch (e) {}
try { db.exec("ALTER TABLE orders ADD COLUMN bc_to_id TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE orders ADD COLUMN bc_to_no TEXT DEFAULT ''"); } catch (e) {}

// ─── Migrate: cancel fields ───
try { db.exec("ALTER TABLE orders ADD COLUMN cancelled_at TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE orders ADD COLUMN cancelled_by TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE orders ADD COLUMN cancel_reason TEXT DEFAULT ''"); } catch (e) {}

// ─── Migrate: BC post failure tracking ───
// When the receive flow tries to post a Sales Invoice in BC but fails (stock,
// permissions, etc.), we need a way for admins to see the orphan and retry.
try { db.exec("ALTER TABLE orders ADD COLUMN bc_sync_error TEXT DEFAULT ''"); } catch (e) {}

// ─── Migrate: anti-fraud fields on payments ───
try { db.exec("ALTER TABLE payments ADD COLUMN slip_hash TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE payments ADD COLUMN trans_date TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE payments ADD COLUMN slip_sender TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE payments ADD COLUMN slip_receiver TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE payments ADD COLUMN slip_amount REAL DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE payments ADD COLUMN upload_ip TEXT DEFAULT ''"); } catch (e) {}
// Partial unique index: only enforce uniqueness on non-empty qr_ref of verified payments
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_qr_ref_uniq ON payments(qr_ref) WHERE qr_ref != '' AND verified=1"); } catch (e) {}
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_slip_hash_uniq ON payments(slip_hash) WHERE slip_hash != '' AND verified=1"); } catch (e) {}

// ─── Slip fraud attempts (audit log) ───
db.exec(`
CREATE TABLE IF NOT EXISTS slip_fraud_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT,
  user_id TEXT,
  username TEXT,
  ip TEXT DEFAULT '',
  reason TEXT NOT NULL,
  slip_hash TEXT DEFAULT '',
  qr_ref TEXT DEFAULT '',
  slip_amount REAL DEFAULT 0,
  expected_amount REAL DEFAULT 0,
  trans_date TEXT DEFAULT '',
  raw_response TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_fraud_user ON slip_fraud_log(user_id);
CREATE INDEX IF NOT EXISTS idx_fraud_created ON slip_fraud_log(created_at);
`);

// ─── Payment Receipts (ใบเสร็จรับเงิน) ───
db.exec(`
CREATE TABLE IF NOT EXISTS payment_receipts (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  receipt_number TEXT UNIQUE NOT NULL,
  issued_by TEXT NOT NULL REFERENCES users(id),
  subtotal REAL NOT NULL DEFAULT 0,
  vat_amount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  note TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
`);

// ─── Seed admin + demo FC users ───
// ─── Migration: add name_en column to existing items_cache if missing ───
try {
  const cols = db.prepare("PRAGMA table_info(items_cache)").all();
  if (!cols.some(c => c.name === 'name_en')) {
    db.exec("ALTER TABLE items_cache ADD COLUMN name_en TEXT DEFAULT ''");
    console.log('[db] Migration: added items_cache.name_en');
  }
} catch (e) { console.error('[db] name_en migration failed:', e.message); }

// ─── Migration: add unit_cost column to items_cache if missing ───
// unit_cost is the BC Item Card "Unit Cost" pre-converted to Purchase UoM
// (BC stores it per Base UoM, sync.js multiplies by qty-per-purch-uom).
// Used as directUnitCost on Purchase Order lines so PO totals reflect the
// actual vendor cost instead of the branch sales price.
try {
  const cols = db.prepare("PRAGMA table_info(items_cache)").all();
  if (!cols.some(c => c.name === 'unit_cost')) {
    db.exec("ALTER TABLE items_cache ADD COLUMN unit_cost REAL DEFAULT 0");
    console.log('[db] Migration: added items_cache.unit_cost');
  }
} catch (e) { console.error('[db] unit_cost migration failed:', e.message); }

// ─── Migration: add can_order to users if missing ───
try {
  const cols = db.prepare("PRAGMA table_info(users)").all();
  if (!cols.some(c => c.name === 'can_order')) {
    db.exec("ALTER TABLE users ADD COLUMN can_order INTEGER DEFAULT 1");
    console.log('[db] Migration: added users.can_order');
  }
} catch (e) { console.error('[db] can_order migration failed:', e.message); }

// ─── Migration: seed branches from existing users.branch_code ───
try {
  const branchCount = db.prepare('SELECT COUNT(*) c FROM branches').get().c;
  if (branchCount === 0) {
    const existing = db.prepare(`
      SELECT DISTINCT branch_code, branch_name, bc_customer_no
      FROM users WHERE branch_code <> '' AND branch_code IS NOT NULL
    `).all();
    const ins = db.prepare(`INSERT OR IGNORE INTO branches (code, name, bc_customer_no) VALUES (?, ?, ?)`);
    for (const b of existing) {
      ins.run(b.branch_code, b.branch_name || b.branch_code, b.bc_customer_no || '');
    }
    if (existing.length) console.log(`[db] Migration: seeded ${existing.length} branches from users`);
  }
} catch (e) { console.error('[db] branches seed failed:', e.message); }

// ─── Role migration: rename old role names to new taxonomy ───
// admin → admin_scm, branch_admin → branch_owner, manager → store_manager
try {
  const migrations = [
    { from: 'admin', to: 'admin_scm' },
    { from: 'branch_admin', to: 'branch_owner' },
    { from: 'manager', to: 'store_manager' },
  ];
  for (const m of migrations) {
    const r = db.prepare('UPDATE users SET role=? WHERE role=?').run(m.to, m.from);
    if (r.changes) console.log(`[db] Role migration: ${m.from} → ${m.to} (${r.changes} user${r.changes>1?'s':''})`);
  }
} catch (e) { console.error('[db] role migration failed:', e.message); }

const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
if (userCount === 0) {
  const uid = () => crypto.randomUUID();
  const hash = (p) => bcrypt.hashSync(p, 10);
  const stmt = db.prepare(`INSERT INTO users (id, username, password, full_name, role, branch_code, branch_name, bc_customer_no, can_order)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  // can_order: admins don't place orders, fc branches DO. Finance is HQ —
  // approves slips so BC SO creation is gated by them.
  stmt.run(uid(), 'itmanager', hash('it1234'), 'IT Manager', 'super_admin', '', 'HQ', '', 0);
  stmt.run(uid(), 'admin', hash('admin1234'), 'SCM Admin', 'admin_scm', '', 'HQ', '', 0);
  stmt.run(uid(), 'finance', hash('fin1234'), 'Finance Officer', 'finance', '', 'HQ', '', 0);
  stmt.run(uid(), 'jf039', hash('fc1234'), 'Owner JF039', 'branch_owner', 'JF039', 'สาขา JF039', 'JF001', 1);
  stmt.run(uid(), 'jf049', hash('fc1234'), 'Owner JF049', 'branch_owner', 'JF049', 'สาขา JF049', 'JF002', 1);
  console.log('[db] Seeded users: itmanager/it1234 (super_admin), admin/admin1234 (admin_scm), finance/fin1234 (finance), jf039/jf049 (branch_owner)');
}

// ─── Seed JC master branches + users (idempotent) ──────────────────────────
// Company-owned outlets. branches.code = BC location code, so the Transfer
// Order at checkout time targets the right warehouse directly.
try {
  const JC_BRANCHES = [
    ['JC002', 'JC002 DGT'],
    ['JC003', 'JC003 CTW'],
    ['JC004', 'JC004 Atthenee'],
    ['JC005', 'JC005 Mega Bangna'],
    ['JC006', 'JC006 Siam Discovery'],
    ['JC007', 'JC007 Siam Paragon 5th floor'],
    ['JC008', 'JC008'],
    ['JC009', 'JC009'],
    ['JC010', 'JC010'],
  ];
  const insBranch = db.prepare(`INSERT OR IGNORE INTO branches (code, name, branch_type, bc_customer_no) VALUES (?, ?, 'jc', '')`);
  for (const [code, name] of JC_BRANCHES) insBranch.run(code, name);
  // Promote any pre-existing rows with these codes to branch_type='jc' too
  // (safe for re-seed — won't downgrade FC branches).
  const promoteStmt = db.prepare("UPDATE branches SET branch_type='jc' WHERE code = ? AND branch_type != 'jc'");
  for (const [code] of JC_BRANCHES) promoteStmt.run(code);

  // Seed one owner per JC branch if none exists
  const insUser = db.prepare(`INSERT INTO users (id, username, password, full_name, role, branch_code, branch_name, bc_customer_no, can_order)
    VALUES (?,?,?,?,?,?,?,?,1)`);
  const hash = (p) => bcrypt.hashSync(p, 10);
  for (const [code, name] of JC_BRANCHES) {
    const username = code.toLowerCase(); // jc002, jc003, ...
    const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
    if (!exists) {
      insUser.run(crypto.randomUUID(), username, hash('jc1234'), 'Owner ' + code, 'branch_owner', code, name, '');
    }
  }
} catch (e) { console.error('[db] JC seed failed:', e.message); }

// ─── Seed super_admin "IT Manager" ถ้ายังไม่มี ───
try {
  const hasSuper = db.prepare("SELECT 1 FROM users WHERE role='super_admin'").get();
  if (!hasSuper) {
    const uid = () => crypto.randomUUID();
    const hash = (p) => bcrypt.hashSync(p, 10);
    db.prepare(`INSERT INTO users (id, username, password, full_name, role, branch_code, branch_name, bc_customer_no, can_order)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(uid(), 'itmanager', hash('it1234'), 'IT Manager', 'super_admin', '', 'HQ', '', 0);
    console.log('[db] Seeded super_admin: itmanager/it1234 (IT Manager) — เปลี่ยนรหัสหลัง login แรก');
  }
} catch (e) { console.error('[db] super_admin seed failed:', e.message); }

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
