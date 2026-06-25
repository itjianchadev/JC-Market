const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'stock-market.db');
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

// ─── Migrate: FC shipping fee + withholding tax (WHT) + net payable ───
// FC orders carry a flat shipping fee (pre-VAT, env FC_SHIPPING_FEE=200) and a
// 3% WHT on the shipping ONLY — goods are a sale of goods (no WHT in TH; WHT is
// services-only). net_payable = total - wht_amount is the amount fed to the
// PromptPay QR + slip check. BC SO/PO documents ALWAYS carry the FULL total —
// net_payable is a payment-layer concept only and must never leak into BC.
// JC (master) orders: all of these stay 0 and net_payable = total (no payment).
try { db.exec("ALTER TABLE orders ADD COLUMN shipping_fee REAL DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE orders ADD COLUMN wht_rate REAL DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE orders ADD COLUMN wht_base REAL DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE orders ADD COLUMN wht_amount REAL DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE orders ADD COLUMN net_payable REAL DEFAULT 0"); } catch (e) {}

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

// ─── Migrate: shipping + WHT breakdown on payment_receipts ───
// NOTE: in the monthly-billing model the per-order receipt carries 0 here
// (shipping/WHT moved off the goods order). These columns stay for the schema's
// sake and so any pre-pivot receipts keep their stored breakdown.
try { db.exec("ALTER TABLE payment_receipts ADD COLUMN shipping_fee REAL DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE payment_receipts ADD COLUMN wht_amount REAL DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE payment_receipts ADD COLUMN net_payable REAL DEFAULT 0"); } catch (e) {}

// ─── Monthly consolidated shipping billing ─────────────────────────────────
// Each FC order accrues a flat 200 THB shipping fee (orders.shipping_fee) but is
// NOT billed for it at checkout. Once a month Finance consolidates every
// verified + unbilled FC order per branch into ONE shipping_invoices row, which
// opens a SEPARATE BC Sales Order (freight G/L line SV-TP0002 + 7% VAT) and is
// settled by the FC in-app (PromptPay QR + slip + Finance verify), net of 3% WHT
// on the pre-VAT shipping. SO-only — shipping is a service JC sells to the FC,
// never a purchase, so there is no PO. The consolidated orders ARE the invoice
// lines (reconstruct via orders WHERE shipping_invoice_id = ?), so there is no
// separate lines table.
db.exec(`
CREATE TABLE IF NOT EXISTS shipping_invoices (
  id TEXT PRIMARY KEY,
  invoice_number TEXT UNIQUE NOT NULL,          -- SHP-INV-2026-06-0001
  branch_code TEXT NOT NULL,                     -- FC branch being billed
  bc_customer_no TEXT DEFAULT '',                -- denormalized BC customer for the SO
  period TEXT NOT NULL,                           -- 'YYYY-MM' billing-run label (default = prev month)
  cutoff_date TEXT DEFAULT '',                    -- orders.created_at <= this were swept in (audit)
  order_count INTEGER NOT NULL DEFAULT 0,         -- N orders consolidated
  shipping_subtotal REAL NOT NULL DEFAULT 0,      -- 200 * N (pre-VAT)
  vat_rate REAL NOT NULL DEFAULT 7,
  vat_amount REAL NOT NULL DEFAULT 0,             -- 7% of shipping_subtotal
  total REAL NOT NULL DEFAULT 0,                  -- shipping_subtotal + vat_amount
  wht_rate REAL NOT NULL DEFAULT 0,               -- 0.03
  wht_base REAL NOT NULL DEFAULT 0,               -- = shipping_subtotal (pre-VAT)
  wht_amount REAL NOT NULL DEFAULT 0,             -- 3% of shipping_subtotal
  net_payable REAL NOT NULL DEFAULT 0,            -- total - wht_amount (FC pays this)
  status TEXT NOT NULL DEFAULT 'pending',         -- pending/paid/verified/cancelled
  bc_so_id TEXT DEFAULT '',
  bc_so_no TEXT DEFAULT '',
  qr_ref TEXT DEFAULT '',
  slip_path TEXT DEFAULT '',
  slip_hash TEXT DEFAULT '',
  receipt_number TEXT DEFAULT '',                 -- set on Finance verify
  note TEXT DEFAULT '',
  created_by TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  posted_at TEXT,                                 -- BC SO created at
  paid_at TEXT,                                   -- FC uploaded slip at
  verified_by TEXT DEFAULT '',
  verified_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_shipinv_branch ON shipping_invoices(branch_code, period);
CREATE INDEX IF NOT EXISTS idx_shipinv_status ON shipping_invoices(status);
`);

