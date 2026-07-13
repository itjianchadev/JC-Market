// Generate the ONE source-of-truth credential file for go-live.
//
// Passwords are random 6-char "digit + special symbol" (e.g. @22#26) and are
// generated ONCE into imports/golive-credentials.json. Both the local DB and
// prod read the SAME file via seed-real-users.js, so logins match everywhere.
// The PDF export (export-credentials-pdf.js) also reads this file.
//
// Re-running is a no-op unless --force (which rotates every password and would
// desync any DB already seeded from the old file — only use before first seed).
//
//   node scripts/gen-golive-credentials.js            # create if missing
//   node scripts/gen-golive-credentials.js --force     # rotate all passwords
//
// Reads branches from the DB (via db.js, respects DB_PATH) so the branch list
// always tracks reality. Suppliers + HQ are fixed lists below.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');

const OUT = path.join(__dirname, '..', 'imports', 'golive-credentials.json');
const FORCE = process.argv.includes('--force');

// --- Fresh-goods suppliers (Phase 1). Dry goods = Phase 2, skipped. ----------
const SUPPLIERS = [
  { vendor_no: 'SP163', name: 'บริษัท ทรีดี ฟู้ด แอนด์ ดริงค์ จำกัด' }, // fruit (default)
  { vendor_no: 'SP023', name: 'มาลี เอ็นเตอร์ไพรส์ (นมสด)' },
  { vendor_no: 'SP162', name: 'ซีพี-เมจิ (นมสดเมจิ)' },
  { vendor_no: 'SP011', name: 'ริช โปรดักส์ (ครีมเทียมชนิดน้ำ)' },
  { vendor_no: 'SP036', name: 'โกลเบิล พรีเมี่ยม ไวน์ (ครีมชีส/วิปปิ้ง)' },
  { vendor_no: 'SP004', name: 'ดัชมิลล์ (โยเกิร์ต)' },
  { vendor_no: 'SP053', name: 'Hourse Of Croissants (เบเกอรี่)' },
];

// --- HQ departments. CEO = super_admin (see everything). ----------------------
const HQ = [
  { username: 'finance', role: 'finance',     name: 'ฝ่าย Finance (อนุมัติสลิป)' },
  { username: 'scm',     role: 'admin_scm',   name: 'ฝ่าย SCM (จัดซื้อ)' },
  { username: 'admin',   role: 'super_admin', name: 'IT / Admin (ผู้ดูแลระบบ)' },
  { username: 'ceo',     role: 'super_admin', name: 'CEO (ดูภาพรวมทั้งหมด)' },
];

// --- Warehouse / logistics dispatcher (CTI portal: จัดของ + ขนส่ง). -----------
const CTI = [
  { username: 'cti', role: 'cti', name: 'CTI Warehouse Dispatcher (คลัง/จัดส่ง)' },
];

const SYMBOLS = ['@', '#', '$', '%', '&'];

// 6 chars = 4 digits + 2 symbols, shuffled → e.g. @22#26. Crypto-random.
function genPassword() {
  const c = [];
  for (let i = 0; i < 4; i++) c.push(String(crypto.randomInt(0, 10)));
  for (let i = 0; i < 2; i++) c.push(SYMBOLS[crypto.randomInt(0, SYMBOLS.length)]);
  for (let i = c.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [c[i], c[j]] = [c[j], c[i]];
  }
  return c.join('');
}

function main() {
  if (fs.existsSync(OUT) && !FORCE) {
    console.error(`Refusing to overwrite ${path.relative(process.cwd(), OUT)} (already exists).`);
    console.error('Use --force to rotate ALL passwords (only before the first seed).');
    process.exit(1);
  }

  const used = new Set();
  const uniquePw = () => { let p; do { p = genPassword(); } while (used.has(p)); used.add(p); return p; };

  const branches = db.prepare(
    "SELECT code, name, bc_customer_no, branch_type FROM branches WHERE active=1 ORDER BY branch_type, code"
  ).all();

  const users = [];

  // Branch owners (JC master + JF franchise) — can_order.
  for (const b of branches) {
    users.push({
      category: b.branch_type === 'jc' ? 'branch-jc' : 'branch-fc',
      username: b.code.toLowerCase(),
      password: uniquePw(),
      role: 'branch_owner',
      display_name: b.name,
      branch_code: b.code,
      bc_customer_no: b.bc_customer_no || b.code, // reconciled convention = branch code
      branch_type: b.branch_type,
    });
  }

  // Fresh-goods suppliers — username = vendor code.
  for (const s of SUPPLIERS) {
    users.push({
      category: 'supplier',
      username: s.vendor_no.toLowerCase(),
      password: uniquePw(),
      role: 'supplier',
      display_name: s.name,
      vendor_no: s.vendor_no,
    });
  }

  // HQ departments.
  for (const h of HQ) {
    users.push({
      category: 'hq',
      username: h.username,
      password: uniquePw(),
      role: h.role,
      display_name: h.name,
    });
  }

  // CTI warehouse/logistics dispatcher.
  for (const h of CTI) {
    users.push({
      category: 'cti',
      username: h.username,
      password: uniquePw(),
      role: h.role,
      display_name: h.name,
    });
  }

  const payload = {
    generated_for: 'JC-Market go-live',
    schema: 'v1',
    count: users.length,
    users,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });

  const by = users.reduce((m, u) => ((m[u.category] = (m[u.category] || 0) + 1), m), {});
  console.log(`Wrote ${users.length} credentials → ${path.relative(process.cwd(), OUT)}`);
  console.log('  ', JSON.stringify(by));
}

main();
