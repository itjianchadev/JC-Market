require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const db = require('./db');
const bcrypt = require('bcryptjs');
const { login, requireAuth, requireAdmin, requireSuperAdmin, canManageBranch, isHqAdmin, isSuperAdmin, HQ_ROLES, BRANCH_ROLES } = require('./auth');
const bc = require('./bc-client');
const { syncItems, getLastSync } = require('./sync');
const { generateQR } = require('./qr');
const { verifySlip, hashFile, MOCK_VERIFY } = require('./slip-verify');

const PORT = process.env.PORT || 3862;
const SYNC_INTERVAL = (parseInt(process.env.ITEM_SYNC_INTERVAL_MINUTES) || 5) * 60 * 1000;
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Multer for slip upload
const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, 'uploads'),
    filename: (req, file, cb) => cb(null, `slip_${Date.now()}_${Math.random().toString(36).slice(2,8)}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/image\/(jpeg|png|webp)|application\/pdf/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image/pdf allowed'));
  },
});

// ─── Auth ───
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const r = login(username, password);
  if (!r) return res.status(401).json({ error: 'Invalid credentials' });
  res.json(r);
});

app.get('/api/me', requireAuth, (req, res) => {
  const u = db.prepare('SELECT id, username, full_name, role, branch_code, branch_name, bc_customer_no, can_order FROM users WHERE id=?').get(req.user.id);
  if (u) u.can_order = !!u.can_order;
  res.json(u);
});

// ─────────────── Branches (HQ admin CRUD) ───────────────

// List branches — HQ admins see all, others see own
// Compute days_remaining + status from an expires_at YYYY-MM-DD string.
// Same shape as the global /api/admin/license computation so the UI can
// reuse one renderer for both.
function computeLicenseFields(expiresAt) {
  if (!expiresAt) return { days_remaining: null, license_status: 'unset' };
  const exp = new Date(expiresAt + (expiresAt.length === 10 ? 'T23:59:59' : ''));
  const days = Math.ceil((exp - new Date()) / 86400000);
  let status = 'active';
  if (days < 0) status = 'expired';
  else if (days <= 30) status = 'expiring_soon';
  return { days_remaining: days, license_status: status };
}

app.get('/api/branches', requireAuth, (req, res) => {
  let rows;
  if (isHqAdmin(req.user)) {
    rows = db.prepare('SELECT * FROM branches ORDER BY code').all();
  } else {
    rows = db.prepare('SELECT * FROM branches WHERE code=?').all(req.user.branch_code || '');
  }
  // Attach user counts + license status
  const cntStmt = db.prepare("SELECT COUNT(*) c FROM users WHERE branch_code=? AND active=1");
  for (const b of rows) {
    b.user_count = cntStmt.get(b.code).c;
    b.show_tax_id = !!b.show_tax_id;
    b.active = !!b.active;
    Object.assign(b, computeLicenseFields(b.license_expires_at));
  }
  res.json(rows);
});

app.get('/api/branches/:code', requireAuth, (req, res) => {
  const b = db.prepare('SELECT * FROM branches WHERE code=?').get(req.params.code);
  if (!b) return res.status(404).json({ error: 'Branch not found' });
  if (!canManageBranch(req.user, b.code) && req.user.branch_code !== b.code) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  b.show_tax_id = !!b.show_tax_id;
  b.active = !!b.active;
  res.json(b);
});

// Create branch + initial branch_owner user (Super Admin only, atomic)
app.post('/api/branches', requireAuth, requireSuperAdmin, (req, res) => {
  const {
    code, name, bc_customer_no = '', address = '', phone = '',
    manager_email = '', tax_id = '', show_tax_id = 1,
    admin_username, admin_password, admin_full_name,
  } = req.body || {};
  if (!code || !name) return res.status(400).json({ error: 'code/name required' });
  if (!admin_username || !admin_password || !admin_full_name) {
    return res.status(400).json({ error: 'admin_username/admin_password/admin_full_name required' });
  }
  if (db.prepare('SELECT 1 FROM branches WHERE code=?').get(code)) {
    return res.status(400).json({ error: 'Branch code already exists' });
  }
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(admin_username)) {
    return res.status(400).json({ error: 'Username already exists' });
  }
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO branches (code, name, bc_customer_no, address, phone, manager_email, tax_id, show_tax_id)
      VALUES (?,?,?,?,?,?,?,?)`).run(code, name, bc_customer_no, address, phone, manager_email, tax_id, show_tax_id ? 1 : 0);
    db.prepare(`INSERT INTO users (id, username, password, full_name, role, branch_code, branch_name, bc_customer_no, can_order)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      crypto.randomUUID(), admin_username, bcrypt.hashSync(admin_password, 10),
      admin_full_name, 'branch_owner', code, name, bc_customer_no, 1
    );
  });
  tx();
  res.json({ ok: true, code });
});

// Update branch (Super Admin = full edit; branch_owner of own branch = contact fields only)
app.put('/api/branches/:code', requireAuth, (req, res) => {
  const b = db.prepare('SELECT * FROM branches WHERE code=?').get(req.params.code);
  if (!b) return res.status(404).json({ error: 'Branch not found' });
  const isSuper = isSuperAdmin(req.user);
  const isBranchOwner = req.user.role === 'branch_owner' && req.user.branch_code === b.code;
  if (!isSuper && !isBranchOwner) return res.status(403).json({ error: 'Forbidden' });

  const p = req.body || {};
  // Super Admin can change anything (including per-branch license fields);
  // branch_owner can change only contact + show_tax_id.
  if (isSuper) {
    db.prepare(`UPDATE branches SET name=?, bc_customer_no=?, address=?, phone=?, manager_email=?, tax_id=?, show_tax_id=?, active=?, license_key=?, license_issued_at=?, license_expires_at=? WHERE code=?`)
      .run(
        p.name ?? b.name,
        p.bc_customer_no ?? b.bc_customer_no,
        p.address ?? b.address,
        p.phone ?? b.phone,
        p.manager_email ?? b.manager_email,
        p.tax_id ?? b.tax_id,
        (p.show_tax_id ?? b.show_tax_id) ? 1 : 0,
        (p.active ?? b.active) ? 1 : 0,
        p.license_key ?? b.license_key ?? '',
        p.license_issued_at ?? b.license_issued_at,
        p.license_expires_at ?? b.license_expires_at,
        b.code
      );
  } else {
    db.prepare(`UPDATE branches SET address=?, phone=?, manager_email=?, show_tax_id=? WHERE code=?`)
      .run(
        p.address ?? b.address,
        p.phone ?? b.phone,
        p.manager_email ?? b.manager_email,
        (p.show_tax_id ?? b.show_tax_id) ? 1 : 0,
        b.code
      );
  }
  res.json({ ok: true });
});

// Deactivate branch (Super Admin only, soft delete)
app.delete('/api/branches/:code', requireAuth, requireSuperAdmin, (req, res) => {
  const b = db.prepare('SELECT * FROM branches WHERE code=?').get(req.params.code);
  if (!b) return res.status(404).json({ error: 'Branch not found' });
  db.prepare('UPDATE branches SET active=0 WHERE code=?').run(b.code);
  db.prepare('UPDATE users SET active=0 WHERE branch_code=?').run(b.code);
  res.json({ ok: true });
});

// ─────────────── Users (HQ or branch_owner CRUD) ───────────────

const ROLES_ALL = new Set([...HQ_ROLES, ...BRANCH_ROLES]);

app.get('/api/users', requireAuth, (req, res) => {
  const branchCode = req.query.branch_code || '';
  let rows;
  if (isSuperAdmin(req.user)) {
    rows = branchCode
      ? db.prepare('SELECT id, username, full_name, role, branch_code, branch_name, can_order, active, phone, created_at FROM users WHERE branch_code=? ORDER BY role, full_name').all(branchCode)
      : db.prepare('SELECT id, username, full_name, role, branch_code, branch_name, can_order, active, phone, created_at FROM users ORDER BY branch_code, role, full_name').all();
  } else if (req.user.role === 'admin_scm') {
    // admin_scm เห็น/จัดการเฉพาะ admin_scm ด้วยกัน (SCM department members)
    rows = db.prepare("SELECT id, username, full_name, role, branch_code, branch_name, can_order, active, phone, created_at FROM users WHERE role='admin_scm' ORDER BY full_name").all();
  } else if (req.user.role === 'branch_owner') {
    rows = db.prepare('SELECT id, username, full_name, role, branch_code, branch_name, can_order, active, phone, created_at FROM users WHERE branch_code=? ORDER BY role, full_name').all(req.user.branch_code);
  } else {
    return res.status(403).json({ error: 'Forbidden' });
  }
  for (const r of rows) { r.can_order = !!r.can_order; r.active = !!r.active; }
  res.json(rows);
});

app.post('/api/users', requireAuth, (req, res) => {
  const { username, password, full_name, role, branch_code, phone = '', can_order } = req.body || {};
  if (!username || !password || !full_name || !role) return res.status(400).json({ error: 'Missing fields' });
  if (!ROLES_ALL.has(role)) return res.status(400).json({ error: 'Invalid role' });

  const isSuper = isSuperAdmin(req.user);
  const isScm = req.user.role === 'admin_scm';
  const isBranchOwner = req.user.role === 'branch_owner';
  if (!isSuper && !isScm && !isBranchOwner) return res.status(403).json({ error: 'Forbidden' });

  // Only super_admin can create super_admin
  if (role === 'super_admin' && !isSuper) {
    return res.status(403).json({ error: 'Only Super Admin can create Super Admin' });
  }
  // admin_scm can only create admin_scm (fellow SCM dept members)
  if (isScm && role !== 'admin_scm') {
    return res.status(403).json({ error: 'SCM Admin can only create SCM Admin users' });
  }
  // branch_owner can only create in own branch, branch-level roles (not HQ, not another branch_owner)
  if (isBranchOwner) {
    if (branch_code !== req.user.branch_code) return res.status(403).json({ error: 'Cannot create outside own branch' });
    if (HQ_ROLES.has(role) || role === 'branch_owner') return res.status(403).json({ error: 'Cannot create HQ/branch_owner roles' });
  }
  // HQ roles must have no branch; branch roles must have branch
  if (HQ_ROLES.has(role) && branch_code) return res.status(400).json({ error: 'HQ role must not have branch_code' });
  if (!HQ_ROLES.has(role) && !branch_code) return res.status(400).json({ error: 'branch_code required' });

  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) {
    return res.status(400).json({ error: 'Username already exists' });
  }

  // Resolve branch meta
  let branchName = '', bcCust = '';
  if (branch_code) {
    const br = db.prepare('SELECT name, bc_customer_no FROM branches WHERE code=? AND active=1').get(branch_code);
    if (!br) return res.status(400).json({ error: 'Branch not found or inactive' });
    branchName = br.name;
    bcCust = br.bc_customer_no;
  }

  // can_order default per role
  const defaultCanOrder = (role === 'branch_owner' || role === 'store_manager') ? 1 : 0;
  const co = (can_order === undefined ? defaultCanOrder : (can_order ? 1 : 0));

  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO users (id, username, password, full_name, role, branch_code, branch_name, bc_customer_no, phone, can_order)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    id, username, bcrypt.hashSync(password, 10), full_name, role,
    branch_code || '', branchName, bcCust, phone, co
  );
  res.json({ ok: true, id });
});

app.put('/api/users/:id', requireAuth, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const isSuper = isSuperAdmin(req.user);
  const isScm = req.user.role === 'admin_scm';
  const isBranchOwner = req.user.role === 'branch_owner' && req.user.branch_code === target.branch_code;
  const isSelf = req.user.id === target.id;
  if (!isSuper && !isScm && !isBranchOwner && !isSelf) return res.status(403).json({ error: 'Forbidden' });

  // admin_scm can only edit admin_scm users (incl. self); cannot touch super_admin or branch-level
  if (isScm && target.role !== 'admin_scm') {
    return res.status(403).json({ error: 'SCM Admin can only edit SCM Admin users' });
  }
  // Non-super cannot edit super_admin
  if (target.role === 'super_admin' && !isSuper && !isSelf) {
    return res.status(403).json({ error: 'Only Super Admin can edit Super Admin users' });
  }

  const p = req.body || {};

  // Only super_admin can assign super_admin role
  if (p.role === 'super_admin' && !isSuper) {
    return res.status(403).json({ error: 'Only Super Admin can assign Super Admin role' });
  }
  // admin_scm cannot change target's role to anything other than admin_scm
  if (isScm && p.role && p.role !== 'admin_scm') {
    return res.status(403).json({ error: 'SCM Admin cannot change role outside SCM' });
  }
  // branch_owner cannot escalate role to HQ/branch_owner, cannot move branch
  if (isBranchOwner && !isSuper) {
    if (p.role && (HQ_ROLES.has(p.role) || p.role === 'branch_owner') && p.role !== target.role) {
      return res.status(403).json({ error: 'Cannot assign HQ/branch_owner role' });
    }
    if (p.branch_code && p.branch_code !== target.branch_code) {
      return res.status(403).json({ error: 'Cannot move to another branch' });
    }
  }
  // self-edit by non-admin non-branch-owner: cannot change own role / active / can_order / branch
  if (isSelf && !isSuper && !isScm && !isBranchOwner) {
    if ('role' in p || 'branch_code' in p || 'can_order' in p || 'active' in p) {
      return res.status(403).json({ error: 'Cannot change own role/branch/permissions' });
    }
  }

  const fields = [];
  const vals = [];
  const add = (col, v) => { fields.push(`${col}=?`); vals.push(v); };
  if ('full_name' in p) add('full_name', p.full_name);
  if ('phone' in p) add('phone', p.phone);
  if ('role' in p && ROLES_ALL.has(p.role) && (isSuper || (isScm && p.role === 'admin_scm') || !HQ_ROLES.has(p.role))) add('role', p.role);
  if ('can_order' in p) add('can_order', p.can_order ? 1 : 0);
  if ('active' in p) add('active', p.active ? 1 : 0);
  if (isSuper && 'branch_code' in p) {
    const br = p.branch_code ? db.prepare('SELECT name, bc_customer_no FROM branches WHERE code=?').get(p.branch_code) : null;
    add('branch_code', p.branch_code || '');
    add('branch_name', br ? br.name : '');
    add('bc_customer_no', br ? br.bc_customer_no : '');
  }
  if (p.password) add('password', bcrypt.hashSync(p.password, 10));

  if (!fields.length) return res.json({ ok: true, noop: true });
  vals.push(target.id);
  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id=?`).run(...vals);
  res.json({ ok: true });
});

