// Seed the real go-live user set from imports/golive-credentials.json.
//
// Idempotent + deterministic: reads the fixed credential file, upserts every
// user (bcrypt-hashed), and DELETES any leftover login not in the file (test
// staff, tms_test, etc.) so prod starts clean. Run the SAME file on local and
// prod → identical logins.
//
//   node scripts/seed-real-users.js            # dry-run (shows plan)
//   node scripts/seed-real-users.js --yes      # apply
//
// Respects DB_PATH via db.js.

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');

const CRED = path.join(__dirname, '..', 'imports', 'golive-credentials.json');
const APPLY = process.argv.includes('--yes');

if (!fs.existsSync(CRED)) {
  console.error(`Missing ${path.relative(process.cwd(), CRED)} — run gen-golive-credentials.js first.`);
  process.exit(1);
}

const { users } = JSON.parse(fs.readFileSync(CRED, 'utf8'));
const wanted = new Set(users.map((u) => u.username));

// Users currently in the DB that are NOT in the real set → to be removed.
const existing = db.prepare('SELECT username FROM users').all().map((r) => r.username);
const toDelete = existing.filter((u) => !wanted.has(u));

console.log(`Credential file: ${users.length} real users`);
console.log(`DB currently:    ${existing.length} users`);
console.log(`To delete (not in real set): ${toDelete.length}${toDelete.length ? ' → ' + toDelete.join(', ') : ''}`);

if (!APPLY) {
  console.log('\nDRY-RUN. Re-run with --yes to apply.');
  process.exit(0);
}

const upsert = db.transaction(() => {
  // Remove leftovers first.
  const del = db.prepare('DELETE FROM users WHERE username=?');
  for (const u of toDelete) del.run(u);

  const findByUname = db.prepare('SELECT id FROM users WHERE username=?');
  const ins = db.prepare(`INSERT INTO users
    (id, username, password, full_name, role, branch_code, branch_name, bc_customer_no, vendor_no, can_order, active)
    VALUES (?,?,?,?,?,?,?,?,?,?,1)`);
  const upd = db.prepare(`UPDATE users SET
    password=?, full_name=?, role=?, branch_code=?, branch_name=?, bc_customer_no=?, vendor_no=?, can_order=?, active=1
    WHERE username=?`);

  for (const u of users) {
    const hash = bcrypt.hashSync(u.password, 10);
    const isBranch = u.role === 'branch_owner';
    const branch_code = isBranch ? u.branch_code : '';
    const branch_name = isBranch ? u.display_name : '';
    const bc_customer_no = isBranch ? (u.bc_customer_no || '') : '';
    const vendor_no = u.role === 'supplier' ? (u.vendor_no || '') : '';
    const can_order = isBranch ? 1 : 0;

    const row = findByUname.get(u.username);
    if (row) {
      upd.run(hash, u.display_name, u.role, branch_code, branch_name, bc_customer_no, vendor_no, can_order, u.username);
    } else {
      ins.run(crypto.randomUUID(), u.username, hash, u.display_name, u.role, branch_code, branch_name, bc_customer_no, vendor_no, can_order);
    }
  }
});

upsert();

const after = db.prepare('SELECT COUNT(*) n FROM users').get().n;
console.log(`\nDone. Users table now: ${after} rows (deleted ${toDelete.length}, seeded ${users.length}).`);
