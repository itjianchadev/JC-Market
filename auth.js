const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./db');

const SECRET = process.env.JWT_SECRET || 'jc-stock-market-dev-secret';
const EXPIRES = '7d';

function login(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(username);
  if (!user) return null;
  if (!bcrypt.compareSync(password, user.password)) return null;
  // Resolve branch_type via the branches table — used by the frontend to
  // hide payment-method pickers / receipt UI for JC master outlets.
  const branchRow = user.branch_code
    ? db.prepare('SELECT branch_type FROM branches WHERE code = ?').get(user.branch_code)
    : null;
  const branch_type = (branchRow && branchRow.branch_type) || 'fc';
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role, branch_code: user.branch_code, branch_type, vendor_no: user.vendor_no || '' }, SECRET, { expiresIn: EXPIRES });
  return {
    token,
    user: {
      id: user.id, username: user.username, full_name: user.full_name,
      role: user.role, branch_code: user.branch_code, branch_name: user.branch_name,
      branch_type,
      bc_customer_no: user.bc_customer_no,
      vendor_no: user.vendor_no || '',
      can_order: !!user.can_order,
    },
  };
}

// ─── Role helpers ───
// HQ-level roles (no branch). super_admin = full ops, admin_scm = SCM dept,
// finance = approves bank-slip transfers and gates BC SO creation.
const HQ_ROLES = new Set(['super_admin', 'admin_scm', 'finance']);
const ADMIN_ROLES = HQ_ROLES;                                   // กลุ่มที่ผ่าน requireAdmin
// Portal roles — external / limited logins that are NEITHER branch users NOR
// HQ admins. Like HQ roles they carry no branch_code, but they must NOT pass
// requireAdmin. Each gets its own scoped surface:
//   supplier — fresh-goods (ของสด) vendor: sees its own PO deliveries + updates status
//   cti      — CTI warehouse dispatcher: runs the TMS trip builder for general goods
const PORTAL_ROLES = new Set(['supplier', 'cti']);
// Roles that legitimately have no branch_code (used by user-creation validation).
const NON_BRANCH_ROLES = new Set([...HQ_ROLES, ...PORTAL_ROLES]);
// Branch-level role hierarchy (top → bottom):
//   branch_owner   — manages users in own branch + everything below
//   store_manager  — daily ops + approvals
//   cashier        — sales / payment side
//   stock          — receive + issue + reorder-point upkeep
//   staff          — view + assist, no write to inventory
//   fc             — legacy "generic branch member" (kept for back-compat)
const BRANCH_ROLES = new Set(['branch_owner', 'store_manager', 'cashier', 'stock', 'staff', 'fc']);

function isHqAdmin(user) { return !!user && ADMIN_ROLES.has(user.role); }
function isSuperAdmin(user) { return !!user && user.role === 'super_admin'; }
// TMS trip management surface: HQ admins PLUS the CTI warehouse dispatcher.
function isTmsManager(user) { return isHqAdmin(user) || (!!user && user.role === 'cti'); }

// Can manage users in a given branch? (HQ admin for any, branch_owner for own)
function canManageBranch(user, branchCode) {
  if (!user) return false;
  if (ADMIN_ROLES.has(user.role)) return true;
  if (user.role === 'branch_owner' && user.branch_code === branchCode) return true;
  return false;
}

function requireBranchManage(req, res, next) {
  const code = req.params.code || req.body.branch_code || req.query.branch_code || req.user?.branch_code;
  if (!canManageBranch(req.user, code)) return res.status(403).json({ error: 'Not allowed for this branch' });
  next();
}

function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const payload = jwt.verify(token, SECRET);
    // requireAuth is for the regular user surface (users table). Driver
    // tokens have kind='driver' — reject them here so a driver token can't
    // reach a user-only endpoint by accident.
    if (payload.kind === 'driver') return res.status(401).json({ error: 'Wrong token type' });
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function requireAdmin(req, res, next) {
  if (!isHqAdmin(req.user)) return res.status(403).json({ error: 'Admin only' });
  next();
}