// Reset password — super_admin: anyone; admin_scm: admin_scm only; branch_owner: own-branch non-HQ
app.post('/api/users/:id/reset-password', requireAuth, (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password too short (min 6)' });
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const isSuper = isSuperAdmin(req.user);
  const isScm = req.user.role === 'admin_scm';
  const isBranchOwner = req.user.role === 'branch_owner' && req.user.branch_code === target.branch_code;
  if (!isSuper && !isScm && !isBranchOwner) return res.status(403).json({ error: 'Forbidden' });
  if (isScm && target.role !== 'admin_scm') return res.status(403).json({ error: 'SCM Admin can only reset SCM Admin passwords' });
  if (target.role === 'super_admin' && !isSuper) return res.status(403).json({ error: 'Only Super Admin can reset Super Admin password' });
  db.prepare('UPDATE users SET password=? WHERE id=?').run(bcrypt.hashSync(password, 10), target.id);
  res.json({ ok: true });
});

// Deactivate user — super_admin: anyone; admin_scm: admin_scm only; branch_owner: own-branch non-HQ
app.delete('/api/users/:id', requireAuth, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'Cannot deactivate self' });
  const isSuper = isSuperAdmin(req.user);
  const isScm = req.user.role === 'admin_scm';
  const isBranchOwner = req.user.role === 'branch_owner' && req.user.branch_code === target.branch_code;
  if (!isSuper && !isScm && !isBranchOwner) return res.status(403).json({ error: 'Forbidden' });
  if (isScm && target.role !== 'admin_scm') return res.status(403).json({ error: 'SCM Admin can only deactivate SCM Admin users' });
  if (target.role === 'super_admin' && !isSuper) return res.status(403).json({ error: 'Only Super Admin can deactivate Super Admin' });
  db.prepare('UPDATE users SET active=0 WHERE id=?').run(target.id);
  res.json({ ok: true });
});

// ─── Items (from cache) ───
app.get('/api/items', requireAuth, (req, res) => {
  const { q = '', category = '' } = req.query;
  let sql = 'SELECT * FROM items_cache WHERE active=1';
  const params = [];
  if (q) { sql += ' AND (name LIKE ? OR name_en LIKE ? OR item_no LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (category) { sql += ' AND category=?'; params.push(category); }
  sql += ' ORDER BY category, name';
  const items = db.prepare(sql).all(...params);

  // HQ Admin: attach last-order info per item (latest non-cancelled order)
  if (isHqAdmin(req.user) && items.length) {
    const lastByItem = db.prepare(`
      WITH ranked AS (
        SELECT ol.item_no, o.order_number, o.bc_po_no, o.created_at, o.payment_status,
               ol.quantity, u.branch_code, u.branch_name,
               ROW_NUMBER() OVER (PARTITION BY ol.item_no ORDER BY o.created_at DESC) AS rn
        FROM order_lines ol
        JOIN orders o ON o.id = ol.order_id
        LEFT JOIN users u ON u.id = o.user_id
        WHERE o.payment_status <> 'cancelled'
      )
      SELECT item_no, order_number, bc_po_no, created_at, payment_status, quantity, branch_code, branch_name
      FROM ranked WHERE rn = 1
    `).all();
    const byNo = {};
    for (const r of lastByItem) byNo[r.item_no] = r;
    for (const it of items) it.last_order = byNo[it.item_no] || null;
  }
  res.json(items);
});

// HQ Admin: per-item full order history
app.get('/api/admin/items/:item_no/history', requireAuth, requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT ol.item_no, ol.item_name, ol.quantity, ol.unit_price, ol.line_total,
           o.order_number, o.bc_po_no, o.bc_so_no, o.payment_status, o.fulfillment_status, o.created_at,
           u.branch_code, u.branch_name, u.full_name as user_name
    FROM order_lines ol
    JOIN orders o ON o.id = ol.order_id
    LEFT JOIN users u ON u.id = o.user_id
    WHERE ol.item_no = ?
    ORDER BY o.created_at DESC
    LIMIT 200
  `).all(req.params.item_no);
  res.json(rows);
});

app.get('/api/items/categories', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT DISTINCT category FROM items_cache WHERE active=1 AND category<>"" ORDER BY category').all().map(r => r.category));
});

// ─── Cart ───
// Top-level category grouping for the "no mixed-category orders" rule.
// Must mirror FRUIT_CATEGORIES in public/js/app.js — keep these two in sync
// whenever BC adds a new fresh-fruit category code.
const FRUIT_CATEGORIES_SRV = new Set(['Fruit fresh']);
const categoryGroupSrv = cat => FRUIT_CATEGORIES_SRV.has(cat) ? 'fruit' : 'general';
const groupLabelTH = g => g === 'fruit' ? 'ผลไม้สด' : 'สินค้าทั่วไป';

// Block-list helper: a FC with any past-due credit order can't place new
// fruit orders until they've settled. Returns the count of outstanding
// overdue credits — 0 means clear to order fruit.
function overdueCreditCount(userId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS c FROM orders
    WHERE user_id = ?
      AND payment_method = 'credit_7d'
      AND payment_status NOT IN ('verified', 'cancelled')
      AND credit_due_at != ''
      AND credit_due_at < datetime('now', 'localtime')
  `).get(userId);
  return row ? row.c : 0;
}

