require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./db');
const { login, requireAuth, requireAdmin } = require('./auth');
const bc = require('./bc-client');

const PORT = process.env.PORT || 3862;
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Auth ───
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const r = login(username, password);
  if (!r) return res.status(401).json({ error: 'Invalid credentials' });
  res.json(r);
});

app.get('/api/me', requireAuth, (req, res) => {
  const u = db.prepare('SELECT id, username, full_name, role, branch_code, branch_name, bc_customer_no FROM users WHERE id=?').get(req.user.id);
  res.json(u);
});

// ─── Items (from cache) ───
app.get('/api/items', requireAuth, (req, res) => {
  const { q = '', category = '' } = req.query;
  let sql = 'SELECT * FROM items_cache WHERE active=1';
  const params = [];
  if (q) { sql += ' AND (name LIKE ? OR item_no LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  if (category) { sql += ' AND category=?'; params.push(category); }
  sql += ' ORDER BY category, name';
  res.json(db.prepare(sql).all(...params));
});

app.get('/api/items/categories', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT DISTINCT category FROM items_cache WHERE active=1 AND category<>"" ORDER BY category').all().map(r => r.category));
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

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'jc-stock-market', mode: bc.MOCK ? 'MOCK' : 'LIVE' }));

// SPA fallbacks
app.get('/', (req, res) => res.redirect('/login.html'));

app.listen(PORT, () => {
  console.log(`\n🛒 JC-Stock Market running on http://localhost:${PORT}`);
  console.log(`   BC Mode: ${bc.MOCK ? 'MOCK (no credentials)' : 'LIVE'}`);
  console.log(`   Login:   admin/admin1234  |  jf039/fc1234\n`);
});
