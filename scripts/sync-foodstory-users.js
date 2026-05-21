// Pull the FoodStory branch list (the source of truth for JC's outlets) and
// seed JC-Market accounts. One row per branch in the FoodStory back office
// becomes one branches/users pair in this app.
//
// Reuses the existing FoodStory login pipeline at
//   /Users/jiancha/AgenAi_Jiancha/FoodStory/foodstory_login.js
// (cookie cache + 2Captcha refresh) — no creds in this file.
//
// Idempotency:
//   branches → INSERT OR IGNORE then UPDATE name+branch_type so re-runs
//     refresh placeholder names like "JC002 DGT" with the real FoodStory
//     name "JC002 Banthat Thong(Dragon Town)".
//   users    → skip if username already exists (don't clobber a password
//     someone might already be logged in with). Newly-created users get a
//     fresh random password + are exported to a CSV under imports/.
//
// Usage:
//   node scripts/sync-foodstory-users.js                # do the work
//   node scripts/sync-foodstory-users.js --dry-run      # parse only, no DB writes
//   node scripts/sync-foodstory-users.js --jf-only      # franchise only
//   node scripts/sync-foodstory-users.js --jc-only      # master only

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const fetch = require('node-fetch');
const bcrypt = require('bcryptjs');

const DRY_RUN = process.argv.includes('--dry-run');
const JF_ONLY = process.argv.includes('--jf-only');
const JC_ONLY = process.argv.includes('--jc-only');
// --reset also overwrites passwords of users that already exist. Use this when
// bootstrapping a new credentials sheet for the whole network. Default is to
// leave existing users alone — safer because anyone already logged in keeps
// working.
const RESET = process.argv.includes('--reset');

const FS_PROJECT = '/Users/jiancha/AgenAi_Jiancha/FoodStory';
const fsLogin = require(path.join(FS_PROJECT, 'foodstory_login'));
const HIDDEN_FILE = path.join(FS_PROJECT, 'branches_hidden.json');

const db = require(path.join(__dirname, '..', 'db')); // run alongside server's better-sqlite3 wrapper

const IMPORTS_DIR = path.join(__dirname, '..', 'imports');
fs.mkdirSync(IMPORTS_DIR, { recursive: true });

// ─── Helpers ──────────────────────────────────────────────────────────
// 8-digit numeric — easier to type on mobile / dictate over the phone than
// a 12-char alphanumeric. Trade-off: smaller key space (10^8) but the
// branch_owner accounts are behind a username and rate-limited by the app,
// so brute force isn't a realistic threat for this use case.
function randomPassword(len = 8) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += String(bytes[i] % 10);
  return out;
}

function parseBranchString(raw) {
  // "JF045 Charn Avenue" → { code:'JF045', name:'Charn Avenue', type:'fc' }
  // "JC002 Banthat Thong(Dragon Town)" → { code:'JC002', name:'…', type:'jc' }
  const m = raw.match(/^(J[FC]\d+)\s+(.+)$/);
  if (!m) return null;
  const code = m[1];
  return { code, name: m[2].trim(), type: code.startsWith('JC') ? 'jc' : 'fc' };
}