app.get('/api/cart', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.item_no, c.quantity, c.unit_price,
           i.name as item_name, i.name_en as item_name_en, i.category, i.uom, i.inventory
    FROM cart_items c
    LEFT JOIN items_cache i ON i.item_no = c.item_no
    WHERE c.user_id = ?
    ORDER BY c.created_at
  `).all(req.user.id);
  const subtotal = rows.reduce((s, r) => s + r.quantity * r.unit_price, 0);
  res.json({ items: rows, subtotal, total: subtotal, count: rows.length });
});

app.post('/api/cart/add', requireAuth, (req, res) => {
  if (isHqAdmin(req.user)) return res.status(403).json({ error: 'HQ Admin ไม่ใช่ผู้สั่งซื้อ / HQ Admin cannot place orders' });
  const { item_no, quantity = 1 } = req.body;
  if (!item_no) return res.status(400).json({ error: 'item_no required' });
  const item = db.prepare('SELECT * FROM items_cache WHERE item_no=? AND active=1').get(item_no);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (!item.unit_price || item.unit_price <= 0) return res.status(400).json({ error: 'ราคาไม่พร้อม — ติดต่อ HQ / Price unavailable — contact HQ' });

  // Overdue credit block: if this is a fruit item and the FC still has
  // past-due 7-day credit orders, refuse. General items are unaffected.
  if (categoryGroupSrv(item.category) === 'fruit') {
    const overdue = overdueCreditCount(req.user.id);
    if (overdue > 0) {
      return res.status(400).json({
        error: `มีออร์เดอร์เครดิตเกินกำหนดค้างอยู่ ${overdue} รายการ — กรุณาชำระให้ครบก่อนสั่งผลไม้สดใหม่`,
      });
    }
  }

  // Enforce single-group orders. Look at any one item already in this user's
  // cart — if its group differs from the new item's, block. (Cart is uniform
  // by induction, so checking any one row is enough.)
  const cartSample = db.prepare(`
    SELECT i.category FROM cart_items c
    JOIN items_cache i ON i.item_no = c.item_no
    WHERE c.user_id = ? LIMIT 1
  `).get(req.user.id);
  if (cartSample) {
    const existingGroup = categoryGroupSrv(cartSample.category);
    const newGroup = categoryGroupSrv(item.category);
    if (existingGroup !== newGroup) {
      return res.status(400).json({
        error: `ห้ามสั่งของข้ามหมวด — ตะกร้าเป็น "${groupLabelTH(existingGroup)}" อยู่แล้ว ของชิ้นนี้อยู่ในหมวด "${groupLabelTH(newGroup)}" กรุณาแยกออร์เดอร์ (checkout หรือล้างตะกร้าก่อน)`,
      });
    }
  }

  const existing = db.prepare('SELECT * FROM cart_items WHERE user_id=? AND item_no=?').get(req.user.id, item_no);
  const newQty = existing ? existing.quantity + quantity : quantity;
  if (newQty > item.inventory) return res.status(400).json({ error: `สต๊อกไม่เพียงพอ (คงเหลือ ${item.inventory} ${item.uom})` });
  if (existing) {
    db.prepare('UPDATE cart_items SET quantity=? WHERE id=?').run(newQty, existing.id);
  } else {
    db.prepare('INSERT INTO cart_items (user_id, item_no, quantity, unit_price) VALUES (?,?,?,?)').run(req.user.id, item_no, quantity, item.unit_price);
  }
  res.json({ ok: true, item_no, quantity: newQty });
});

app.put('/api/cart/:id', requireAuth, (req, res) => {
  const { quantity } = req.body;
  const row = db.prepare('SELECT c.*, i.inventory FROM cart_items c LEFT JOIN items_cache i ON i.item_no=c.item_no WHERE c.id=? AND c.user_id=?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Cart item not found' });
  if (quantity <= 0) { db.prepare('DELETE FROM cart_items WHERE id=?').run(row.id); return res.json({ ok: true, deleted: true }); }
  if (quantity > row.inventory) return res.status(400).json({ error: `สต๊อกไม่เพียงพอ (คงเหลือ ${row.inventory})` });
  db.prepare('UPDATE cart_items SET quantity=? WHERE id=?').run(quantity, row.id);
  res.json({ ok: true, quantity });
});

app.delete('/api/cart/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM cart_items WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

app.delete('/api/cart', requireAuth, (req, res) => {
  db.prepare('DELETE FROM cart_items WHERE user_id=?').run(req.user.id);
  res.json({ ok: true });
});

app.get('/api/cart/count', requireAuth, (req, res) => {
  const r = db.prepare('SELECT COALESCE(SUM(quantity),0) as count FROM cart_items WHERE user_id=?').get(req.user.id);
  // overdue_credit_count lets the shop page banner appear without an extra
  // round-trip. Branch-side users only; HQ/admin never see fruit-block.
  const overdue = isHqAdmin(req.user) ? 0 : overdueCreditCount(req.user.id);
  res.json({ count: r.count, overdue_credit_count: overdue });
});

// ─── Orders: Checkout ───
function genOrderNumber() {
  const d = new Date();
  // Prefix is SO — checkout creates a Sales Order in BC (PO is no longer part of this flow).
  const prefix = `SO${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  const last = db.prepare("SELECT order_number FROM orders WHERE order_number LIKE ? ORDER BY order_number DESC LIMIT 1").get(prefix + '%');
  const seq = last ? parseInt(last.order_number.slice(-4)) + 1 : 1;
  return prefix + String(seq).padStart(4, '0');
}

app.post('/api/orders/checkout', requireAuth, async (req, res) => {
  // can_order permission check. HQ admin ไม่ใช่คนสั่งของ — ปิดเด็ดขาด
  if (isHqAdmin(req.user)) return res.status(403).json({ error: 'HQ Admin ไม่ใช่ผู้สั่งซื้อ / HQ Admin cannot place orders' });
  const u = db.prepare('SELECT can_order FROM users WHERE id=?').get(req.user.id);
  if (!u || !u.can_order) return res.status(403).json({ error: 'ไม่มีสิทธิ์สั่งซื้อ / Not allowed to order' });
  const { note = '', payment_method: rawMethod = 'immediate' } = req.body || {};
  // Detect whether the FC/JC user is in a master (JC) branch — drives the
  // payment-skip + Transfer-Order routing later in this function.
  const branchRow = req.user.branch_code
    ? db.prepare('SELECT branch_type FROM branches WHERE code = ?').get(req.user.branch_code)
    : null;
  const isJcBranch = branchRow && branchRow.branch_type === 'jc';
  // JC branches don't pay — force immediate (credit_7d makes no sense without payment).
  const paymentMethod = (!isJcBranch && rawMethod === 'credit_7d') ? 'credit_7d' : 'immediate';
  // Get cart
  const cartItems = db.prepare(`
    SELECT c.item_no, c.quantity, c.unit_price, i.name as item_name, i.inventory, i.uom, i.category
    FROM cart_items c LEFT JOIN items_cache i ON i.item_no=c.item_no
    WHERE c.user_id=?
  `).all(req.user.id);

  if (!cartItems.length) return res.status(400).json({ error: 'ตะกร้าว่าง' });

  // Single-group enforcement — defense in depth (also blocked at /cart/add).
  // Catches legacy carts built before this rule was added, e.g. from a reorder.
  const groups = new Set(cartItems.map(ci => categoryGroupSrv(ci.category)));
  if (groups.size > 1) {
    return res.status(400).json({
      error: 'ห้ามสั่งของข้ามหมวดในออร์เดอร์เดียว — ตะกร้ามีทั้ง "สินค้าทั่วไป" และ "ผลไม้สด" กรุณาแยกออร์เดอร์',
    });
  }

  // Credit-7d is only available for fruit orders.
  const isFruitOrder = groups.has('fruit');
  if (paymentMethod === 'credit_7d' && !isFruitOrder) {
    return res.status(400).json({ error: 'เครดิต 7 วันใช้ได้กับ "ผลไม้สด" เท่านั้น' });
  }

  // Defense in depth — same overdue-credit gate as /cart/add. Catches the
  // case where items were added before a credit went overdue.
  if (isFruitOrder) {
    const overdue = overdueCreditCount(req.user.id);
    if (overdue > 0) {
      return res.status(400).json({
        error: `มีออร์เดอร์เครดิตเกินกำหนดค้างอยู่ ${overdue} รายการ — กรุณาชำระให้ครบก่อนสั่งผลไม้สดใหม่`,
      });
    }
  }

  // Validate stock
  for (const ci of cartItems) {
    if (ci.quantity > ci.inventory) {
      return res.status(400).json({ error: `${ci.item_name} สต๊อกไม่เพียงพอ (คงเหลือ ${ci.inventory} ${ci.uom})` });
    }
  }

  const orderId = crypto.randomUUID();
  const orderNumber = genOrderNumber();
  const subtotal = cartItems.reduce((s, r) => s + r.quantity * r.unit_price, 0);

  // Credit-7d due date — only set when credit is chosen; otherwise blank.
  const creditDueAt = paymentMethod === 'credit_7d'
    ? db.prepare("SELECT datetime('now', '+7 days', 'localtime') AS d").get().d
    : '';

  // Order type drives which BC document we'll create later in this function
  // and whether the order goes through the Finance pipeline at all.
  const orderType = isJcBranch
    ? (isFruitOrder ? 'jc_purchase' : 'jc_transfer')
    : 'fc_purchase';
  // JC orders skip Finance entirely — flip straight to 'verified' so they
  // never appear in the Finance approval queue and aren't subject to the
  // 30-min auto-cancel timer.
  const initialPaymentStatus = isJcBranch ? 'verified' : 'pending';

  const tx = db.transaction(() => {
    // Create order (VAT=0 ก่อน จะอัพเดทจาก BC ทีหลัง)
    db.prepare(`INSERT INTO orders (id, order_number, user_id, branch_code, subtotal, vat_amount, total, note, payment_method, credit_due_at, order_type, payment_status)
      VALUES (?,?,?,?,?,0,?,?,?,?,?,?)`).run(orderId, orderNumber, req.user.id, req.user.branch_code || '', subtotal, subtotal, note, paymentMethod, creditDueAt, orderType, initialPaymentStatus);

    // Create order lines
    const insLine = db.prepare('INSERT INTO order_lines (order_id, item_no, item_name, quantity, unit_price, line_total) VALUES (?,?,?,?,?,?)');
    for (const ci of cartItems) {
      insLine.run(orderId, ci.item_no, ci.item_name, ci.quantity, ci.unit_price, ci.quantity * ci.unit_price);
    }

    // Create payment record
    db.prepare('INSERT INTO payments (order_id, amount) VALUES (?,?)').run(orderId, subtotal);

    // Deduct inventory from cache
    const deductStmt = db.prepare('UPDATE items_cache SET inventory = MAX(0, inventory - ?) WHERE item_no = ?');
    for (const ci of cartItems) {
      deductStmt.run(ci.quantity, ci.item_no);
    }

    // Clear cart
    db.prepare('DELETE FROM cart_items WHERE user_id=?').run(req.user.id);
  });
  tx();

  // Local VAT calculation — Thai standard 7%. BC is NOT contacted at
  // checkout anymore; postOrderToBC() is deferred until Finance approves
  // the slip. This prevents orphan BC SOs from customers who cancel before
  // paying and gives Finance the gatekeeper role they need for audit.
  const vatRate = 0.07;
  const vatAmount = Math.round(subtotal * vatRate * 100) / 100;
  const total = Math.round((subtotal + vatAmount) * 100) / 100;

  // Persist totals so QR / cart / receipt match what BC will later compute
  // (BC uses the same 7% standard for these customers, so the figure tracks).
  db.prepare('UPDATE orders SET vat_amount=?, total=? WHERE id=?').run(vatAmount, total, orderId);
  db.prepare('UPDATE payments SET amount=? WHERE order_id=?').run(total, orderId);

  // Generate PromptPay QR for FC only — JC branches don't pay.
  let qrDataUrl = '';
  if (!isJcBranch) {
    try {
      qrDataUrl = await generateQR(total);
    } catch (e) {
      console.error('[QR]', e.message);
    }
  }

  // BC document creation depends on the orderType:
  //   fc_purchase + general  → no BC at checkout (Finance approve creates SO+PO)
  //   fc_purchase + fruit    → BC SO + BC PO immediately
  //   jc_transfer            → BC Transfer Order (CTI → JC0xx)
  //   jc_purchase            → BC PO only (no SO — internal, not a sale)
  let bcSoResult = null, bcPoResult = null, bcToResult = null;
  const defaultVendor = (process.env.BC_DEFAULT_VENDOR_NO || '').trim();

  if (orderType === 'fc_purchase' && isFruitOrder) {
    try {
      bcSoResult = await postOrderToBC(orderId);
    } catch (e) {
      console.error('[checkout → BC SO]', e.message);
      db.prepare("UPDATE orders SET bc_sync_error=? WHERE id=?").run(e.message, orderId);
      bcSoResult = { ok: false, error: e.message };
    }
    if (bcSoResult && bcSoResult.bc_so_no && defaultVendor) {
      try {
        bcPoResult = await postPOToBC(orderId, defaultVendor);
      } catch (e) {
        console.error('[checkout → BC PO]', e.message);
        db.prepare("UPDATE orders SET bc_sync_error=? WHERE id=?").run('[PO] ' + e.message, orderId);
        bcPoResult = { ok: false, error: e.message };
      }
    }
  } else if (orderType === 'jc_transfer') {
    try {
      bcToResult = await postTransferOrderToBC(orderId, req.user.branch_code);
    } catch (e) {
      console.error('[checkout → BC TO]', e.message);
      db.prepare("UPDATE orders SET bc_sync_error=? WHERE id=?").run('[TO] ' + e.message, orderId);
      bcToResult = { ok: false, error: e.message };
    }
  } else if (orderType === 'jc_purchase') {
    if (defaultVendor) {
      try {
        bcPoResult = await postPOToBC(orderId, defaultVendor);
      } catch (e) {
        console.error('[checkout → BC PO (JC)]', e.message);
        db.prepare("UPDATE orders SET bc_sync_error=? WHERE id=?").run('[PO] ' + e.message, orderId);
        bcPoResult = { ok: false, error: e.message };
      }
    }
  }

  // Grab created_at (set by SQLite DEFAULT) so client can sync countdown with server time
  const createdRow = db.prepare('SELECT created_at FROM orders WHERE id=?').get(orderId);

  let msgBase;
  if (orderType === 'jc_transfer') {
    msgBase = `สร้างคำสั่งซื้อ ${orderNumber} (สาขา JC) — ${bcToResult && bcToResult.bc_to_no ? 'BC TO ' + bcToResult.bc_to_no : 'BC TO ค้าง (retry)'}`;
  } else if (orderType === 'jc_purchase') {
    msgBase = `สร้างคำสั่งซื้อ ${orderNumber} (สาขา JC · ผลไม้สด) — ${bcPoResult && bcPoResult.bc_po_no ? 'BC PO ' + bcPoResult.bc_po_no : 'BC PO ค้าง (retry)'}`;
  } else if (paymentMethod === 'credit_7d') {
    msgBase = `สร้างคำสั่งซื้อ ${orderNumber} (เครดิต 7 วัน) — กำหนดชำระภายใน ${creditDueAt}`;
  } else {
    msgBase = `สร้างคำสั่งซื้อ ${orderNumber} — โอนชำระเงินและส่งสลิปเพื่อให้ Finance ตรวจสอบ`;
  }

  res.json({
    ok: true,
    order_id: orderId,
    order_number: orderNumber,
    subtotal,
    vat_amount: vatAmount,
    total,
    payment_method: paymentMethod,
    credit_due_at: creditDueAt,
    is_fruit: isFruitOrder,
    is_jc: isJcBranch,
    order_type: orderType,
    bc_so: bcSoResult,
    bc_po: bcPoResult,
    bc_to: bcToResult,
    qr_data_url: qrDataUrl,
    created_at: createdRow ? createdRow.created_at : null,
    cancel_timeout_min: paymentMethod === 'credit_7d' ? 10080 : 30, // 10080 min = 7 days; UI uses it for countdown only — credit orders aren't auto-cancelled
    message: msgBase,
  });
});

// ─── Orders: List ───
app.get('/api/orders', requireAuth, (req, res) => {
  let sql, params;
  if (isHqAdmin(req.user)) {
    sql = `SELECT o.*, u.full_name as user_name, u.branch_name,
                  rb.full_name as rejected_by_name
           FROM orders o
           LEFT JOIN users u  ON u.id=o.user_id
           LEFT JOIN users rb ON rb.id=o.rejected_by
           ORDER BY o.created_at DESC`;
    params = [];
  } else {
    sql = `SELECT o.*, u.full_name as user_name, u.branch_name,
                  rb.full_name as rejected_by_name
           FROM orders o
           LEFT JOIN users u  ON u.id=o.user_id
           LEFT JOIN users rb ON rb.id=o.rejected_by
           WHERE o.user_id=? ORDER BY o.created_at DESC`;
    params = [req.user.id];
  }
  res.json(db.prepare(sql).all(...params));
});

// ─── Orders: Detail ───
app.get('/api/orders/:id', requireAuth, (req, res) => {
  const order = db.prepare(`
    SELECT o.*, rb.full_name as rejected_by_name
    FROM orders o
    LEFT JOIN users rb ON rb.id = o.rejected_by
    WHERE o.id=?`).get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!isHqAdmin(req.user) && order.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  const lines = db.prepare('SELECT ol.*, i.name_en as item_name_en FROM order_lines ol LEFT JOIN items_cache i ON i.item_no=ol.item_no WHERE ol.order_id=?').all(order.id);
  const payment = db.prepare('SELECT * FROM payments WHERE order_id=? ORDER BY id DESC LIMIT 1').get(order.id);
  const receipts = db.prepare('SELECT gr.*, u.full_name as received_by_name FROM goods_receipts gr LEFT JOIN users u ON u.id=gr.received_by WHERE gr.order_id=? ORDER BY gr.created_at DESC').all(order.id);
  res.json({ ...order, lines, payment, receipts });
});

// ─── Orders: QR regenerate ───
app.get('/api/orders/:id/qr', requireAuth, async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  // QR is needed both on first checkout ('pending') AND when re-uploading
  // after a Finance rejection ('failed') — FC may have transferred the wrong
  // amount and need the QR again to re-pay.
  if (order.payment_status !== 'pending' && order.payment_status !== 'failed') return res.status(400).json({ error: 'Order already paid' });
  try {
    const qr = await generateQR(order.total);
    res.json({ qr_data_url: qr, total: order.total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Orders: Upload slip + auto-verify (with anti-fraud) ───
app.post('/api/orders/:id/slip', requireAuth, upload.single('slip'), async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!isHqAdmin(req.user) && order.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  if (!req.file) return res.status(400).json({ error: 'No slip file' });
  if (order.payment_status === 'verified') return res.status(400).json({ error: 'Order already verified' });
  if (order.payment_status === 'cancelled') return res.status(400).json({ error: 'Order was cancelled' });
  // Block overwriting a slip that's currently waiting for Finance review.
  // Re-upload is only allowed after a Finance rejection ('failed') or for
  // the original upload ('pending').
  if (order.payment_status === 'paid') return res.status(400).json({ error: 'ส่งสลิปไปแล้ว · รอ Finance ตรวจสอบ' });

  const slipPath = '/uploads/' + req.file.filename;
  const absPath = path.join(__dirname, 'uploads', req.file.filename);
  const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  // Helper: check duplicate (called twice by verifySlip — once with hash, once with ref)
  const checkDuplicate = async ({ hash, qrRef }) => {
    if (qrRef) {
      const dupRef = db.prepare(
        `SELECT p.order_id, o.order_number FROM payments p
         JOIN orders o ON o.id = p.order_id
         WHERE p.qr_ref = ? AND p.verified = 1 AND p.order_id != ?`
      ).get(qrRef, order.id);
      if (dupRef) return { duplicate: true, reason: `สลิปนี้ (ref: ${qrRef}) ถูกใช้กับคำสั่งซื้อ ${dupRef.order_number} แล้ว` };
    }
    if (hash) {
      const dupHash = db.prepare(
        `SELECT p.order_id, o.order_number FROM payments p
         JOIN orders o ON o.id = p.order_id
         WHERE p.slip_hash = ? AND p.verified = 1 AND p.order_id != ?`
      ).get(hash, order.id);
      if (dupHash) return { duplicate: true, reason: `ภาพสลิปนี้เคยถูกใช้กับคำสั่งซื้อ ${dupHash.order_number} แล้ว` };
    }
    return { duplicate: false };
  };

  // Auto-verify slip with anti-fraud
  const result = await verifySlip(absPath, order.total, {
    orderCreatedAt: order.created_at,
    checkDuplicate,
  });

  // Log fraud attempts (when verify failed AND we had some slip data)
  if (!result.verified) {
    try {
      db.prepare(
        `INSERT INTO slip_fraud_log (order_id, user_id, username, ip, reason, slip_hash, qr_ref, slip_amount, expected_amount, trans_date, raw_response)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        order.id, req.user.id, req.user.username || '', clientIp,
        result.reason || '',
        result.slip_hash || '',
        result.ref || '',
        result.amount || 0,
        order.total,
        result.transDate || '',
        result.raw ? JSON.stringify(result.raw).slice(0, 2000) : ''
      );
    } catch (e) { /* audit log failure should not break flow */ }
  }

  // Strict-mode Finance gate: SlipOK auto-verify is INFORMATIONAL only.
  // The payment is NEVER auto-promoted to 'verified' anymore — Finance must
  // explicitly approve via /api/orders/:id/verify before the BC SO is
  // created. The auto-verify result is saved so Finance has a quick
  // "PASS / FAIL" hint when reviewing.
  db.prepare(`
    UPDATE payments SET
      slip_path=?, qr_ref=?, slip_hash=?, trans_date=?, slip_sender=?, slip_receiver=?, slip_amount=?, upload_ip=?,
      auto_verify_passed=?, auto_verify_reason=?, verified=0
    WHERE order_id=?
  `).run(
    slipPath,
    result.ref || '', result.slip_hash || '', result.transDate || '',
    result.sender || '', result.receiver || '', result.amount || 0, clientIp,
    result.verified ? 1 : 0, result.reason || '',
    order.id
  );
  // On re-upload after a Finance rejection, clear the reject audit fields
  // (the new slip starts a fresh review) and bump the retry count so Finance
  // sees this is a resubmission.
  const isRetry = order.payment_status === 'failed';
  db.prepare(`UPDATE orders SET
      payment_status='paid',
      paid_at=datetime('now','localtime'),
      reject_reason='',
      rejected_at=NULL,
      rejected_by='',
      slip_retry_count = slip_retry_count + ?
    WHERE id=?`).run(isRetry ? 1 : 0, order.id);

  res.json({
    ok: true,
    auto_verified: result.verified, // hint for the Finance reviewer
    slip_path: slipPath,
    verify_result: {
      amount: result.amount,
      sender: result.sender,
      receiver: result.receiver,
      ref: result.ref,
      reason: result.reason,
    },
    message: result.verified
      ? 'อัพโหลดสลิปสำเร็จ · ตรวจอัตโนมัติผ่าน → รอ Finance อนุมัติ'
      : 'อัพโหลดสลิปสำเร็จ · ตรวจอัตโนมัติไม่ผ่าน → รอ Finance ตรวจสอบ',
  });
});

// ─── Receipt number generator ───
function genReceiptNumber() {
  const d = new Date();
  const prefix = `RC${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  const last = db.prepare("SELECT receipt_number FROM payment_receipts WHERE receipt_number LIKE ? ORDER BY receipt_number DESC LIMIT 1").get(prefix + '%');
  const seq = last ? parseInt(last.receipt_number.slice(-4)) + 1 : 1;
  return prefix + String(seq).padStart(4, '0');
}

// ─── Orders: Finance / Admin verify payment ───
// Allowed roles: super_admin, admin_scm, finance (all in HQ_ROLES so the
// requireAdmin middleware catches them). On 'approve' we:
//   1. Flip payment_status to 'verified' + record verifier
//   2. Issue an internal receipt number
//   3. Create the BC Sales Order (postOrderToBC) — this is the moment BC
//      first learns about this transaction. If BC sync fails we still keep
//      the local approval and surface the error to admin for retry; never
//      block Finance approval just because BC is unreachable.
app.post('/api/orders/:id/verify', requireAuth, requireAdmin, async (req, res) => {
  const { action } = req.body; // 'approve' or 'reject'
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (action === 'approve') {
    const rcptId = crypto.randomUUID();
    const rcptNo = genReceiptNumber();

    try {
      const tx = db.transaction(() => {
        db.prepare("UPDATE orders SET payment_status='verified' WHERE id=?").run(order.id);
        db.prepare("UPDATE payments SET verified=1, verified_by=?, verified_at=datetime('now','localtime') WHERE order_id=?").run(req.user.id, order.id);
        db.prepare("INSERT INTO payment_receipts (id, order_id, receipt_number, issued_by, subtotal, vat_amount, total) VALUES (?,?,?,?,?,?,?)")
          .run(rcptId, order.id, rcptNo, req.user.id, order.subtotal, order.vat_amount, order.total);
      });
      tx();
    } catch (e) {
      if (String(e.message || '').includes('payments.slip_hash')) {
        return res.status(400).json({ error: 'สลิปนี้ถูกใช้กับคำสั่งซื้ออื่นที่อนุมัติไปแล้ว — ไม่สามารถอนุมัติซ้ำได้' });
      }
      if (String(e.message || '').includes('payments.qr_ref')) {
        return res.status(400).json({ error: 'QR ref ของสลิปนี้ซ้ำกับคำสั่งซื้ออื่นที่อนุมัติไปแล้ว' });
      }
      console.error('[verify approve]', e);
      return res.status(500).json({ error: 'อนุมัติไม่สำเร็จ: ' + e.message });
    }

    // BC SO creation — runs AFTER local approval so the customer is locked
    // in regardless of BC availability. If it fails, bc_sync_error is set
    // and the admin "Retry BC" button on the dashboard can re-attempt.
    let bcResult = null;
    if (!order.bc_so_id) {
      try {
        bcResult = await postOrderToBC(order.id);
      } catch (e) {
        console.error('[verify approve → BC]', e.message);
        db.prepare("UPDATE orders SET bc_sync_error=? WHERE id=?").run(e.message, order.id);
        bcResult = { ok: false, error: e.message };
      }
    } else {
      bcResult = { already: true, bc_so_no: order.bc_so_no };
    }

    // BC PO creation — only if SO succeeded AND BC_DEFAULT_VENDOR_NO is set.
    // PO failures are non-fatal and never block approval; admin can retry
    // from the Approvals "Approved" tab via the "สร้าง PO" button.
    let bcPoResult = null;
    const defaultVendor = (process.env.BC_DEFAULT_VENDOR_NO || '').trim();
    if (bcResult && bcResult.bc_so_no && !order.bc_po_no && defaultVendor) {
      try {
        bcPoResult = await postPOToBC(order.id, defaultVendor);
      } catch (e) {
        console.error('[verify approve → BC PO]', e.message);
        // Keep SO sync_error untouched; tack PO failure on with a prefix so it's distinguishable
        db.prepare("UPDATE orders SET bc_sync_error=? WHERE id=?").run('[PO] ' + e.message, order.id);
        bcPoResult = { ok: false, error: e.message };
      }
    }

    const soMsg = bcResult && bcResult.bc_so_no ? ` · BC SO ${bcResult.bc_so_no}` : (bcResult && bcResult.error ? ' · BC SO ค้าง (retry ได้)' : '');
    const poMsg = bcPoResult && bcPoResult.bc_po_no ? ` · BC PO ${bcPoResult.bc_po_no}` : (bcPoResult && bcPoResult.error ? ' · BC PO ค้าง (retry ได้)' : '');
    res.json({
      ok: true,
      receipt_number: rcptNo,
      bc_so: bcResult,
      bc_po: bcPoResult,
      message: `อนุมัติการชำระเงิน · ออกใบเสร็จ ${rcptNo}${soMsg}${poMsg}`,
    });
  } else if (action === 'reject') {
    // Finance must give a reason — surfaces back to the FC + saves to the
    // audit trail so admin can review later why a slip was bounced.
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'ต้องระบุเหตุผลในการปฏิเสธ' });
    if (reason.length > 500) return res.status(400).json({ error: 'เหตุผลยาวเกิน 500 ตัวอักษร' });

    db.prepare(`UPDATE orders SET
        payment_status='failed',
        reject_reason=?,
        rejected_at=datetime('now','localtime'),
        rejected_by=?
      WHERE id=?`)
      .run(reason, req.user.id, order.id);
    res.json({ ok: true, message: 'ปฏิเสธการชำระเงิน: ' + reason });
  } else {
    res.status(400).json({ error: 'action must be approve or reject' });
  }
});

// ─── Payment Receipt: Get by order (auto-generate for legacy verified orders) ───
app.get('/api/orders/:id/receipt', requireAuth, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!isHqAdmin(req.user) && order.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  if (order.payment_status !== 'verified') return res.status(400).json({ error: 'ยังไม่ได้อนุมัติการชำระเงิน' });

  let receipt = db.prepare(`
    SELECT pr.*, u.full_name as issued_by_name
    FROM payment_receipts pr
    LEFT JOIN users u ON u.id = pr.issued_by
    WHERE pr.order_id = ?
    ORDER BY pr.created_at DESC LIMIT 1
  `).get(order.id);

  // Auto-generate receipt for legacy verified orders that don't have one
  if (!receipt) {
    const rcptId = crypto.randomUUID();
    const rcptNo = genReceiptNumber();
    const adminUser = db.prepare("SELECT id FROM users WHERE role IN ('super_admin','admin_scm') ORDER BY CASE role WHEN 'super_admin' THEN 0 ELSE 1 END LIMIT 1").get();
    db.prepare("INSERT INTO payment_receipts (id, order_id, receipt_number, issued_by, subtotal, vat_amount, total) VALUES (?,?,?,?,?,?,?)")
      .run(rcptId, order.id, rcptNo, adminUser ? adminUser.id : '', order.subtotal, order.vat_amount, order.total);
    receipt = db.prepare(`
      SELECT pr.*, u.full_name as issued_by_name
      FROM payment_receipts pr LEFT JOIN users u ON u.id = pr.issued_by
      WHERE pr.id = ?
    `).get(rcptId);
  }

  const buyer = db.prepare('SELECT full_name, branch_code, branch_name, bc_customer_no FROM users WHERE id=?').get(order.user_id);
  const lines = db.prepare('SELECT ol.*, i.name_en as item_name_en FROM order_lines ol LEFT JOIN items_cache i ON i.item_no=ol.item_no WHERE ol.order_id=?').all(order.id);
  const payment = db.prepare('SELECT * FROM payments WHERE order_id=? ORDER BY id DESC LIMIT 1').get(order.id);

  res.json({
    ...receipt,
    order_number: order.order_number,
    bc_so_no: order.bc_so_no,
    bc_po_no: order.bc_po_no,
    buyer,
    lines,
    payment_method: order.payment_method || 'promptpay',
    paid_at: order.paid_at,
    slip_path: payment ? payment.slip_path : null,
  });
});

// ─── Create Sales Order in D365 BC ───
async function postOrderToBC(orderId) {
  const order = db.prepare('SELECT o.*, u.bc_customer_no, u.full_name, u.branch_code FROM orders o LEFT JOIN users u ON u.id=o.user_id WHERE o.id=?').get(orderId);
  if (!order) throw new Error('Order not found');
  if (order.bc_so_no) return { already: true, bc_so_no: order.bc_so_no };

  const lines = db.prepare('SELECT * FROM order_lines WHERE order_id=?').all(orderId);
  if (!lines.length) throw new Error('Order has no lines');

  const customerNo = order.bc_customer_no || order.branch_code || '';
  if (!customerNo) throw new Error('ไม่พบเลขลูกค้า BC (bc_customer_no)');

  // 1. Create Sales Order (draft)
  const so = await bc.createSalesOrder({
    customerNumber: customerNo,
    externalDocumentNumber: order.order_number,
  });
  const soId = so.id;
  const soNo = so.number || '';

  // 2. Add order lines
  for (const line of lines) {
    const item = db.prepare('SELECT id FROM items_cache WHERE item_no=?').get(line.item_no);
    await bc.addSalesOrderLine(soId, {
      itemId: item ? item.id : undefined,
      lineType: 'Item',
      quantity: line.quantity,
      unitPrice: line.unit_price,
      description: line.item_name,
      locationId: '7e4291d6-d13e-f011-be59-000d3a086703', // CTI WH
    });
  }

  // 3. Read back SO totals from BC (VAT calculated by BC)
  const soFinal = await bc.getSalesOrder(soId);
  const vatAmount = soFinal.totalTaxAmount || 0;
  const totalInclVat = soFinal.totalAmountIncludingTax || order.subtotal;

  // 4. Save SO + sync the user-facing order number to BC's so the dashboard,
  //    receipts, and BC document all show the same identifier. The original
  //    locally-generated number is kept in BC under externalDocumentNumber for
  //    audit / cross-reference.
  //    PO creation has been intentionally taken out of this flow — the procurement
  //    side will be triggered separately later, not as part of checkout/payment.
  const newOrderNumber = soNo || order.order_number;
  db.prepare("UPDATE orders SET order_number=?, bc_so_id=?, bc_so_no=?, vat_amount=?, total=?, posted_at=datetime('now','localtime') WHERE id=?")
    .run(newOrderNumber, soId, soNo, vatAmount, totalInclVat, orderId);

  // Update payment amount to match BC total
  db.prepare('UPDATE payments SET amount=? WHERE order_id=?').run(totalInclVat, orderId);

  // Log
  db.prepare('INSERT INTO sync_log (kind, status, message, count) VALUES (?,?,?,?)')
    .run('sales_order', 'ok', `Created SO ${soNo} for ${order.order_number} (${customerNo}) VAT=${vatAmount}`, 1);

  return { ok: true, bc_so_id: soId, bc_so_no: soNo, order_number: newOrderNumber, vat_amount: vatAmount, total_incl_vat: totalInclVat };
}

// ─── BC: Create Purchase Order from a verified order ───
// Decoupled from Finance approval — Finance picks a vendor on the "Approved"
// tab and triggers this. Sales price is reused on the PO (same unit_price as
// the SO line) per the current design; if cost-tracking is added later this
// can switch to BC Item Card's directUnitCost.
async function postPOToBC(orderId, vendorNo) {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!order) throw new Error('Order not found');
  // FC fruit orders create BC SO before PO, so the SO must exist. JC master
  // orders (jc_purchase) skip the SO entirely — they're internal, not a sale —
  // so we let those through without an SO.
  if (order.order_type !== 'jc_purchase' && !order.bc_so_no) {
    throw new Error('Order ยังไม่มี BC SO — สร้าง SO ให้สำเร็จก่อน');
  }
  if (order.bc_po_no) return { already: true, bc_po_id: order.bc_po_id, bc_po_no: order.bc_po_no };
  // Fallback to env default if caller didn't pass a vendor explicitly
  vendorNo = (vendorNo || process.env.BC_DEFAULT_VENDOR_NO || '').trim();
  if (!vendorNo) throw new Error('ไม่มี vendor — ตั้งค่า BC_DEFAULT_VENDOR_NO ใน .env ก่อน');

  const lines = db.prepare('SELECT * FROM order_lines WHERE order_id=?').all(orderId);
  if (!lines.length) throw new Error('Order has no lines');

  // 1. Create Purchase Order (draft)
  // Note: BC's purchaseOrder type does NOT accept externalDocumentNumber
  // (it's a salesOrder-only property). Our local order_number → bc_po_no
  // mapping lives in the orders table, so the cross-ref doesn't need to
  // be pushed into BC.
  const po = await bc.createPurchaseOrder({
    vendorNumber: vendorNo,
  });
  const poId = po.id;
  const poNo = po.number || '';

  // 2. Add lines (mirror SO lines — same items, qty, sales price)
  for (const line of lines) {
    const item = db.prepare('SELECT id FROM items_cache WHERE item_no=?').get(line.item_no);
    await bc.addPurchaseOrderLine(poId, {
      itemId: item ? item.id : undefined,
      lineType: 'Item',
      quantity: line.quantity,
      directUnitCost: line.unit_price,
      description: line.item_name,
      locationId: '814291d6-d13e-f011-be59-000d3a086703', // INTRANSIT — goods sit here until put-away to CTI
    });
  }

  // Clear any stale [PO]-prefixed sync error from a previous failed attempt.
  const clearErr = (order.bc_sync_error || '').startsWith('[PO]') ? '' : (order.bc_sync_error || '');
  db.prepare("UPDATE orders SET bc_po_id=?, bc_po_no=?, po_vendor_no=?, bc_sync_error=? WHERE id=?")
    .run(poId, poNo, vendorNo, clearErr, orderId);

  db.prepare('INSERT INTO sync_log (kind, status, message, count) VALUES (?,?,?,?)')
    .run('purchase_order', 'ok', `Created PO ${poNo} for ${order.order_number} (vendor ${vendorNo})`, 1);

  return { ok: true, bc_po_id: poId, bc_po_no: poNo, vendor_no: vendorNo };
}

// ─── BC: Create Transfer Order for a JC master outlet ─────────────────────
// Used when a JC branch orders general goods. The Transfer Order moves stock
// from CTI (HQ warehouse) → JC0xx (the outlet) through the IN-TRANSIT
// in-transit location. No payment, no SO, no PO — just a TO.
//
// Implemented over OData (Page 5740 header + 5741 lines published as Web
// Services). Service names come from bc-client which reads them from env so
// the user can rename in BC without code changes.
async function postTransferOrderToBC(orderId, transferToCode) {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!order) throw new Error('Order not found');
  if (order.bc_to_no) return { already: true, bc_to_no: order.bc_to_no };
  if (!transferToCode) throw new Error('ต้องระบุ Transfer_to_Code (JC branch code)');

  const lines = db.prepare('SELECT * FROM order_lines WHERE order_id=?').all(orderId);
  if (!lines.length) throw new Error('Order has no lines');

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const header = await bc.createTransferOrder({
    Transfer_from_Code: 'CTI',
    Transfer_to_Code: transferToCode,
    In_Transit_Code: 'IN-TRANSIT',
    Posting_Date: today,
    Shipment_Date: today,
  });
  const toNo = header.No;

  // Lines are added with explicit Line_No (10000, 20000, ...) since the
  // Subform page uses that as part of its key. unitOfMeasureCode is looked up
  // from items_cache because BC requires it on the line.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const cached = db.prepare('SELECT uom FROM items_cache WHERE item_no=?').get(line.item_no);
    await bc.addTransferOrderLine({
      Document_No: toNo,
      Line_No: (i + 1) * 10000,
      Item_No: line.item_no,
      Quantity: line.quantity,
      Unit_of_Measure_Code: cached && cached.uom ? cached.uom : '',
    });
  }

  db.prepare("UPDATE orders SET bc_to_id=?, bc_to_no=? WHERE id=?")
    .run(header['@odata.etag'] || '', toNo, orderId);

  db.prepare('INSERT INTO sync_log (kind, status, message, count) VALUES (?,?,?,?)')
    .run('transfer_order', 'ok', `Created TO ${toNo} for ${order.order_number} (CTI → ${transferToCode})`, 1);

  return { ok: true, bc_to_no: toNo };
}

// ─── Fulfillment: Sync from BC Purchase Receipts ───
async function syncFulfillmentFromBC(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!order || !order.bc_po_no) return { skipped: true, reason: 'No BC PO number' };

  try {
    const receipts = await bc.listPurchaseReceipts(order.bc_po_no);
    const rcptList = receipts.value || [];
    if (!rcptList.length) return { status: order.fulfillment_status, receipts: 0 };

    // Update fulfillment status
    if (order.fulfillment_status === 'pending') {
      db.prepare("UPDATE orders SET fulfillment_status='shipped', shipped_at=datetime('now','localtime'), shipped_by='BC' WHERE id=?")
        .run(orderId);
    }

    // Check PO lines for fully received
    let fullyReceived = true;
    if (order.bc_po_id) {
      try {
        const poLines = await bc.getPurchaseOrderLines(order.bc_po_id);
        for (const pl of (poLines.value || [])) {
          if (pl.quantity > 0 && pl.receivedQuantity < pl.quantity) {
            fullyReceived = false;
            break;
          }
        }
      } catch (e) {
        console.error('[sync fulfillment] PO lines check:', e.message);
        fullyReceived = false;
      }
    }

    return {
      status: fullyReceived ? 'shipped' : 'partial',
      receipts: rcptList.length,
      fully_received_in_bc: fullyReceived,
      receipt_numbers: rcptList.map(r => r.number),
    };
  } catch (e) {
    console.error('[sync fulfillment]', e.message);
    return { error: e.message };
  }
}

// ─── Fulfillment: Check receivable items for an order ───
app.get('/api/orders/:id/receivable', requireAuth, async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!isHqAdmin(req.user) && order.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  // Sync fulfillment from BC first
  const syncResult = await syncFulfillmentFromBC(order.id);

  // Reload order after sync
  const updated = db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
  const lines = db.prepare('SELECT * FROM order_lines WHERE order_id=?').all(order.id);

  // Fetch BC PO lines for comparison
  let bcPoLines = [];
  if (updated.bc_po_id) {
    try {
      const poLines = await bc.getPurchaseOrderLines(updated.bc_po_id);
      bcPoLines = (poLines.value || []).filter(pl => pl.lineType === 'Item');
    } catch (e) { console.error('[receivable] BC PO lines:', e.message); }
  }

  // Calculate already received quantities
  const receivedMap = {};
  const prevReceipts = db.prepare(`
    SELECT gl.order_line_id, SUM(gl.received_qty) as total_received
    FROM goods_receipt_lines gl
    JOIN goods_receipts gr ON gr.id = gl.receipt_id
    WHERE gr.order_id = ?
    GROUP BY gl.order_line_id
  `).all(order.id);
  for (const pr of prevReceipts) {
    receivedMap[pr.order_line_id] = pr.total_received;
  }

  const receivableLines = lines.map(l => {
    // Match BC PO line by bc_po_line_id or item_no
    const bcLine = bcPoLines.find(pl => pl.id === l.bc_po_line_id) ||
                   bcPoLines.find(pl => pl.description === l.item_name);
    return {
      ...l,
      already_received: receivedMap[l.id] || 0,
      remaining: l.quantity - (receivedMap[l.id] || 0),
      bc_qty: bcLine ? bcLine.quantity : null,
      bc_received: bcLine ? bcLine.receivedQuantity : null,
      bc_outstanding: bcLine ? bcLine.outstandingQuantity : null,
    };
  });

  res.json({
    order: updated,
    lines: receivableLines,
    sync: syncResult,
    can_receive: updated.payment_status === 'verified' && updated.fulfillment_status !== 'received',
  });
});

// ─── Helper: turn raw BC errors into something an ops person can act on ───
// BC returns English diagnostic text with item codes only. Translate the common
// failure modes to Thai, look up the item name, and suggest the next step so the
// admin doesn't have to parse stack traces or hop to BC just to identify the
// problem. Falls back to the cleaned raw message for unknown errors.
function humanizeBcError(rawError) {
  const raw = String(rawError || '').replace(/\s*CorrelationId:.*$/i, '').trim();
  if (!raw) return '';

  // "insufficient quantity of Item XXXXX on inventory"
  let m = raw.match(/insufficient quantity of (?:the )?[Ii]tem[\s-]*(\S+?)[\s\.\,]+(?:on inventory)?/);
  if (m) {
    const itemNo = m[1].replace(/[\.\,]$/, '');
    const item = db.prepare('SELECT name, name_en FROM items_cache WHERE item_no=?').get(itemNo);
    const name = item ? `${item.name}${item.name_en ? ` (${item.name_en})` : ''}` : '(ไม่พบใน items_cache)';
    return `❌ สินค้า ${itemNo} — ${name} ที่คลัง CTI WH มีไม่พอ → เติม stock ใน BC (Item Reclassification หรือ Transfer Order ไป CTI WH) แล้วกด Retry`;
  }

  // "Sorry, the current permissions prevented the action. (TableData NNNN ... Read|Insert|Modify|Delete: SomeName)"
  m = raw.match(/permissions prevented the action.*?\(TableData\s+(\d+)\s+([^:]+?):\s*([^)]+)\)/i);
  if (m) {
    const [, tblId, tblName, ext] = m;
    return `🔒 OAuth app ไม่มีสิทธิ์ ${tblName.trim()} (table ${tblId}) ของ ${ext.trim()} → BC admin เพิ่ม Permission Set ในหน้า Microsoft Entra Applications`;
  }

  // Qty rounding precision
  if (/Qty\.\s*Rounding Precision/i.test(raw)) {
    return `📐 Item rounding precision ไม่ตรง → ตรวจค่า Qty. Rounding Precision บน Item Card ใน BC`;
  }

  // Customer not found / blocked
  if (/Customer.*not exist|blocked customer/i.test(raw)) {
    return `👤 ลูกค้าใน BC ถูก block หรือไม่มี → ตรวจ Customer No. ของสาขาใน BC`;
  }

  // Posting date locked
  if (/Posting Date is not within.*allowed posting period/i.test(raw)) {
    return `📅 วันที่ post ไม่อยู่ในช่วงที่อนุญาต → BC admin ปรับ Allowed Posting Period`;
  }

  // Generic — just return cleaned raw + nudge
  return `⚠️ BC error: ${raw.length > 220 ? raw.slice(0, 220) + '…' : raw}`;
}

