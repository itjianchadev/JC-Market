const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./db');

const SECRET = process.env.JWT_SECRET || 'jc-stock-market-dev-secret';
const EXPIRES = '7d';

function login(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(username);
  if (!user) return null;
  if (!bcrypt.compareSync(password, user.password)) return null;
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role, branch_code: user.branch_code }, SECRET, { expiresIn: EXPIRES });
  return {
    token,
    user: {
      id: user.id, username: user.username, full_name: user.full_name,
      role: user.role, branch_code: user.branch_code, branch_name: user.branch_name,
      bc_customer_no: user.bc_customer_no,
      can_order: !!user.can_order,
    },
  };
}

// ─── Role helpers ───
// HQ-level roles (no branch). super_admin = full ops, admin_scm = SCM dept,
// finance = approves bank-slip transfers and gates BC SO creation.
const HQ_ROLES = new Set(['super_admin', 'admin_scm', 'finance']);
const ADMIN_ROLES = HQ_ROLES;                                   // กลุ่มที่ผ่าน requireAdmin
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
    req.user = jwt.verify(token, SECRET);
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

module.exports = { login, requireAuth, requireAdmin, requireSuperAdmin, canManageBranch, requireBranchManage, isHqAdmin, isSuperAdmin, HQ_ROLES, BRANCH_ROLES, SECRET };