// Link an order to the monthly shipping invoice that billed its shipping accrual.
// Empty = not yet billed. This is the real double-bill guard (stamped
// transactionally when the invoice is generated); an order lands on exactly one
// shipping invoice. The consolidation query selects:
//   payment_status='verified' AND shipping_fee>0 AND shipping_invoice_id=''
try { db.exec("ALTER TABLE orders ADD COLUMN shipping_invoice_id TEXT DEFAULT ''"); } catch (e) {}

// ─── Consolidated GOODS billing (credit/fruit orders → Tuesday cycle) ──────────
// FC fruit orders are credit: each already auto-creates its own BC SO at checkout
// (the real sales doc), but is NOT collected per-order. Finance consolidates every
// verified + unbilled FC fruit order per franchise into ONE credit_invoices row —
// an APP-side billing statement (no extra BC doc) listing each order, due the next
// Tuesday 12:00. The franchise pays the grand total once. Like shipping billing,
// the consolidated orders ARE the lines (orders WHERE credit_invoice_id=?), so
// there is no separate lines table. No WHT on goods → net_payable = total.
db.exec(`
CREATE TABLE IF NOT EXISTS credit_invoices (
  id TEXT PRIMARY KEY,
  invoice_number TEXT UNIQUE NOT NULL,            -- CRD-INV-20260609-0001
  branch_code TEXT NOT NULL,
  branch_name TEXT DEFAULT '',
  bc_customer_no TEXT DEFAULT '',
  cycle_due TEXT NOT NULL,                          -- 'YYYY-MM-DD 12:00' = Tuesday due
  cutoff_at TEXT DEFAULT '',                        -- when the sweep ran (audit)
  order_count INTEGER NOT NULL DEFAULT 0,
  subtotal REAL NOT NULL DEFAULT 0,                -- sum of order subtotals (goods, pre-VAT)
  vat_amount REAL NOT NULL DEFAULT 0,              -- sum of order VAT
  total REAL NOT NULL DEFAULT 0,                   -- subtotal + vat = sum(order.total)
  net_payable REAL NOT NULL DEFAULT 0,             -- = total (no WHT on goods)
  status TEXT NOT NULL DEFAULT 'pending',           -- pending/paid/verified/cancelled
  qr_ref TEXT DEFAULT '',
  slip_path TEXT DEFAULT '',
  slip_hash TEXT DEFAULT '',
  receipt_number TEXT DEFAULT '',
  note TEXT DEFAULT '',
  created_by TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  paid_at TEXT,
  verified_by TEXT DEFAULT '',
  verified_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_crdinv_branch ON credit_invoices(branch_code);
CREATE INDEX IF NOT EXISTS idx_crdinv_status ON credit_invoices(status);
`);
// Link an FC fruit order to the Tuesday billing run that swept it (double-bill guard).
try { db.exec("ALTER TABLE orders ADD COLUMN credit_invoice_id TEXT DEFAULT ''"); } catch (e) {}