// ─── Helper: post BC Sales Order — Ship+Invoice (preferred), with fallback ───
//
// Two-stage hybrid:
//   1. Try `Microsoft.NAV.shipAndInvoice` on the SO → produces a Posted
//      Sales Shipment + Posted Sales Invoice and keeps SO in BC archive
//      (the "BC standard" flow). Requires items to have consistent Qty.
//      Rounding Precision between sales unit and base unit — otherwise
//      BC rejects with "out of balance" / "Qty. Rounding Precision".
//
//   2. If step 1 fails specifically with a rounding/UoM-conversion error,
//      fall back to: createSalesInvoice + addLines + postInvoice +
//      deleteSalesOrder. This bypasses the SO line's UoM constraints by
//      creating a free-standing invoice line whose qty + price are taken
//      verbatim from our local order. Used because:
//
//        * Fixing Qty. Rounding Precision on 461 items in BC is a
//          multi-day admin job we can't block sales on
//        * The fallback is the previous (proven) post path, so we know
//          it works for this BC data shape
//
//      The SO is deleted as cleanup because the standalone posted invoice
//      now carries the transaction and BC won't accept a duplicate.
//
// Anything that ISN'T a rounding error (customer not found, stock too low,
// permission denied, etc.) is NOT eligible for fallback — those are real
// business issues the admin needs to resolve in BC. We save the error to
// bc_sync_error and let admin retry from the dashboard once fixed.
//
// Idempotent: skips when bc_posted=1.
async function postSalesInvoiceForOrder(orderId) {
  const order = db.prepare('SELECT o.*, u.bc_customer_no FROM orders o LEFT JOIN users u ON u.id=o.user_id WHERE o.id=?').get(orderId);
  if (!order) return { ok: false, error: 'Order not found' };
  if (order.bc_posted) return { ok: true, already: true, bc_invoice_no: order.bc_invoice_no };
  if (!order.bc_so_id) return { ok: false, error: 'ไม่มี BC SO id — checkout ยังไม่สำเร็จ' };

  // Read externalDocumentNumber from the SO BEFORE we touch it — needed
  // for invoice lookup later AND as the externalDocumentNumber on any
  // fallback invoice we create (so cross-referencing the SO ↔ invoice
  // still works in BC).
  let externalDocNo = order.order_number;
  try {
    const soBefore = await bc.getSalesOrder(order.bc_so_id);
    if (soBefore?.externalDocumentNumber) externalDocNo = soBefore.externalDocumentNumber;
  } catch (e) {
    console.warn('[BC getSalesOrder pre-post]', e.message);
  }

  // ─── Stage 1: try BC-native shipAndInvoice ───
  try {
    await bc.shipAndInvoiceSalesOrder(order.bc_so_id);

    // Look up the resulting posted invoice via externalDocumentNumber
    let bcInvoiceNo = '';
    let bcInvoiceId = '';
    try {
      const lookup = await bc.findPostedInvoiceByExternalDoc(externalDocNo);
      const inv = (lookup.value || [])[0];
      if (inv) { bcInvoiceNo = inv.number || ''; bcInvoiceId = inv.id || ''; }
    } catch (e) {
      console.warn('[BC findPostedInvoice]', e.message);
    }

    db.prepare("UPDATE orders SET bc_posted=1, bc_invoice_id=?, bc_invoice_no=?, bc_sync_error='' WHERE id=?")
      .run(bcInvoiceId, bcInvoiceNo, orderId);
    db.prepare('INSERT INTO sync_log (kind, status, message, count) VALUES (?,?,?,?)')
      .run('post_so', 'ok', `Ship+Invoice SO ${order.bc_so_no} → Invoice ${bcInvoiceNo || '(lookup-failed)'}`, 1);

    return { ok: true, method: 'ship_and_invoice', bc_invoice_no: bcInvoiceNo, bc_invoice_id: bcInvoiceId, bc_so_no: order.bc_so_no };
  } catch (shipErr) {
    const shipMsg = String(shipErr.message || '');
    console.warn('[BC shipAndInvoice]', shipMsg);

    // Only fall back on rounding / UoM-conversion errors. Other BC errors
    // (customer not found, stock low, etc.) are real issues admin must fix.
    const isRoundingError = /Rounding Precision|out of balance|Qty.* Base/i.test(shipMsg);

    if (!isRoundingError) {
      const m = shipMsg.match(/"message":"([^"]+)"/);
      const friendly = humanizeBcError(m ? m[1] : shipMsg);
      db.prepare("UPDATE orders SET bc_sync_error=? WHERE id=?").run(friendly, orderId);
      db.prepare('INSERT INTO sync_log (kind, status, message, count) VALUES (?,?,?,?)')
        .run('post_so', 'error', `SO ${order.bc_so_no}: ${shipMsg}`, 1);
      return { ok: false, error: friendly };
    }

    // ─── Stage 2: fallback to createSalesInvoice path ───
    const customerNo = order.bc_customer_no || '';
    if (!customerNo) {
      const err = 'ไม่พบเลขลูกค้า BC (bc_customer_no) — fallback ใช้ไม่ได้';
      db.prepare("UPDATE orders SET bc_sync_error=? WHERE id=?").run(err, orderId);
      return { ok: false, error: err };
    }
    const lines = db.prepare('SELECT * FROM order_lines WHERE order_id=?').all(orderId);
    if (!lines.length) return { ok: false, error: 'ไม่มี order line' };

    let draftInvoiceId = null;
    try {
      const inv = await bc.createSalesInvoice({
        customerNumber: customerNo,
        externalDocumentNumber: externalDocNo,
      });
      draftInvoiceId = inv.id;
      for (const line of lines) {
        const item = db.prepare('SELECT id FROM items_cache WHERE item_no=?').get(line.item_no);
        await bc.addInvoiceLine(draftInvoiceId, {
          itemId: item ? item.id : undefined,
          lineType: 'Item',
          quantity: line.quantity,
          unitPrice: line.unit_price,
          description: line.item_name,
          locationId: '7e4291d6-d13e-f011-be59-000d3a086703', // CTI WH
        });
      }
      const posted = await bc.postInvoice(draftInvoiceId);
      const postedNo = posted?.number || inv.number || '';
      const postedId = posted?.id || draftInvoiceId;
      draftInvoiceId = null;

      // Delete orphan SO — the posted invoice now carries the transaction.
      let soCleanup = null;
      try {
        await bc.deleteSalesOrder(order.bc_so_id);
        soCleanup = { deleted: true };
      } catch (e) {
        console.error('[BC delete SO]', e.message);
        db.prepare('INSERT INTO sync_log (kind, status, message, count) VALUES (?,?,?,?)')
          .run('delete_so', 'error', `SO ${order.bc_so_no}: ${e.message}`, 1);
        soCleanup = { deleted: false, error: e.message };
      }

      db.prepare("UPDATE orders SET bc_posted=1, bc_invoice_id=?, bc_invoice_no=?, bc_sync_error='' WHERE id=?")
        .run(postedId, postedNo, orderId);
      db.prepare('INSERT INTO sync_log (kind, status, message, count) VALUES (?,?,?,?)')
        .run('post_so', 'fallback', `Fallback (rounding) — SO ${order.bc_so_no} → Invoice ${postedNo}`, 1);

      return {
        ok: true,
        method: 'fallback_invoice',
        fallback_reason: 'qty_rounding_precision',
        bc_invoice_no: postedNo,
        bc_invoice_id: postedId,
        so_cleanup: soCleanup,
      };
    } catch (fbErr) {
      console.error('[BC fallback]', fbErr.message);
      if (draftInvoiceId) {
        bc.deleteSalesInvoice(draftInvoiceId).catch(e => console.error('[BC cleanup]', e.message));
      }
      const m = String(fbErr.message || '').match(/"message":"([^"]+)"/);
      const friendly = humanizeBcError(m ? m[1] : fbErr.message);
      db.prepare("UPDATE orders SET bc_sync_error=? WHERE id=?").run(friendly, orderId);
      db.prepare('INSERT INTO sync_log (kind, status, message, count) VALUES (?,?,?,?)')
        .run('post_so', 'error', `Fallback failed — SO ${order.bc_so_no}: ${fbErr.message}`, 1);
      return { ok: false, error: friendly };
    }
  }
}

