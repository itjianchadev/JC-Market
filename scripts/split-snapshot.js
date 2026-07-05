// Split a bc-snapshot workbook into one file per ERP data group — Setup /
// Master / Opening-Balances — driven by the snapshot's own `_INDEX` sheet.
// No BC calls: pure local re-pack of an existing snapshot, so it can't be
// rate-limited or time out against the API. Each output carries a `_INDEX`
// slice scoped to its group.
//
//   node scripts/split-snapshot.js                              # latest snapshot in imports/
//   node scripts/split-snapshot.js --file=imports/bc-snapshot-Jiancha_dev2-....xlsx
//   node scripts/split-snapshot.js --outdir=imports
//
// Output: imports/BC-<Group>-<env>-<stamp>.xlsx  (imports/ is gitignored)
//   BC-Setup-<env>-<stamp>.xlsx           → IT / Exsys (config, posting setup, no. series)
//   BC-Master-<env>-<stamp>.xlsx          → SCM (items, vendors, customers, UoM, prices)
//   BC-OpeningBalances-<env>-<stamp>.xlsx → Finance (ledgers, trial balance, stock)

const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

const arg = (k, d) => {
  const h = process.argv.find(a => a.startsWith(`--${k}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};

const IMPORTS = path.join(__dirname, '..', 'imports');
let file = arg('file', '');
if (!file) {
  const snaps = fs.readdirSync(IMPORTS)
    .filter(f => /^bc-snapshot-.*\.xlsx$/.test(f))
    .map(f => ({ f, t: fs.statSync(path.join(IMPORTS, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!snaps.length) { console.error('no bc-snapshot-*.xlsx in imports/'); process.exit(1); }
  file = path.join(IMPORTS, snaps[0].f);
}
const OUTDIR = arg('outdir', IMPORTS);
const READABLE = process.argv.includes('--readable'); // drop GUID system-id columns

// A column is a GUID/system-id column when every non-empty value is a GUID
// (incl. the all-zero null GUID). Those are BC foreign keys with no human value
// — their readable twin is the sibling *Code column — so --readable drops them.
// Numbers stay numbers, text codes (incl. leading-zero item numbers) stay text.
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function stripGuidCols(ws) {
  const ref = xlsx.utils.decode_range(ws['!ref']);
  const sampleEnd = Math.min(ref.e.r, ref.s.r + 200); // classify on a sample, not 90k rows
  const drop = [];
  for (let c = ref.s.c; c <= ref.e.c; c++) {
    let seen = 0, allGuid = true;
    for (let r = ref.s.r + 1; r <= sampleEnd; r++) {
      const cell = ws[xlsx.utils.encode_cell({ r, c })];
      if (!cell || cell.v === '' || cell.v == null) continue;
      seen++;
      if (!(cell.t === 's' && GUID_RE.test(String(cell.v)))) { allGuid = false; break; }
    }
    if (allGuid && seen > 0) drop.push(c);
  }
  if (!drop.length) return { ws, dropped: [] }; // fast path — no rebuild (keeps big sheets cheap)
  const aoa = xlsx.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  const dropSet = new Set(drop);
  const header = aoa[0] || [];
  const filtered = aoa.map(row => row.filter((_, c) => !dropSet.has(c)));
  return { ws: xlsx.utils.aoa_to_sheet(filtered), dropped: drop.map(c => header[c]) };
}

// derive <env> and <stamp> from filename: bc-snapshot-<env>-<stamp>.xlsx
const m = path.basename(file).match(/^bc-snapshot-(.+)-(\d{4}-\d{2}-\d{2}T[\d-]+)\.xlsx$/);
const ENV = m ? m[1] : 'env';
const STAMP = m ? m[2] : 'snap';

// group key (from _INDEX) -> human file label
const GROUPS = [
  { key: 'setup',    label: 'Setup' },
  { key: 'master',   label: 'Master' },
  { key: 'balances', label: 'OpeningBalances' },
];
const IDX_HEADER = ['group', 'sheet', 'kind', 'status', 'rows', 'endpoint', 'note'];

console.log('Splitting:', path.basename(file), `· env=${ENV}\n`);

// 1) read ONLY _INDEX to learn which sheets belong to which group, and which
//    are physically present (status OK — EMPTY/SKIP/ERROR rows have no sheet).
const idxWb = xlsx.readFile(file, { sheets: ['_INDEX'] });
const idx = xlsx.utils.sheet_to_json(idxWb.Sheets['_INDEX']);
const present = idx.filter(r => r.status === 'OK');

const written = [];
for (const g of GROUPS) {
  const sheetNames = present.filter(r => r.group === g.key).map(r => String(r.sheet));
  if (!sheetNames.length) { console.log(`  (skip ${g.label}: no OK sheets)`); continue; }

  // 2) parse ONLY this group's sheets — keeps the heavy 90k-row itemLedgerEntries
  //    parse confined to the balances pass instead of every pass.
  const src = xlsx.readFile(file, { sheets: sheetNames });
  const out = xlsx.utils.book_new();

  // _INDEX slice as the landing tab
  const slice = idx.filter(r => r.group === g.key);
  xlsx.utils.book_append_sheet(out, xlsx.utils.json_to_sheet(slice, { header: IDX_HEADER }), '_INDEX');

  let totalRows = 0, droppedCols = 0;
  for (const name of sheetNames) {
    let ws = src.Sheets[name];
    if (!ws) { console.log(`    ! source missing sheet ${name}`); continue; }
    if (READABLE) { const r = stripGuidCols(ws); ws = r.ws; droppedCols += r.dropped.length; }
    xlsx.utils.book_append_sheet(out, ws, name.slice(0, 31));
    totalRows += Number(present.find(r => String(r.sheet) === name)?.rows) || 0;
  }

  const tag = READABLE ? '-readable' : '';
  const outPath = path.join(OUTDIR, `BC-${g.label}${tag}-${ENV}-${STAMP}.xlsx`);
  xlsx.writeFile(out, outPath);
  const sz = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
  written.push({ label: g.label, sheets: sheetNames.length, rows: totalRows, sz, outPath });
  console.log(`  OK  ${g.label.padEnd(16)} ${String(sheetNames.length).padStart(2)} sheets · ${String(totalRows.toLocaleString()).padStart(8)} rows · ${sz.padStart(6)}MB` + (READABLE ? ` · dropped ${droppedCols} GUID cols` : ''));
  console.log(`      ${outPath}`);
}

console.log(`\nDone — ${written.length} files written to ${OUTDIR}`);