function requireSuperAdmin(req, res, next) {
  if (!isSuperAdmin(req.user)) return res.status(403).json({ error: 'Super Admin only' });
  next();
}

// CTI warehouse dispatcher OR HQ admin — gates the TMS trip-builder surface so
// CTI can run general-goods dispatch without full HQ-admin powers.
function requireTmsManager(req, res, next) {
  if (!isTmsManager(req.user)) return res.status(403).json({ error: 'TMS manager only' });
  next();
}

// Fresh-goods supplier — gates the supplier delivery portal.
function requireSupplier(req, res, next) {
  if (!req.user || req.user.role !== 'supplier') return res.status(403).json({ error: 'Supplier only' });
  next();
}

// ─── Driver authentication (TMS Phase 1.4) ─────────────────────────────────
// Drivers live in the separate carrier_drivers table and never reach the
// regular `users` surface. They authenticate via /api/tms/driver/login and
// carry a JWT with kind='driver' so the wrong middleware refuses them.
//
// Login is phone-number only (no password). carrier_drivers.phone has a
// partial unique index — see db.js — so an ambiguous match can't happen.
// All stored phones are pre-normalized to digits-only; we apply the same
// normaliser to the user's input so common formats ("081-234-5678",
// "081 234 5678", "+66 81 234 5678") all reach the same row.
const DRIVER_EXPIRES = '7d';

function normalizePhone(s) {
  let n = String(s || '').replace(/[^0-9]/g, '');
  // Thai mobile international form 66XXXXXXXXX → local 0XXXXXXXXX so the
  // same physical number stays a single row regardless of which way the
  // driver types it.
  if (n.length === 11 && n.startsWith('66')) n = '0' + n.slice(2);
  return n;
}

function driverLogin(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  // Match against ANY of the driver's registered phones (carrier_driver_phones),
  // so a driver with multiple numbers can log in with whichever they use.
  const driver = db.prepare(`
    SELECT d.*, c.code as carrier_code, c.name as carrier_name
    FROM carrier_driver_phones p
    JOIN carrier_drivers d ON d.id = p.driver_id
    LEFT JOIN carriers c ON c.id = d.carrier_id
    WHERE p.phone = ? AND d.active = 1
  `).get(normalized);
  if (!driver) return null;
  const token = jwt.sign({
    kind: 'driver',
    id: driver.id,
    username: driver.username,
    carrier_id: driver.carrier_id,
    carrier_code: driver.carrier_code,
  }, SECRET, { expiresIn: DRIVER_EXPIRES });
  return {
    token,
    driver: {
      id: driver.id,
      username: driver.username,
      full_name: driver.full_name,
      phone: driver.phone,
      vehicle_plate: driver.vehicle_plate,
      vehicle_province: driver.vehicle_province || '',
      carrier_id: driver.carrier_id,
      carrier_code: driver.carrier_code,
      carrier_name: driver.carrier_name,
    },
  };
}

function requireDriver(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const payload = jwt.verify(token, SECRET);
    if (payload.kind !== 'driver') return res.status(401).json({ error: 'Driver token required' });
    // Reject if the row got disabled since the token was issued; otherwise a
    // deactivated driver could keep using their old token until expiry.
    const row = db.prepare('SELECT active FROM carrier_drivers WHERE id=?').get(payload.id);
    if (!row || !row.active) return res.status(401).json({ error: 'Driver inactive' });
    req.driver = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

module.exports = { login, requireAuth, requireAdmin, requireSuperAdmin, requireTmsManager, requireSupplier, canManageBranch, requireBranchManage, isHqAdmin, isSuperAdmin, isTmsManager, HQ_ROLES, PORTAL_ROLES, NON_BRANCH_ROLES, BRANCH_ROLES, SECRET, driverLogin, requireDriver, normalizePhone };