// ─── Finance/Admin: create BC Purchase Order for a verified order ───
// Finance picks a vendor on the Approvals "Approved" tab and triggers this.
// requireAdmin allows super_admin, admin_scm, finance (all in HQ_ROLES).
app.post('/api/orders/:id/create-po', requireAuth, requireAdmin, async (req, res) => {
  // vendor_no is optional — if omitted, postPOToBC falls back to BC_DEFAULT_VENDOR_NO.
  // The UI just calls this with no body for the retry-after-failure case.
  const vendorNo = String(req.body.vendor_no || '').trim();
  try {
    const result = await postPOToBC(req.params.id, vendorNo);
    res.json({ ok: true, ...result, message: result.already ? `PO มีอยู่แล้ว: ${result.bc_po_no}` : `สร้าง PO สำเร็จ: ${result.bc_po_no}` });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ─── Admin: retry BC Invoice posting for an order whose previous attempt failed ───
app.post('/api/orders/:id/retry-bc-post', requireAuth, requireAdmin, async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.bc_posted) return res.json({ ok: true, already: true, bc_invoice_no: order.bc_invoice_no, message: 'Order นี้ post BC สำเร็จแล้ว' });
  if (order.fulfillment_status !== 'received') return res.status(400).json({ error: `ต้องรับของครบก่อน (status: ${order.fulfillment_status})` });
  const result = await postSalesInvoiceForOrder(order.id);
  if (result.ok) {
    res.json({ ok: true, message: `Post Invoice สำเร็จ — ${result.bc_invoice_no}`, ...result });
  } else {
    res.status(400).json({ ok: false, error: result.error, message: 'ลอง post BC ไม่สำเร็จ: ' + result.error });
  }
});

// ─── Fulfillment: FC Confirm Receipt (Goods Receipt) ───
app.post('/api/orders/:id/receive', requireAuth, async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!isHqAdmin(req.user) && order.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  // Allow receive from pending too — without a BC PO in this flow there is no
  // Posted Purchase Receipt to wait for, so the FC marks goods received directly.
  // Block only after the order is fully received or cancelled.
  if (order.fulfillment_status === 'received') {
    return res.status(400).json({ error: 'รับของครบแล้ว' });
  }
  if (order.payment_status !== 'verified') {
    return res.status(400).json({ error: `ต้องชำระเงินก่อน (สถานะ: ${order.payment_status})` });
  }

  const { lines: receiveLines = [], note = '' } = req.body || {};
  if (!receiveLines.length) return res.status(400).json({ error: 'ไม่มีรายการรับของ' });

  const orderLines = db.prepare('SELECT * FROM order_lines WHERE order_id=?').all(order.id);
  const orderLineMap = {};
  for (const ol of orderLines) orderLineMap[ol.id] = ol;

  // Validate. We treat missing/non-numeric received_qty as an explicit
  // 400 instead of silently dropping the line — earlier callers that sent
  // `qty` instead of `received_qty` were having their receives recorded
  // as zero with no error, which made the order look fulfilled when it
  // wasn't.
  for (const rl of receiveLines) {
    const ol = orderLineMap[rl.order_line_id];
    if (!ol) return res.status(400).json({ error: `ไม่พบรายการ ${rl.order_line_id}` });
    if (rl.received_qty === undefined || rl.received_qty === null || typeof rl.received_qty !== 'number') {
      return res.status(400).json({ error: `received_qty ของรายการ ${rl.order_line_id} ต้องเป็นตัวเลข` });
    }
    if (rl.received_qty < 0) return res.status(400).json({ error: 'จำนวนรับไม่ถูกต้อง' });
  }

  // Generate GR number
  const d = new Date();
  const grPrefix = `GR${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  const lastGR = db.prepare("SELECT receipt_number FROM goods_receipts WHERE receipt_number LIKE ? ORDER BY receipt_number DESC LIMIT 1").get(grPrefix + '%');
  const grSeq = lastGR ? parseInt(lastGR.receipt_number.slice(-4)) + 1 : 1;
  const grNumber = grPrefix + String(grSeq).padStart(4, '0');
  const grId = crypto.randomUUID();

  const tx = db.transaction(() => {
    db.prepare('INSERT INTO goods_receipts (id, order_id, receipt_number, received_by, note) VALUES (?,?,?,?,?)')
      .run(grId, order.id, grNumber, req.user.id, note);

    const insLine = db.prepare('INSERT INTO goods_receipt_lines (receipt_id, order_line_id, item_no, item_name, ordered_qty, received_qty, note) VALUES (?,?,?,?,?,?,?)');
    for (const rl of receiveLines) {
      const ol = orderLineMap[rl.order_line_id];
      if (rl.received_qty > 0) {
        insLine.run(grId, rl.order_line_id, ol.item_no, ol.item_name, ol.quantity, rl.received_qty, rl.note || '');
      }
    }

    // Check if all items fully received
    const totalOrdered = db.prepare('SELECT SUM(quantity) as total FROM order_lines WHERE order_id=?').get(order.id).total;
    const totalReceived = db.prepare(`
      SELECT COALESCE(SUM(gl.received_qty), 0) as total
      FROM goods_receipt_lines gl
      JOIN goods_receipts gr ON gr.id = gl.receipt_id
      WHERE gr.order_id = ?
    `).get(order.id).total;

    if (totalReceived >= totalOrdered) {
      db.prepare("UPDATE orders SET fulfillment_status='received', fully_received_at=datetime('now','localtime') WHERE id=?").run(order.id);
    } else {
      db.prepare("UPDATE orders SET fulfillment_status='partial' WHERE id=?").run(order.id);
    }
  });
  tx();

  const finalOrder = db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);

  // When the order is now fully received, kick off the BC Invoice posting.
  // Failure leaves the local GR intact (FC's truth) and saves the error to
  // orders.bc_sync_error so admin can see + retry from the dashboard.
  let bcPost = null;
  if (finalOrder.fulfillment_status === 'received' && !finalOrder.bc_posted) {
    bcPost = await postSalesInvoiceForOrder(order.id);
  }

  res.json({
    ok: true,
    receipt_id: grId,
    receipt_number: grNumber,
    fulfillment_status: finalOrder.fulfillment_status,
    bc_post: bcPost,
    message: `บันทึกรับของ ${grNumber} สำเร็จ${bcPost?.ok ? ` · BC Invoice ${bcPost.bc_invoice_no}` : ''}`,
  });
});

// ─── Fulfillment: Receipt history ───
app.get('/api/orders/:id/receipts', requireAuth, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!isHqAdmin(req.user) && order.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  const receipts = db.prepare('SELECT gr.*, u.full_name as received_by_name FROM goods_receipts gr LEFT JOIN users u ON u.id=gr.received_by WHERE gr.order_id=? ORDER BY gr.created_at DESC').all(order.id);
  for (const r of receipts) {
    r.lines = db.prepare('SELECT * FROM goods_receipt_lines WHERE receipt_id=?').all(r.id);
  }
  res.json(receipts);
});

// ─── GR List (per user) ───
app.get('/api/receipts', requireAuth, (req, res) => {
  let sql, params;
  if (isHqAdmin(req.user)) {
    sql = `SELECT gr.*, u.full_name as received_by_name, o.order_number, o.bc_po_no
           FROM goods_receipts gr
           LEFT JOIN users u ON u.id = gr.received_by
           LEFT JOIN orders o ON o.id = gr.order_id
           ORDER BY gr.created_at DESC`;
    params = [];
  } else {
    sql = `SELECT gr.*, u.full_name as received_by_name, o.order_number, o.bc_po_no
           FROM goods_receipts gr
           LEFT JOIN users u ON u.id = gr.received_by
           LEFT JOIN orders o ON o.id = gr.order_id
           WHERE o.user_id = ?
           ORDER BY gr.created_at DESC`;
    params = [req.user.id];
  }
  const receipts = db.prepare(sql).all(...params);
  for (const r of receipts) {
    r.lines = db.prepare(`SELECT gl.*, i.uom, i.name_en as item_name_en FROM goods_receipt_lines gl LEFT JOIN items_cache i ON i.item_no=gl.item_no WHERE gl.receipt_id=?`).all(r.id);
  }
  res.json(receipts);
});

// ─── GR Detail ───
app.get('/api/receipts/:id', requireAuth, (req, res) => {
  const gr = db.prepare(`
    SELECT gr.*, u.full_name as received_by_name, o.order_number, o.bc_po_no
    FROM goods_receipts gr
    LEFT JOIN users u ON u.id = gr.received_by
    LEFT JOIN orders o ON o.id = gr.order_id
    WHERE gr.id = ?
  `).get(req.params.id);
  if (!gr) return res.status(404).json({ error: 'Receipt not found' });
  const order = db.prepare('SELECT user_id FROM orders WHERE id=?').get(gr.order_id);
  if (!isHqAdmin(req.user) && order.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  gr.lines = db.prepare('SELECT gl.*, i.uom, i.name_en as item_name_en FROM goods_receipt_lines gl LEFT JOIN items_cache i ON i.item_no=gl.item_no WHERE gl.receipt_id=?').all(gr.id);
  res.json(gr);
});

// ─── Fulfillment: Per-order sync (any authenticated user) ───
app.post('/api/orders/:id/sync-fulfillment', requireAuth, async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!isHqAdmin(req.user) && order.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  if (!order.bc_po_no) return res.json({ status: order.fulfillment_status, receipts: 0, message: 'ไม่มีเลข BC PO' });

  const result = await syncFulfillmentFromBC(order.id);
  const updated = db.prepare('SELECT fulfillment_status FROM orders WHERE id=?').get(order.id);
  res.json({ ...result, status: updated.fulfillment_status });
});

// ─── Fulfillment: Admin sync all pending fulfillments ───
app.post('/api/sync/fulfillment', requireAuth, requireAdmin, async (req, res) => {
  const pendingOrders = db.prepare("SELECT id, bc_po_no FROM orders WHERE bc_po_no != '' AND fulfillment_status IN ('pending','shipped','partial') AND payment_status = 'verified'").all();
  const results = [];
  for (const o of pendingOrders) {
    const r = await syncFulfillmentFromBC(o.id);
    results.push({ order_id: o.id, bc_po_no: o.bc_po_no, ...r });
  }
  res.json({ synced: results.length, results });
});

// ─── Stock Balance (per branch/user) ───
app.get('/api/stock-balance', requireAuth, (req, res) => {
  const userId = isHqAdmin(req.user) && req.query.user_id ? req.query.user_id : req.user.id;
  const user = db.prepare('SELECT full_name, branch_code, branch_name FROM users WHERE id=?').get(userId);
  const branchCode = user ? user.branch_code : '';

  // on_hand = SUM(received from HQ via goods_receipts) − SUM(issued out via stock_issues)
  // Two separate aggregates merged in JS rather than a FULL OUTER JOIN (which
  // SQLite < 3.39 doesn't support reliably under better-sqlite3 in some envs).
  const receivedRows = db.prepare(`
    SELECT gl.item_no, SUM(gl.received_qty) as qty
    FROM goods_receipt_lines gl
    JOIN goods_receipts gr ON gr.id = gl.receipt_id
    JOIN orders o ON o.id = gr.order_id
    WHERE o.user_id = ?
    GROUP BY gl.item_no
  `).all(userId);

  const issuedRows = branchCode ? db.prepare(`
    SELECT sil.item_no, SUM(sil.qty) as qty
    FROM stock_issue_lines sil
    JOIN stock_issues si ON si.id = sil.issue_id
    WHERE si.branch_code = ?
    GROUP BY sil.item_no
  `).all(branchCode) : [];

  const byItem = {};
  for (const r of receivedRows) {
    byItem[r.item_no] = { item_no: r.item_no, total_received: r.qty, total_issued: 0 };
  }
  for (const i of issuedRows) {
    if (!byItem[i.item_no]) byItem[i.item_no] = { item_no: i.item_no, total_received: 0, total_issued: 0 };
    byItem[i.item_no].total_issued = i.qty;
  }
  // Pull all reorder-point settings for this branch in one query, keyed by
  // item_no so we can attach them in the enrichment loop below.
  const reorderMap = {};
  if (branchCode) {
    for (const r of db.prepare('SELECT item_no, reorder_point, reorder_qty FROM branch_item_settings WHERE branch_code=?').all(branchCode)) {
      reorderMap[r.item_no] = r;
    }
  }
  const getItem = db.prepare('SELECT name, name_en, uom, category FROM items_cache WHERE item_no=?');
  for (const k of Object.keys(byItem)) {
    const meta = getItem.get(k) || {};
    byItem[k].item_name = meta.name || '';
    byItem[k].item_name_en = meta.name_en || '';
    byItem[k].uom = meta.uom || '';
    byItem[k].category = meta.category || '';
    byItem[k].on_hand = (byItem[k].total_received || 0) - (byItem[k].total_issued || 0);
    const rp = reorderMap[k];
    byItem[k].reorder_point = rp ? rp.reorder_point : 0;
    byItem[k].reorder_qty = rp ? rp.reorder_qty : 0;
    // low_stock fires only when a threshold has been set (>0) and on-hand
    // has dipped at or below it. We never flag the default 0-threshold as
    // "low" because that would yell about every item the branch has never
    // configured.
    byItem[k].low_stock = byItem[k].reorder_point > 0 && byItem[k].on_hand <= byItem[k].reorder_point;
  }
  const items = Object.values(byItem).sort((a, b) => (a.item_name || '').localeCompare(b.item_name || ''));

  res.json({
    branch: user ? { name: user.full_name, code: user.branch_code, branch_name: user.branch_name } : {},
    items,
  });
});

// ─── Stock Issues: list / detail / create ───────────────────────────────────
// FC users issue stock OUT (sale, damage, transfer, adjustment). Each issue
// is a multi-line document with branch_code + issued_by + reason. The qty
// is validated against the running on_hand BEFORE insert, so a branch
// can't issue more than they currently have received minus issued.

function genIssueNumber() {
  const d = new Date();
  const prefix = `IS${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const last = db.prepare("SELECT issue_number FROM stock_issues WHERE issue_number LIKE ? ORDER BY issue_number DESC LIMIT 1").get(prefix + '%');
  const seq = last ? parseInt(last.issue_number.slice(-4)) + 1 : 1;
  return prefix + String(seq).padStart(4, '0');
}

// On-hand for one (branch, item) pair — used by the issue-create endpoint.
function onHandForItem(branchUserId, branchCode, itemNo) {
  const recv = db.prepare(`
    SELECT COALESCE(SUM(gl.received_qty), 0) as qty
    FROM goods_receipt_lines gl
    JOIN goods_receipts gr ON gr.id = gl.receipt_id
    JOIN orders o ON o.id = gr.order_id
    WHERE o.user_id = ? AND gl.item_no = ?
  `).get(branchUserId, itemNo).qty || 0;
  const iss = db.prepare(`
    SELECT COALESCE(SUM(sil.qty), 0) as qty
    FROM stock_issue_lines sil
    JOIN stock_issues si ON si.id = sil.issue_id
    WHERE si.branch_code = ? AND sil.item_no = ?
  `).get(branchCode, itemNo).qty || 0;
  return recv - iss;
}

app.post('/api/stock/issue', requireAuth, (req, res) => {
  const { lines = [], reason = 'sale', note = '', password = '' } = req.body || {};

  // Password re-confirm — same password the user logs in with. Prevents
  // someone at a left-open computer from issuing stock under the
  // signed-in user's name. The stamp on the issue (issued_by) is now
  // backed by a fresh credential verification, which is what makes it
  // legally / audit-defensibly "their" issue.
  if (!password) {
    return res.status(400).json({ error: 'ต้องใส่รหัสผ่านยืนยันตัวตน' });
  }
  const userRow = db.prepare('SELECT password FROM users WHERE id=?').get(req.user.id);
  if (!userRow || !bcrypt.compareSync(password, userRow.password)) {
    return res.status(401).json({ error: 'รหัสผ่านไม่ถูกต้อง — ไม่บันทึกการเบิก' });
  }

  if (!Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: 'ต้องระบุรายการสินค้าที่เบิก' });
  }
  if (!req.user.branch_code) {
    return res.status(400).json({ error: 'ผู้ใช้ไม่มีสาขา — เบิกของได้เฉพาะ user สาขา (fc)' });
  }
  const allowedReasons = ['sale', 'damage', 'transfer', 'adjustment', 'other'];
  if (!allowedReasons.includes(reason)) {
    return res.status(400).json({ error: `reason ต้องเป็นหนึ่งใน: ${allowedReasons.join(', ')}` });
  }

  // Validate each line shape
  for (const l of lines) {
    if (!l.item_no || typeof l.qty !== 'number' || l.qty <= 0) {
      return res.status(400).json({ error: `รายการไม่ถูกต้อง — ต้องมี item_no + qty > 0: ${JSON.stringify(l)}` });
    }
  }

  // Validate stock available BEFORE inserting anything
  for (const l of lines) {
    const onHand = onHandForItem(req.user.id, req.user.branch_code, l.item_no);
    if (l.qty > onHand) {
      return res.status(400).json({ error: `สต๊อก ${l.item_no} ไม่พอ (คงเหลือ ${onHand}, เบิก ${l.qty})` });
    }
  }

  const issueId = crypto.randomUUID();
  const issueNumber = genIssueNumber();
  const insIssue = db.prepare('INSERT INTO stock_issues (id, issue_number, branch_code, issued_by, reason, note) VALUES (?,?,?,?,?,?)');
  const insLine = db.prepare('INSERT INTO stock_issue_lines (issue_id, item_no, item_name, qty, note) VALUES (?,?,?,?,?)');
  const getItem = db.prepare('SELECT name FROM items_cache WHERE item_no=?');

  const tx = db.transaction(() => {
    insIssue.run(issueId, issueNumber, req.user.branch_code, req.user.id, reason, note);
    for (const l of lines) {
      const itName = (getItem.get(l.item_no) || {}).name || '';
      insLine.run(issueId, l.item_no, itName, l.qty, l.note || '');
    }
  });
  tx();

  res.json({
    ok: true,
    issue_id: issueId,
    issue_number: issueNumber,
    message: `บันทึกการเบิก ${issueNumber} สำเร็จ`,
  });
});

