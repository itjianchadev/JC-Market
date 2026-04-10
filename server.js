require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const db = require('./db');
const { login, requireAuth, requireAdmin } = require('./auth');
const bc = require('./bc-client');
const { syncItems, getLastSync } = require('./sync');
const { generateQR } = require('./qr');
const { verifySlip, MOCK_VERIFY } = require('./slip-verify');

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

// ─── Cart ───
app.get('/api/cart', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.item_no, c.quantity, c.unit_price,
           i.name as item_name, i.category, i.uom, i.inventory
    FROM cart_items c
    LEFT JOIN items_cache i ON i.item_no = c.item_no
    WHERE c.user_id = ?
    ORDER BY c.created_at
  `).all(req.user.id);
  const total = rows.reduce((s, r) => s + r.quantity * r.unit_price, 0);
  res.json({ items: rows, total, count: rows.length });
});

app.post('/api/cart/add', requireAuth, (req, res) => {
  const { item_no, quantity = 1 } = req.body;
  if (!item_no) return res.status(400).json({ error: 'item_no required' });
  const item = db.prepare('SELECT * FROM items_cache WHERE item_no=? AND active=1').get(item_no);
  if (!item) return res.status(404).json({ error: 'Item not found' });
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
  res.json({ count: r.count });
});

// ─── Orders: Checkout ───
function genOrderNumber() {
  const d = new Date();
  const prefix = `SO${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  const last = db.prepare("SELECT order_number FROM orders WHERE order_number LIKE ? ORDER BY order_number DESC LIMIT 1").get(prefix + '%');
  const seq = last ? parseInt(last.order_number.slice(-4)) + 1 : 1;
  return prefix + String(seq).padStart(4, '0');
}

app.post('/api/orders/checkout', requireAuth, async (req, res) => {
  const { note = '' } = req.body || {};
  // Get cart
  const cartItems = db.prepare(`
    SELECT c.item_no, c.quantity, c.unit_price, i.name as item_name, i.inventory, i.uom
    FROM cart_items c LEFT JOIN items_cache i ON i.item_no=c.item_no
    WHERE c.user_id=?
  `).all(req.user.id);

  if (!cartItems.length) return res.status(400).json({ error: 'ตะกร้าว่าง' });

  // Validate stock
  for (const ci of cartItems) {
    if (ci.quantity > ci.inventory) {
      return res.status(400).json({ error: `${ci.item_name} สต๊อกไม่เพียงพอ (คงเหลือ ${ci.inventory} ${ci.uom})` });
    }
  }

  const orderId = crypto.randomUUID();
  const orderNumber = genOrderNumber();
  const subtotal = cartItems.reduce((s, r) => s + r.quantity * r.unit_price, 0);
  const total = subtotal;

  const tx = db.transaction(() => {
    // Create order
    db.prepare(`INSERT INTO orders (id, order_number, user_id, branch_code, subtotal, total, note)
      VALUES (?,?,?,?,?,?,?)`).run(orderId, orderNumber, req.user.id, req.user.branch_code || '', subtotal, total, note);

    // Create order lines
    const insLine = db.prepare('INSERT INTO order_lines (order_id, item_no, item_name, quantity, unit_price, line_total) VALUES (?,?,?,?,?,?)');
    for (const ci of cartItems) {
      insLine.run(orderId, ci.item_no, ci.item_name, ci.quantity, ci.unit_price, ci.quantity * ci.unit_price);
    }

    // Create payment record
    db.prepare('INSERT INTO payments (order_id, amount) VALUES (?,?)').run(orderId, total);

    // Deduct inventory from cache
    const deductStmt = db.prepare('UPDATE items_cache SET inventory = MAX(0, inventory - ?) WHERE item_no = ?');
    for (const ci of cartItems) {
      deductStmt.run(ci.quantity, ci.item_no);
    }

    // Clear cart
    db.prepare('DELETE FROM cart_items WHERE user_id=?').run(req.user.id);
  });
  tx();

  // Generate PromptPay QR
  let qrDataUrl = '';
  try {
    qrDataUrl = await generateQR(total);
  } catch (e) {
    console.error('[QR]', e.message);
  }

  res.json({
    ok: true,
    order_id: orderId,
    order_number: orderNumber,
    total,
    qr_data_url: qrDataUrl,
    message: `สร้างคำสั่งซื้อ ${orderNumber} สำเร็จ`,
  });
});

// ─── Orders: List ───
app.get('/api/orders', requireAuth, (req, res) => {
  let sql, params;
  if (req.user.role === 'admin') {
    sql = `SELECT o.*, u.full_name as user_name, u.branch_name
           FROM orders o LEFT JOIN users u ON u.id=o.user_id ORDER BY o.created_at DESC`;
    params = [];
  } else {
    sql = `SELECT o.*, u.full_name as user_name, u.branch_name
           FROM orders o LEFT JOIN users u ON u.id=o.user_id WHERE o.user_id=? ORDER BY o.created_at DESC`;
    params = [req.user.id];
  }
  res.json(db.prepare(sql).all(...params));
});

// ─── Orders: Detail ───
app.get('/api/orders/:id', requireAuth, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (req.user.role !== 'admin' && order.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  const lines = db.prepare('SELECT * FROM order_lines WHERE order_id=?').all(order.id);
  const payment = db.prepare('SELECT * FROM payments WHERE order_id=? ORDER BY id DESC LIMIT 1').get(order.id);
  res.json({ ...order, lines, payment });
});

// ─── Orders: QR regenerate ───
app.get('/api/orders/:id/qr', requireAuth, async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.payment_status !== 'pending') return res.status(400).json({ error: 'Order already paid' });
  try {
    const qr = await generateQR(order.total);
    res.json({ qr_data_url: qr, total: order.total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Orders: Upload slip + auto-verify ───
app.post('/api/orders/:id/slip', requireAuth, upload.single('slip'), async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (req.user.role !== 'admin' && order.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  if (!req.file) return res.status(400).json({ error: 'No slip file' });

  const slipPath = '/uploads/' + req.file.filename;
  const absPath = path.join(__dirname, 'uploads', req.file.filename);

  // Auto-verify slip
  const result = await verifySlip(absPath, order.total);

  if (result.verified) {
    // Auto-approved!
    db.prepare(`UPDATE payments SET slip_path=?, qr_ref=?, verified=1, verified_by='auto', verified_at=datetime('now','localtime') WHERE order_id=?`)
      .run(slipPath, result.ref || '', order.id);
    db.prepare("UPDATE orders SET payment_status='verified', paid_at=datetime('now','localtime') WHERE id=?").run(order.id);

    res.json({
      ok: true,
      auto_verified: true,
      slip_path: slipPath,
      verify_result: {
        amount: result.amount,
        sender: result.sender,
        receiver: result.receiver,
        ref: result.ref,
        reason: result.reason,
      },
      message: 'ตรวจสอบสลิปอัตโนมัติผ่าน! คำสั่งซื้ออนุมัติแล้ว',
    });
  } else {
    // Failed auto-verify → manual review
    db.prepare('UPDATE payments SET slip_path=? WHERE order_id=?').run(slipPath, order.id);
    db.prepare("UPDATE orders SET payment_status='paid', paid_at=datetime('now','localtime') WHERE id=?").run(order.id);

    res.json({
      ok: true,
      auto_verified: false,
      slip_path: slipPath,
      verify_result: { reason: result.reason },
      message: 'อัพโหลดสลิปสำเร็จ ตรวจอัตโนมัติไม่ผ่าน — รอ Admin ตรวจสอบ',
    });
  }
});

// ─── Orders: Admin verify payment ───
app.post('/api/orders/:id/verify', requireAuth, requireAdmin, (req, res) => {
  const { action } = req.body; // 'approve' or 'reject'
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (action === 'approve') {
    db.prepare("UPDATE orders SET payment_status='verified' WHERE id=?").run(order.id);
    db.prepare("UPDATE payments SET verified=1, verified_by=?, verified_at=datetime('now','localtime') WHERE order_id=?").run(req.user.id, order.id);
    res.json({ ok: true, message: 'อนุมัติการชำระเงินแล้ว', next: 'ready to post to BC' });
  } else if (action === 'reject') {
    db.prepare("UPDATE orders SET payment_status='failed' WHERE id=?").run(order.id);
    res.json({ ok: true, message: 'ปฏิเสธการชำระเงิน' });
  } else {
    res.status(400).json({ error: 'action must be approve or reject' });
  }
});

// ─── Sync ───
app.post('/api/sync/items', requireAuth, requireAdmin, async (req, res) => {
  const result = await syncItems();
  res.json(result);
});

app.get('/api/sync/status', requireAuth, (req, res) => {
  res.json(getLastSync());
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

app.get('/', (req, res) => res.redirect('/login.html'));

app.listen(PORT, () => {
  console.log(`\n🛒 JC-Stock Market running on http://localhost:${PORT}`);
  console.log(`   BC Mode: ${bc.MOCK ? 'MOCK (no credentials)' : 'LIVE'}`);
  console.log(`   Login:   admin/admin1234  |  jf039/fc1234`);
  syncItems().then(r => console.log(`   Initial sync: ${r.count} items (${r.ms}ms)`));
  setInterval(() => syncItems().then(r => console.log(`[sync] ${r.count} items (${r.ms}ms)`)), SYNC_INTERVAL);
  console.log(`   Sync interval: every ${SYNC_INTERVAL/60000} min\n`);
});