// ─── Sale Billing payment slips (BC integration) ───
// SB (Sale Billing) documents live in BC (Exsys Localize Billing ext) and are read
// live via bc.getSalesBillings(). JC-Market stores ONLY the branch's payment slip per
// SB here — the paid/unpaid truth stays in BC (each line's Remaining_Amount drops to 0
// once accounting applies the receipt). One row per SB (re-upload replaces it while the
// bill is still unpaid in BC).
db.exec(`
CREATE TABLE IF NOT EXISTS sale_billing_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sb_no TEXT UNIQUE NOT NULL,                       -- BC Billing No (e.g. SB202506001)
  customer_no TEXT NOT NULL,                         -- Bill_to_Customer_No (branch)
  bill_total REAL DEFAULT 0,                         -- SB total snapshot at slip upload
  slip_path TEXT DEFAULT '',
  slip_hash TEXT DEFAULT '',
  qr_ref TEXT DEFAULT '',
  slip_amount REAL DEFAULT 0,
  verify_ok INTEGER DEFAULT 0,                       -- verifySlip result (informational hint)
  verify_reason TEXT DEFAULT '',
  uploaded_by TEXT DEFAULT '',
  uploaded_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_sbpay_customer ON sale_billing_payments(customer_no);
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

// ─── TMS Phase 1: schema ───
// Outsourced last-mile delivery from CTI (or any origin) to FC/JC branches.
// A shipment = one order's goods movement. A trip = one carrier vehicle on one
// day carrying multiple shipments (stops). The carrier's driver opens a PWA
// on their phone to mark "dispatched" and upload POD per stop.
db.exec(`
CREATE TABLE IF NOT EXISTS carriers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,                  -- 'KERRY', 'FLASH', 'XYZ-LOG'
  name TEXT NOT NULL,
  contact_phone TEXT DEFAULT '',
  contact_email TEXT DEFAULT '',
  default_cost_per_trip REAL DEFAULT 0,       -- ราคาเหมาเที่ยวเริ่มต้น
  note TEXT DEFAULT '',
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS carrier_drivers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  carrier_id INTEGER NOT NULL REFERENCES carriers(id) ON DELETE CASCADE,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,                     -- bcrypt hash
  full_name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  vehicle_plate TEXT DEFAULT '',              -- ทะเบียนรถประจำคนขับ (optional)
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS trips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_number TEXT UNIQUE NOT NULL,           -- TRP-2026-0001
  carrier_id INTEGER NOT NULL REFERENCES carriers(id),
  driver_id INTEGER REFERENCES carrier_drivers(id),
  vehicle_plate TEXT DEFAULT '',
  scheduled_date TEXT NOT NULL,               -- YYYY-MM-DD
  cost_agreed REAL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'planned',     -- planned/dispatched/completed/cancelled
  dispatched_at TEXT,
  completed_at TEXT,
  note TEXT DEFAULT '',
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS shipments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_number TEXT UNIQUE NOT NULL,       -- SHP-2026-0001
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  origin TEXT DEFAULT 'CTI',                  -- BC location code we ship from
  dest_branch_code TEXT NOT NULL,             -- → branches.code
  weight_kg REAL DEFAULT 0,
  volume_m3 REAL DEFAULT 0,
  trip_id INTEGER REFERENCES trips(id),       -- NULL = unassigned (in pool)
  stop_seq INTEGER DEFAULT 0,                 -- order of visit within trip (1,2,3,...)
  status TEXT NOT NULL DEFAULT 'pending',     -- pending/planned/intransit/delivered/failed
  delivered_at TEXT,
  note TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS pods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  photo_url TEXT DEFAULT '',
  signature_url TEXT DEFAULT '',
  signed_by_name TEXT DEFAULT '',
  driver_lat REAL,
  driver_lng REAL,
  received_at TEXT DEFAULT (datetime('now','localtime')),
  notes TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS driver_pings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  driver_id INTEGER REFERENCES carrier_drivers(id),
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  recorded_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_shipments_order ON shipments(order_id);
CREATE INDEX IF NOT EXISTS idx_shipments_trip ON shipments(trip_id);
CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments(status);
CREATE INDEX IF NOT EXISTS idx_trips_date ON trips(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_trips_driver ON trips(driver_id);
CREATE INDEX IF NOT EXISTS idx_pings_trip_time ON driver_pings(trip_id, recorded_at);
`);

// ─── Driver vehicle metadata ───
// Province where the vehicle is registered (จังหวัดทะเบียนรถ). Optional
// free-text — drivers may swap vehicles between trips, so this is the
// driver's "default vehicle" tagging; the per-trip plate on trips.vehicle_plate
// still wins when a particular run uses a different vehicle.
try { db.exec("ALTER TABLE carrier_drivers ADD COLUMN vehicle_province TEXT DEFAULT ''"); } catch (e) { /* already exists */ }

// ─── Driver login is phone-based (Phase 1.4b) ───
// Normalize stored phones to digits-only so users can enter "081-234-5678",
// "081 234 5678", "+66812345678" and we still find the row.
// Then enforce uniqueness so a duplicate phone can never make login
// ambiguous. Partial index — empty phone (legacy / not yet set) is allowed
// to repeat.
try {
  db.exec(`UPDATE carrier_drivers
    SET phone = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, '-', ''), ' ', ''), '+', ''), '(', ''), ')', ''), '.', '')
    WHERE phone <> '' AND phone GLOB '*[^0-9]*'`);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_carrier_drivers_phone_uniq ON carrier_drivers(phone) WHERE phone <> ''");
} catch (e) {
  console.error('[db] driver phone unique index failed (duplicates?):', e.message);
}

// ─── Multiple phone numbers per driver ───
// A driver (1 person / 1 vehicle) may register more than one phone; logging in
// with ANY of them resolves to the same driver. carrier_drivers.phone stays the
// PRIMARY phone (shown in lists, returned by login); the full set lives here,
// which also enforces phone uniqueness across every driver.
db.exec(`
CREATE TABLE IF NOT EXISTS carrier_driver_phones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id INTEGER NOT NULL REFERENCES carrier_drivers(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_driver_phones_uniq ON carrier_driver_phones(phone);
CREATE INDEX IF NOT EXISTS idx_driver_phones_driver ON carrier_driver_phones(driver_id);
`);
// Backfill: seed each existing driver's primary phone into the phones table so
// post-migration logins (which read the phones table) keep working.
try {
  const r = db.prepare(`
    INSERT INTO carrier_driver_phones (driver_id, phone)
    SELECT d.id, d.phone FROM carrier_drivers d
    WHERE d.phone <> '' AND NOT EXISTS (
      SELECT 1 FROM carrier_driver_phones p WHERE p.phone = d.phone
    )`).run();
  if (r.changes) console.log(`[db] Migration: backfilled ${r.changes} driver phone(s) into carrier_driver_phones`);
} catch (e) { console.error('[db] driver phones backfill failed:', e.message); }

// ─── Multiple POD photos per delivery ───
// A driver may attach up to 5 proof-of-delivery photos. pods.photo_url keeps the
// FIRST photo (mirror — existing deliveries view / manifest still read it); the
// full set lives in pod_photos.
db.exec(`
CREATE TABLE IF NOT EXISTS pod_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pod_id INTEGER NOT NULL REFERENCES pods(id) ON DELETE CASCADE,
  photo_url TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_pod_photos_pod ON pod_photos(pod_id);
`);
// Backfill: seed each existing POD's single photo into pod_photos.
try {
  const r = db.prepare(`
    INSERT INTO pod_photos (pod_id, photo_url)
    SELECT id, photo_url FROM pods
    WHERE photo_url <> '' AND NOT EXISTS (SELECT 1 FROM pod_photos pp WHERE pp.pod_id = pods.id)
  `).run();
  if (r.changes) console.log(`[db] Migration: backfilled ${r.changes} POD photo(s) into pod_photos`);
} catch (e) { console.error('[db] pod_photos backfill failed:', e.message); }

// ─── Migrate: supplier portal (users.vendor_no) + shipment delivery channel ───
// vendor_no scopes a 'supplier' login to its own fresh-goods POs (matched against
// orders.po_vendor_no). Empty for every non-supplier user.
try { db.exec("ALTER TABLE users ADD COLUMN vendor_no TEXT DEFAULT ''"); } catch (e) { /* already exists */ }
// channel routes a shipment to its fulfilment lane:
//   'supplier' — fresh goods (ของสด): drop-shipped by the vendor, status managed in
//                the supplier portal, never enters a TMS trip
//   'cti'      — general goods: dispatched through CTI's TMS trip system (default)
try { db.exec("ALTER TABLE shipments ADD COLUMN channel TEXT DEFAULT 'cti'"); } catch (e) { /* already exists */ }
// One-time backfill of shipments created before the channel column existed: tag
// fresh-goods orders 'supplier', leave the rest 'cti'. Mirrors categoryGroupSrv()
// in server.js — keep the 030xxx fresh-item list in sync if BC adds fresh categories.
// Safe to re-run: the channel='cti' guard skips already-tagged rows.
try {
  const r = db.prepare(`UPDATE shipments SET channel='supplier'
    WHERE channel='cti' AND order_id IN (
      SELECT DISTINCT ol.order_id FROM order_lines ol
      LEFT JOIN items_cache ic ON ic.item_no = ol.item_no
      WHERE ic.category = 'Fruit fresh'
         OR ol.item_no IN ('030024','030081','030012','030013','030014','030019')
    )`).run();
  if (r.changes) console.log(`[db] Migration: tagged ${r.changes} fresh-goods shipment(s) channel='supplier'`);
} catch (e) { console.error('[db] shipment channel backfill failed:', e.message); }
// Delivery employee name recorded by the supplier at each status transition
// (captured at เริ่มจัดส่ง, verifiable at ยืนยันส่งถึง).
try { db.exec("ALTER TABLE shipments ADD COLUMN deliverer TEXT DEFAULT ''"); } catch (e) { /* already exists */ }

// ─── Warehouse picking gate (TMS, general goods only) ───
// General-goods (channel='cti') orders now pass through a warehouse PICK queue
// BEFORE a shipment exists, so the warehouse and the transport desk see distinct
// work. Lifecycle:
//   ''        — not in the pick flow (fruit/supplier orders, or pre-feature rows)
//   'to_pick' — BC SO/TO done; waiting for the warehouse to pick & pack
//   'picked'  — warehouse confirmed; Shipment number issued → enters CTI trip pool
// Distinct from fulfillment_status, which tracks goods-RECEIPT at the branch.
try { db.exec("ALTER TABLE orders ADD COLUMN pick_status TEXT DEFAULT ''"); } catch (e) { /* already exists */ }
try { db.exec("ALTER TABLE orders ADD COLUMN picked_at TEXT"); } catch (e) { /* already exists */ }
try { db.exec("ALTER TABLE orders ADD COLUMN picked_by TEXT"); } catch (e) { /* already exists */ } // login that confirmed the pick
try { db.exec("ALTER TABLE orders ADD COLUMN picked_by_name TEXT DEFAULT ''"); } catch (e) { /* already exists */ } // free-text: who physically picked/packed

// Seed a sample carrier + driver so admins can exercise the UI on day 1.
// Idempotent: skipped if any carrier exists. Default password is 'drv1234' —
// change after first login (driver PWA exposes /api/tms/driver/me/password later).
try {
  const carrierCount = db.prepare('SELECT COUNT(*) c FROM carriers').get().c;
  if (carrierCount === 0) {
    const insC = db.prepare(`INSERT INTO carriers (code, name, contact_phone, default_cost_per_trip, note)
      VALUES (?,?,?,?,?)`);
    const c1 = insC.run('DEMO-LOG', 'Demo Logistics (ตัวอย่าง)', '02-000-0000', 1500, 'sample carrier — replace with real one');
    const insD = db.prepare(`INSERT INTO carrier_drivers (carrier_id, username, password, full_name, phone, vehicle_plate)
      VALUES (?,?,?,?,?,?)`);
    insD.run(c1.lastInsertRowid, 'driver01', bcrypt.hashSync('drv1234', 10), 'คนขับ ตัวอย่าง 1', '0810000001', 'กข-1234');
    console.log('[db] Seeded TMS carrier DEMO-LOG + driver01 (phone 0810000001)');
  }
} catch (e) { console.error('[db] TMS seed failed:', e.message); }

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