app.get('/api/stock/issues', requireAuth, (req, res) => {
  // HQ admin sees all; fc only sees own branch
  const rows = isHqAdmin(req.user)
    ? db.prepare(`
        SELECT si.*, u.full_name as issued_by_name, u.branch_name,
               (SELECT COUNT(*) FROM stock_issue_lines WHERE issue_id=si.id) as line_count,
               (SELECT COALESCE(SUM(qty),0) FROM stock_issue_lines WHERE issue_id=si.id) as total_qty
        FROM stock_issues si LEFT JOIN users u ON u.id=si.issued_by
        ORDER BY si.created_at DESC LIMIT 200
      `).all()
    : db.prepare(`
        SELECT si.*, u.full_name as issued_by_name, u.branch_name,
               (SELECT COUNT(*) FROM stock_issue_lines WHERE issue_id=si.id) as line_count,
               (SELECT COALESCE(SUM(qty),0) FROM stock_issue_lines WHERE issue_id=si.id) as total_qty
        FROM stock_issues si LEFT JOIN users u ON u.id=si.issued_by
        WHERE si.branch_code = ?
        ORDER BY si.created_at DESC LIMIT 200
      `).all(req.user.branch_code || '');
  res.json(rows);
});

app.get('/api/stock/issues/:id', requireAuth, (req, res) => {
  const issue = db.prepare(`
    SELECT si.*, u.full_name as issued_by_name, u.branch_name
    FROM stock_issues si LEFT JOIN users u ON u.id=si.issued_by
    WHERE si.id=?
  `).get(String(req.params.id));
  if (!issue) return res.status(404).json({ error: 'Issue not found' });
  if (!isHqAdmin(req.user) && issue.branch_code !== req.user.branch_code) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const lines = db.prepare(`
    SELECT sil.*, ic.uom, ic.name_en as item_name_en
    FROM stock_issue_lines sil
    LEFT JOIN items_cache ic ON ic.item_no = sil.item_no
    WHERE sil.issue_id=?
  `).all(issue.id);
  res.json({ ...issue, lines });
});

