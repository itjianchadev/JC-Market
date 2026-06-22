// Create (or reset) a portal login — supplier or cti — without baking
// default-credential accounts into db.js (which would land on prod). Ops runs
// this on prod with real passwords; we also use it to seed local test logins.
// Respects DB_PATH (defaults to data/stock-market.db via db.js).
//
// Usage:
//   node scripts/create-portal-user.js supplier <username> <password> <vendor_no> ["Full Name"]
//   node scripts/create-portal-user.js cti      <username> <password>            ["Full Name"]
const db = require('../db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const [, , role, username, password, ...rest] = process.argv;
const PORTAL = new Set(['supplier', 'cti']);

if (!PORTAL.has(role) || !username || !password) {
  console.error('Usage: node scripts/create-portal-user.js <supplier|cti> <username> <password> [vendor_no] ["Full Name"]');
  process.exit(1);
}

let vendor_no = '';
let full_name = '';
if (role === 'supplier') {
  vendor_no = rest[0] || '';
  if (!vendor_no) { console.error('Error: supplier requires <vendor_no> (e.g. SP163)'); process.exit(1); }
  full_name = rest.slice(1).join(' ') || ('Supplier ' + vendor_no);
} else {
  full_name = rest.join(' ') || ('CTI ' + username);
}

const hash = bcrypt.hashSync(password, 10);
const existing = db.prepare('SELECT id FROM users WHERE username=?').get(username);
if (existing) {
  db.prepare(`UPDATE users SET password=?, full_name=?, role=?, vendor_no=?, branch_code='', branch_name='', can_order=0, active=1 WHERE username=?`)
    .run(hash, full_name, role, vendor_no, username);
  console.log(`Updated ${role} '${username}'${vendor_no ? ` (vendor ${vendor_no})` : ''}`);
} else {
  db.prepare(`INSERT INTO users (id, username, password, full_name, role, branch_code, branch_name, bc_customer_no, vendor_no, can_order, active)
    VALUES (?,?,?,?,?,'','','',?,0,1)`)
    .run(crypto.randomUUID(), username, hash, full_name, role, vendor_no);
  console.log(`Created ${role} '${username}'${vendor_no ? ` (vendor ${vendor_no})` : ''}`);
}