// ─── Fetch branches from FoodStory ───────────────────────────────────
async function fetchBranches() {
  console.log('🔐 Getting FoodStory cookie...');
  const cookie = await fsLogin.getValidCookie();
  if (!cookie) throw new Error('No cookie from foodstory_login');

  // FoodStory's "sales by sum date" endpoint returns one row per branch per
  // date. Picking the most recent date gives us the active-branches list.
  const params = new URLSearchParams({
    'draw': '1',
    'columns[16][data]': 'branch_id',
    'order[0][column]': '16',
    'order[0][dir]': 'asc',
    'start': '0',
    'length': '500',
    'search[value]': '',
    'search[regex]': 'false',
  });
  const url = `https://owner.foodstory.co/th/salebysumdate/getdata?${params}`;

  console.log('🌐 Fetching:', url.slice(0, 80) + '...');
  const r = await fetch(url, {
    headers: {
      'Cookie': cookie,
      'Accept': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Referer': 'https://owner.foodstory.co/th/salebysumdate',
    },
  });
  if (!r.ok) throw new Error(`FoodStory fetch failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  if (!j.data) throw new Error('No data field in FoodStory response: ' + JSON.stringify(j).slice(0, 200));

  // Union ALL branch_ids across the returned date window — a branch with 0
  // sales on the latest date would otherwise be dropped (saw JC010 missing
  // when only the latest date was considered).
  const dates = [...new Set(j.data.map(r => r.date))].sort().reverse();
  console.log(`📊 FoodStory returned ${j.data.length} rows across ${dates.length} date(s) (latest=${dates[0]})`);

  let hidden = new Set();
  try { hidden = new Set(JSON.parse(fs.readFileSync(HIDDEN_FILE, 'utf8'))); } catch {}

  const seen = new Set();
  const branches = [];
  for (const row of j.data) {
    if (!row.branch_id || seen.has(row.branch_id)) continue;
    seen.add(row.branch_id);
    if (hidden.has(row.branch_id)) continue;
    const parsed = parseBranchString(row.branch_id);
    if (!parsed) continue;
    if (JF_ONLY && parsed.type !== 'fc') continue;
    if (JC_ONLY && parsed.type !== 'jc') continue;
    branches.push(parsed);
  }
  branches.sort((a, b) => a.code.localeCompare(b.code));
  return branches;
}

// ─── Apply to DB ──────────────────────────────────────────────────────
function applyBranches(branches) {
  const upsertBranch = db.prepare(`
    INSERT INTO branches (code, name, branch_type, bc_customer_no)
    VALUES (?, ?, ?, '')
    ON CONFLICT(code) DO UPDATE SET name = excluded.name, branch_type = excluded.branch_type
  `);
  const findUser = db.prepare('SELECT id FROM users WHERE username = ?');
  const insertUser = db.prepare(`
    INSERT INTO users (id, username, password, full_name, role, branch_code, branch_name, bc_customer_no, can_order)
    VALUES (?,?,?,?,?,?,?,?,1)
  `);
  const resetPassword = db.prepare('UPDATE users SET password = ?, branch_name = ? WHERE id = ?');

  const report = []; // rows for CSV
  let newUsers = 0, resetUsers = 0, skippedUsers = 0;

  const processOne = (b) => {
    if (!DRY_RUN) upsertBranch.run(b.code, b.name, b.type);
    const username = b.code.toLowerCase();
    const existing = findUser.get(username);
    const password = randomPassword(8);
    const tag = DRY_RUN ? ' (dry-run, not written)' : '';

    if (existing) {
      if (!RESET) {
        skippedUsers++;
        report.push({ code: b.code, name: b.name, type: b.type, username, password: '(unchanged — pass --reset to overwrite)' });
        return;
      }
      // --reset: regenerate password for the existing user. Branch name also
      // refreshed so the CSV/credentials sheet stays consistent with whatever
      // FoodStory says today.
      if (!DRY_RUN) resetPassword.run(bcrypt.hashSync(password, 10), b.name, existing.id);
      resetUsers++;
      report.push({ code: b.code, name: b.name, type: b.type, username, password: password + tag });
      return;
    }
    if (!DRY_RUN) {
      insertUser.run(
        crypto.randomUUID(),
        username,
        bcrypt.hashSync(password, 10),
        'Owner ' + b.code,
        'branch_owner',
        b.code,
        b.name,
        '',
      );
    }
    newUsers++;
    report.push({ code: b.code, name: b.name, type: b.type, username, password: password + tag });
  };

  if (DRY_RUN) {
    branches.forEach(processOne);
  } else {
    db.transaction((rows) => rows.forEach(processOne))(branches);
  }
  return { report, newUsers, resetUsers, skippedUsers };
}

// ─── CSV ──────────────────────────────────────────────────────────────
function writeCsv(report) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(IMPORTS_DIR, `foodstory-users-${ts}.csv`);
  const lines = [
    'code,name,type,username,password',
    ...report.map(r => {
      const esc = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
      return [r.code, r.name, r.type, r.username, r.password].map(esc).join(',');
    }),
  ];
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

// ─── Main ─────────────────────────────────────────────────────────────
(async () => {
  if (DRY_RUN) console.log('🛟 DRY RUN — no DB writes');
  const branches = await fetchBranches();
  console.log(`\n📋 ${branches.length} active branches (JF=${branches.filter(b=>b.type==='fc').length}, JC=${branches.filter(b=>b.type==='jc').length})`);

  const { report, newUsers, resetUsers, skippedUsers } = applyBranches(branches);

  const file = writeCsv(report);
  console.log(`\n✅ Done`);
  console.log(`   New users:        ${newUsers}`);
  console.log(`   Reset passwords:  ${resetUsers}${RESET ? '' : ' (skipped — use --reset)'}`);
  console.log(`   Unchanged:        ${skippedUsers}`);
  console.log(`   CSV:              ${file}`);
})().catch(e => { console.error('❌', e.message); console.error(e.stack); process.exit(1); });