// ─── Unified Stock Movement Ledger ─────────────────────────────────────────
// Returns receipts (IN) and issues (OUT) merged + sorted desc by timestamp.
// Filters: from / to (ISO date strings), item_no, type ('IN' or 'OUT'),
// reason (for OUT only). Branch-scoped: fc sees own branch; HQ admin can
// pass ?branch_code= or ?user_id= to target any.
//
// Each row carries: ts, type, doc_no, ref_no, bc_no, item_no, item_name,
// uom, qty, actor_name, reason, note — uniform shape across IN/OUT so
// the frontend can render a single table.
app.get('/api/stock/movements', requireAuth, (req, res) => {
  const targetUserId = (isHqAdmin(req.user) && req.query.user_id) ? String(req.query.user_id) : req.user.id;
  const targetBranch = (isHqAdmin(req.user) && req.query.branch_code) ? String(req.query.branch_code) : (req.user.branch_code || '');
  const { from, to, item_no, type, reason } = req.query;

  const wantsIN = !type || type === 'IN';
  const wantsOUT = !type || type === 'OUT';

  let inRows = [];
  if (wantsIN) {
    let sql = `
      SELECT
        gr.created_at as ts,
        'IN' as type,
        gr.receipt_number as doc_no,
        o.order_number as ref_no,
        COALESCE(o.bc_invoice_no, '') as bc_no,
        gl.item_no,
        gl.item_name,
        ic.uom as uom,
        gl.received_qty as qty,
        COALESCE(u.full_name, '') as actor_name,
        '' as reason,
        COALESCE(gr.note, '') as note
      FROM goods_receipt_lines gl
      JOIN goods_receipts gr ON gr.id = gl.receipt_id
      JOIN orders o ON o.id = gr.order_id
      LEFT JOIN users u ON u.id = gr.received_by
      LEFT JOIN items_cache ic ON ic.item_no = gl.item_no
      WHERE o.user_id = ?
    `;
    const params = [targetUserId];
    if (from) { sql += ' AND gr.created_at >= ?'; params.push(from); }
    if (to) { sql += ' AND gr.created_at <= ?'; params.push(to + ' 23:59:59'); }
    if (item_no) { sql += ' AND gl.item_no = ?'; params.push(item_no); }
    inRows = db.prepare(sql).all(...params);
  }

  let outRows = [];
  if (wantsOUT && targetBranch) {
    let sql = `
      SELECT
        si.created_at as ts,
        'OUT' as type,
        si.issue_number as doc_no,
        '' as ref_no,
        '' as bc_no,
        sil.item_no,
        sil.item_name,
        ic.uom as uom,
        sil.qty as qty,
        COALESCE(u.full_name, '') as actor_name,
        si.reason,
        COALESCE(si.note, '') as note
      FROM stock_issue_lines sil
      JOIN stock_issues si ON si.id = sil.issue_id
      LEFT JOIN users u ON u.id = si.issued_by
      LEFT JOIN items_cache ic ON ic.item_no = sil.item_no
      WHERE si.branch_code = ?
    `;
    const params = [targetBranch];
    if (from) { sql += ' AND si.created_at >= ?'; params.push(from); }
    if (to) { sql += ' AND si.created_at <= ?'; params.push(to + ' 23:59:59'); }
    if (item_no) { sql += ' AND sil.item_no = ?'; params.push(item_no); }
    if (reason) { sql += ' AND si.reason = ?'; params.push(reason); }
    outRows = db.prepare(sql).all(...params);
  }

  const movements = [...inRows, ...outRows]
    .sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))
    .slice(0, 1000);

  // Summary block — totals + counts, plus net movement and a top-5 leaderboard
  // for "most active items" so the UI can show a quick "what moved a lot"
  // card without re-walking the rows in JS.
  const totalIn = movements.filter(r => r.type === 'IN').reduce((s, r) => s + (r.qty || 0), 0);
  const totalOut = movements.filter(r => r.type === 'OUT').reduce((s, r) => s + (r.qty || 0), 0);
  const byItem = {};
  for (const r of movements) {
    const k = r.item_no;
    if (!byItem[k]) byItem[k] = { item_no: k, item_name: r.item_name, in_qty: 0, out_qty: 0, count: 0 };
    if (r.type === 'IN') byItem[k].in_qty += r.qty;
    else byItem[k].out_qty += r.qty;
    byItem[k].count++;
  }
  const topMovers = Object.values(byItem)
    .sort((a, b) => (b.in_qty + b.out_qty) - (a.in_qty + a.out_qty))
    .slice(0, 5);

  res.json({
    summary: {
      total_in: totalIn,
      total_out: totalOut,
      net: totalIn - totalOut,
      count_in: movements.filter(r => r.type === 'IN').length,
      count_out: movements.filter(r => r.type === 'OUT').length,
      count_total: movements.length,
      unique_items: Object.keys(byItem).length,
    },
    top_movers: topMovers,
    movements,
  });
});

// ─── Software license info (singleton) ─────────────────────────────────────
// Any logged-in user can READ (so the expiry banner can render in the nav),
// only super_admin can WRITE.
app.get('/api/admin/license', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM license_info WHERE id=1').get();
  if (!row) return res.json({ product_name: 'JC-Market' });

  // Compute days_remaining server-side from `expires_at` so the client
  // doesn't have to parse a local-time string with potential TZ skew. The
  // result is a signed integer — negative when already expired.
  let daysRemaining = null;
  let status = 'unknown';
  if (row.expires_at) {
    const exp = new Date(row.expires_at + (row.expires_at.length === 10 ? 'T23:59:59' : ''));
    const now = new Date();
    daysRemaining = Math.ceil((exp - now) / 86400000);
    if (daysRemaining < 0) status = 'expired';
    else if (daysRemaining <= 30) status = 'expiring_soon';
    else status = 'active';
  }
  res.json({ ...row, days_remaining: daysRemaining, status });
});

app.post('/api/admin/license', requireAuth, requireSuperAdmin, (req, res) => {
  const { product_name, license_key, licensed_to, issued_at, expires_at, features, notes } = req.body || {};
  db.prepare(`
    UPDATE license_info SET
      product_name = COALESCE(?, product_name),
      license_key  = COALESCE(?, license_key),
      licensed_to  = COALESCE(?, licensed_to),
      issued_at    = COALESCE(?, issued_at),
      expires_at   = COALESCE(?, expires_at),
      features     = COALESCE(?, features),
      notes        = COALESCE(?, notes),
      updated_by   = ?,
      updated_at   = datetime('now','localtime')
    WHERE id = 1
  `).run(
    product_name ?? null,
    license_key ?? null,
    licensed_to ?? null,
    issued_at ?? null,
    expires_at ?? null,
    features ?? null,
    notes ?? null,
    req.user.id,
  );
  res.json({ ok: true });
});

// ─── Reorder-point settings per (branch, item) ─────────────────────────────
// FC users set their own thresholds. HQ admins can target any branch via
// ?branch_code= (GET) or body.branch_code (POST).

app.get('/api/reorder-points', requireAuth, (req, res) => {
  const branchCode = (isHqAdmin(req.user) && req.query.branch_code)
    ? String(req.query.branch_code) : req.user.branch_code;
  if (!branchCode) return res.json([]);
  const rows = db.prepare(`
    SELECT bis.*, ic.name as item_name, ic.name_en as item_name_en, ic.uom, ic.category
    FROM branch_item_settings bis
    LEFT JOIN items_cache ic ON ic.item_no = bis.item_no
    WHERE bis.branch_code = ?
    ORDER BY ic.name
  `).all(branchCode);
  res.json(rows);
});

app.post('/api/reorder-points', requireAuth, (req, res) => {
  const { item_no, reorder_point, reorder_qty = 0, note = '' } = req.body || {};
  if (!item_no) return res.status(400).json({ error: 'item_no required' });
  if (typeof reorder_point !== 'number' || reorder_point < 0) {
    return res.status(400).json({ error: 'reorder_point must be a number >= 0' });
  }
  if (typeof reorder_qty !== 'number' || reorder_qty < 0) {
    return res.status(400).json({ error: 'reorder_qty must be a number >= 0' });
  }
  // HQ admin can target any branch; everyone else writes to own branch
  const branchCode = (isHqAdmin(req.user) && req.body.branch_code)
    ? String(req.body.branch_code) : req.user.branch_code;
  if (!branchCode) return res.status(400).json({ error: 'ผู้ใช้ไม่มีสาขา — เฉพาะ admin เท่านั้นที่ระบุ branch_code ได้' });

  // Confirm item exists in catalog before saving the setting — otherwise
  // we'd silently allow garbage item_no entries that never resolve.
  const itemExists = db.prepare('SELECT 1 FROM items_cache WHERE item_no=?').get(item_no);
  if (!itemExists) return res.status(404).json({ error: `ไม่พบสินค้า ${item_no}` });

  db.prepare(`
    INSERT INTO branch_item_settings (branch_code, item_no, reorder_point, reorder_qty, note, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now','localtime'))
    ON CONFLICT(branch_code, item_no) DO UPDATE SET
      reorder_point = excluded.reorder_point,
      reorder_qty   = excluded.reorder_qty,
      note          = excluded.note,
      updated_by    = excluded.updated_by,
      updated_at    = excluded.updated_at
  `).run(branchCode, item_no, reorder_point, reorder_qty, note, req.user.id);

  res.json({ ok: true, branch_code: branchCode, item_no, reorder_point, reorder_qty });
});

