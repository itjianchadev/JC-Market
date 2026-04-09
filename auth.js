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
    },
  };
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
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

module.exports = { login, requireAuth, requireAdmin, SECRET };