// ─── Sync ───
app.post('/api/sync/items', requireAuth, requireAdmin, async (req, res) => {
  const result = await syncItems();
  res.json(result);
});

app.get('/api/sync/status', requireAuth, (req, res) => {
  res.json(getLastSync());
});

// ─── BC Vendors (admin) ───
app.get('/api/bc/vendors', requireAuth, requireAdmin, async (req, res) => {
  try {
    const data = await bc.listVendors();
    res.json(data.value || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Admin Dashboard ───
app.get('/api/admin/dashboard', requireAuth, requireAdmin, (req, res) => {
  // Summary counts
  const totalOrders = db.prepare('SELECT COUNT(*) as c FROM orders').get().c;
  const totalRevenue = db.prepare("SELECT COALESCE(SUM(total),0) as s FROM orders WHERE payment_status='verified'").get().s;
  const pendingPayments = db.prepare("SELECT COUNT(*) as c FROM orders WHERE payment_status='paid'").get().c;
  const pendingOrders = db.prepare("SELECT COUNT(*) as c FROM orders WHERE payment_status='pending'").get().c;
  const verifiedOrders = db.prepare("SELECT COUNT(*) as c FROM orders WHERE payment_status='verified'").get().c;
  const failedOrders = db.prepare("SELECT COUNT(*) as c FROM orders WHERE payment_status='failed'").get().c;
  const totalItems = db.prepare('SELECT COUNT(*) as c FROM items_cache WHERE active=1').get().c;
  const outOfStock = db.prepare('SELECT COUNT(*) as c FROM items_cache WHERE active=1 AND inventory<=0').get().c;
  const totalGR = db.prepare('SELECT COUNT(*) as c FROM goods_receipts').get().c;
  const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users WHERE active=1').get().c;

  // Orders by branch
  const ordersByBranch = db.prepare(`
    SELECT u.branch_name, COUNT(o.id) as order_count, COALESCE(SUM(o.total),0) as total_amount
    FROM orders o LEFT JOIN users u ON u.id=o.user_id
    GROUP BY u.branch_name ORDER BY total_amount DESC
  `).all();

  // Recent orders (last 10)
  const recentOrders = db.prepare(`
    SELECT o.id, o.order_number, o.total, o.payment_status, o.fulfillment_status, o.created_at,
           u.full_name as user_name, u.branch_name
    FROM orders o LEFT JOIN users u ON u.id=o.user_id
    ORDER BY o.created_at DESC LIMIT 10
  `).all();

  // Pending verification (slips uploaded, awaiting admin approval)
  const pendingSlips = db.prepare(`
    SELECT o.id, o.order_number, o.total, o.created_at, o.paid_at,
           u.full_name as user_name, u.branch_name,
           p.slip_path
    FROM orders o
    LEFT JOIN users u ON u.id=o.user_id
    LEFT JOIN payments p ON p.order_id=o.id
    WHERE o.payment_status='paid'
    ORDER BY o.paid_at DESC
  `).all();

  // Top items ordered
  const topItems = db.prepare(`
    SELECT ol.item_no, ol.item_name, i.name_en as item_name_en, SUM(ol.quantity) as total_qty, SUM(ol.line_total) as total_amount,
           COUNT(DISTINCT ol.order_id) as order_count
    FROM order_lines ol
    JOIN orders o ON o.id=ol.order_id
    LEFT JOIN items_cache i ON i.item_no=ol.item_no
    GROUP BY ol.item_no
    ORDER BY total_qty DESC LIMIT 10
  `).all();

  // Fulfillment summary
  const fulfillPending = db.prepare("SELECT COUNT(*) as c FROM orders WHERE fulfillment_status='pending' AND payment_status='verified'").get().c;
  const fulfillShipped = db.prepare("SELECT COUNT(*) as c FROM orders WHERE fulfillment_status='shipped'").get().c;
  const fulfillPartial = db.prepare("SELECT COUNT(*) as c FROM orders WHERE fulfillment_status='partial'").get().c;
  const fulfillReceived = db.prepare("SELECT COUNT(*) as c FROM orders WHERE fulfillment_status='received'").get().c;

  // Daily orders (last 7 days)
  const dailyOrders = db.prepare(`
    SELECT DATE(created_at) as date, COUNT(*) as count, COALESCE(SUM(total),0) as total
    FROM orders WHERE created_at >= date('now','-7 days','localtime')
    GROUP BY DATE(created_at) ORDER BY date
  `).all();

  res.json({
    summary: {
      total_orders: totalOrders, total_revenue: totalRevenue,
      pending_payments: pendingPayments, pending_orders: pendingOrders,
      verified_orders: verifiedOrders, failed_orders: failedOrders,
      total_items: totalItems, out_of_stock: outOfStock,
      total_gr: totalGR, total_users: totalUsers,
    },
    fulfillment: { pending: fulfillPending, shipped: fulfillShipped, partial: fulfillPartial, received: fulfillReceived },
    orders_by_branch: ordersByBranch,
    recent_orders: recentOrders,
    pending_slips: pendingSlips,
    pending_bc_sync: db.prepare(`
      SELECT o.id, o.order_number, o.bc_so_no, o.total, o.bc_sync_error, o.fully_received_at,
             u.full_name as user_name, u.branch_name, u.branch_code
      FROM orders o
      LEFT JOIN users u ON u.id = o.user_id
      WHERE o.fulfillment_status='received' AND o.bc_posted=0
      ORDER BY o.fully_received_at DESC
      LIMIT 50
    `).all(),
    top_items: topItems,
    daily_orders: dailyOrders,
    fraud_summary: {
      total_24h: db.prepare("SELECT COUNT(*) as c FROM slip_fraud_log WHERE created_at >= datetime('now','-1 day','localtime')").get().c,
      total_7d:  db.prepare("SELECT COUNT(*) as c FROM slip_fraud_log WHERE created_at >= datetime('now','-7 days','localtime')").get().c,
      total_all: db.prepare("SELECT COUNT(*) as c FROM slip_fraud_log").get().c,
    },
  });
});

// ─── Admin: Slip fraud log ───
app.get('/api/admin/fraud-log', requireAuth, requireAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const rows = db.prepare(`
    SELECT f.*, o.order_number
    FROM slip_fraud_log f
    LEFT JOIN orders o ON o.id = f.order_id
    ORDER BY f.created_at DESC LIMIT ?
  `).all(limit);

  // Per-user fraud count (last 7 days) for freeze candidates
  const abusers = db.prepare(`
    SELECT username, COUNT(*) as count
    FROM slip_fraud_log
    WHERE created_at >= datetime('now','-7 days','localtime')
    GROUP BY username HAVING count >= 3
    ORDER BY count DESC LIMIT 20
  `).all();

  res.json({ logs: rows, abusers });
});

// ─── Auto-Cancel: expired pending orders (30 min) ───
const CANCEL_TIMEOUT_MIN = 30;

function autoCancelExpiredOrders() {
  const expired = db.prepare(`
    SELECT id, order_number FROM orders
    WHERE payment_status = 'pending'
      AND COALESCE(payment_method, 'immediate') != 'credit_7d'
      AND created_at <= datetime('now', '-${CANCEL_TIMEOUT_MIN} minutes', 'localtime')
  `).all();

  if (!expired.length) return { cancelled: 0 };

  const cancelTx = db.transaction(() => {
    for (const order of expired) {
      // Restore inventory
      const lines = db.prepare('SELECT item_no, quantity FROM order_lines WHERE order_id=?').all(order.id);
      for (const l of lines) {
        db.prepare('UPDATE items_cache SET inventory = inventory + ? WHERE item_no = ?').run(l.quantity, l.item_no);
      }
      // Mark cancelled
      db.prepare(`UPDATE orders SET payment_status='cancelled', cancelled_at=datetime('now','localtime'), cancelled_by='system', cancel_reason='ยกเลิกอัตโนมัติ (ไม่ชำระเงินภายใน ${CANCEL_TIMEOUT_MIN} นาที)' WHERE id=?`).run(order.id);
    }
  });
  cancelTx();

  if (expired.length > 0) {
    console.log(`[auto-cancel] Cancelled ${expired.length} expired orders: ${expired.map(o => o.order_number).join(', ')}`);
  }
  return { cancelled: expired.length, orders: expired.map(o => o.order_number) };
}

// ─── Cancel: Manual cancel by FC or Admin ───
app.post('/api/orders/:id/cancel', requireAuth, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!isHqAdmin(req.user) && order.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  // FC can cancel: pending, paid only
  // Admin can cancel: pending, paid, verified (if not shipped yet)
  const allowed = isHqAdmin(req.user)
    ? ['pending', 'paid', 'verified']
    : ['pending', 'paid'];
  if (!allowed.includes(order.payment_status)) {
    return res.status(400).json({ error: 'ไม่สามารถยกเลิกคำสั่งซื้อนี้ได้' });
  }
  if (order.payment_status === 'verified' && order.fulfillment_status !== 'pending') {
    return res.status(400).json({ error: 'สินค้าจัดส่งแล้ว ไม่สามารถยกเลิกได้' });
  }
  if (order.payment_status === 'cancelled') {
    return res.status(400).json({ error: 'คำสั่งซื้อถูกยกเลิกไปแล้ว' });
  }

  const { reason = '' } = req.body || {};

  const tx = db.transaction(() => {
    // Restore inventory
    const lines = db.prepare('SELECT item_no, quantity FROM order_lines WHERE order_id=?').all(order.id);
    for (const l of lines) {
      db.prepare('UPDATE items_cache SET inventory = inventory + ? WHERE item_no = ?').run(l.quantity, l.item_no);
    }
    // Mark cancelled
    db.prepare("UPDATE orders SET payment_status='cancelled', cancelled_at=datetime('now','localtime'), cancelled_by=?, cancel_reason=? WHERE id=?")
      .run(req.user.id, reason || 'ยกเลิกโดยผู้ใช้', order.id);
  });
  tx();

  res.json({ ok: true, message: `ยกเลิกคำสั่งซื้อ ${order.order_number} เรียบร้อย` });
});

// ─── Reorder: Create new order from cancelled/old order ───
app.post('/api/orders/:id/reorder', requireAuth, async (req, res) => {
  const oldOrder = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!oldOrder) return res.status(404).json({ error: 'Order not found' });
  if (!isHqAdmin(req.user) && oldOrder.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  const lines = db.prepare('SELECT * FROM order_lines WHERE order_id=?').all(oldOrder.id);
  if (!lines.length) return res.status(400).json({ error: 'ไม่มีรายการสินค้า' });

  // Validate stock
  const cartItems = [];
  for (const l of lines) {
    const item = db.prepare('SELECT * FROM items_cache WHERE item_no=? AND active=1').get(l.item_no);
    if (!item) return res.status(400).json({ error: `สินค้า ${l.item_name} ไม่พบในระบบแล้ว` });
    if (l.quantity > item.inventory) return res.status(400).json({ error: `${l.item_name} สต๊อกไม่เพียงพอ (คงเหลือ ${item.inventory} ${item.uom})` });
    cartItems.push({ item_no: l.item_no, item_name: l.item_name, quantity: l.quantity, unit_price: item.unit_price, uom: item.uom, inventory: item.inventory });
  }

  const orderId = crypto.randomUUID();
  const orderNumber = genOrderNumber();
  const subtotal = cartItems.reduce((s, r) => s + r.quantity * r.unit_price, 0);

  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO orders (id, order_number, user_id, branch_code, subtotal, vat_amount, total, note)
      VALUES (?,?,?,?,?,0,?,?)`).run(orderId, orderNumber, req.user.id, req.user.branch_code || '', subtotal, subtotal, `สั่งใหม่จาก ${oldOrder.order_number}`);

    const insLine = db.prepare('INSERT INTO order_lines (order_id, item_no, item_name, quantity, unit_price, line_total) VALUES (?,?,?,?,?,?)');
    for (const ci of cartItems) {
      insLine.run(orderId, ci.item_no, ci.item_name, ci.quantity, ci.unit_price, ci.quantity * ci.unit_price);
    }

    db.prepare('INSERT INTO payments (order_id, amount) VALUES (?,?)').run(orderId, subtotal);

    const deductStmt = db.prepare('UPDATE items_cache SET inventory = MAX(0, inventory - ?) WHERE item_no = ?');
    for (const ci of cartItems) {
      deductStmt.run(ci.quantity, ci.item_no);
    }
  });
  tx();

  // Post to BC
  let bcResult = null;
  let vatAmount = 0;
  let total = subtotal;
  try {
    bcResult = await postOrderToBC(orderId);
    vatAmount = bcResult.vat_amount || 0;
    total = bcResult.total_incl_vat || subtotal;
  } catch (e) {
    console.error('[BC Reorder]', e.message);
    bcResult = { error: e.message };
  }

  let qrDataUrl = '';
  try { qrDataUrl = await generateQR(total); } catch (e) { console.error('[QR]', e.message); }

  res.json({
    ok: true,
    order_id: orderId,
    order_number: orderNumber,
    subtotal, vat_amount: vatAmount, total,
    bc_so: bcResult,
    qr_data_url: qrDataUrl,
    message: `สร้างคำสั่งซื้อใหม่ ${orderNumber} สำเร็จ`,
  });
});

// ─── BC connection test ───
app.get('/api/bc/status', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (bc.MOCK) return res.json({ mode: 'MOCK', message: 'กำลังใช้ข้อมูล mock (ยังไม่เชื่อม BC จริง)' });
    await bc.getToken();
    res.json({ mode: 'LIVE', message: 'เชื่อม D365 BC สำเร็จ' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Users (admin) ───
app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT id, username, full_name, role, branch_code, branch_name, bc_customer_no, active FROM users ORDER BY username').all());
});

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'jc-market', mode: bc.MOCK ? 'MOCK' : 'LIVE' }));

app.get('/', (req, res) => res.redirect('/login.html'));

app.listen(PORT, () => {
  console.log(`\n🛒 JC-Market running on http://localhost:${PORT}`);
  console.log(`   BC Mode: ${bc.MOCK ? 'MOCK (no credentials)' : 'LIVE'}`);
  console.log(`   Login:   admin/admin1234  |  jf039/fc1234`);
  syncItems().then(r => console.log(`   Initial sync: ${r.count} items (${r.ms}ms)`));
  setInterval(() => syncItems().then(r => console.log(`[sync] ${r.count} items (${r.ms}ms)`)), SYNC_INTERVAL);
  console.log(`   Sync interval: every ${SYNC_INTERVAL/60000} min`);
  // Auto-cancel expired orders every 1 min
  autoCancelExpiredOrders();
  setInterval(autoCancelExpiredOrders, 60 * 1000);
  console.log(`   Auto-cancel: pending orders > ${CANCEL_TIMEOUT_MIN} min\n`);
});
