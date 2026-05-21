# JC-Market

B2B stock ordering portal for Jiancha franchise (JF) + master (JC) outlets.
Node.js + Express + better-sqlite3 + D365 Business Central integration.

## Runtime

- **Server**: `node server.js` on port 3863 (`PORT` in `.env`)
- **DB**: SQLite at `data/stock-market.db` — migrations are idempotent `ALTER TABLE` calls in `db.js` (safe to re-run on startup)
- **BC environment**: `Jiancha_develop` · company `Jian Cha Co.,Ltd.` (id `88578c53-733c-f011-be59-000d3ac901b1`)
- **BC default vendor** (auto-PO): `SP049` (env `BC_DEFAULT_VENDOR_NO` — switch to `SP163` once that vendor exists in Dev)
- **Item sync**: every 5 min via `sync.js`. Token cached in `bc-client.js`; refresh on startup if expired.

## Roles + branch types

**HQ roles** (no `branch_code`, `can_order=0`):
- `super_admin` — `itmanager`, full ops
- `admin_scm` — `admin`, SCM dept
- `finance` — `finance`, gatekeeper for slip approval. After login, auto-redirects to `/approvals.html`.

**Branch roles** (have `branch_code`, `can_order=1`):
- `branch_owner`, `store_manager`, `cashier`, `stock`, `staff`, `fc` (legacy)

**branches.branch_type**:
- `'fc'` — franchise (JF001-JF059) · pays via slip · goes through Finance
- `'jc'` — master / company-owned (JC002-JC010) · no payment · no Finance step

`auth.js` exposes `branch_type` in login response + JWT. Frontend hides payment UI when `branch_type === 'jc'`.

## Order workflow (the most important table)

| Path | Trigger | BC docs created | Finance? | Payment? |
|---|---|---|---|---|
| FC + general | `verify` approve | SO + PO | yes | slip |
| FC + fruit + immediate | checkout | SO + PO | (slip verify only) | slip |
| FC + fruit + credit_7d | checkout | SO + PO | (slip verify when paid) | slip within 7d |
| JC + general | checkout | **TRO** (CTI → JC0xx) | no | — |
| JC + fruit | checkout | PO only (no SO) | no | — |

- Auto-cancel timer: 30 min for FC `pending`. Skipped for `payment_method='credit_7d'` and JC orders (status flips to `verified` immediately).
- Overdue credit (`payment_method='credit_7d'` + past `credit_due_at`): FC blocked from new fruit orders until cleared. General products still allowed.
- No mixed-category orders (fruit ⊕ general in same cart blocked at `/cart/add` and checkout).

## BC integration touchpoints

- `postOrderToBC(orderId)` — creates Sales Order. Idempotent on `bc_so_no`.
- `postPOToBC(orderId, vendorNo)` — creates Purchase Order. Falls back to env vendor. JC purchase orders bypass the `bc_so_no` requirement.
- `postTransferOrderToBC(orderId, toCode)` — creates Transfer Order via the **OData Web Service** at Page 5740/5741. Service names are in env (`BC_WS_TRANSFER_ORDER`, `BC_WS_TRANSFER_ORDER_LINE`) because the currently-published name has a typo: `Transfer0rder` with zero where O should be.
- Locations: SO line → `CTI` (`7e4291d6-…`). PO line → `INTRANSIT` (`814291d6-…`).

## Conventions

- **Git workflow**: I work on a feature branch → push → open PR → user merges on GitHub → user tells me → I sync `main` + `git branch -d` the local branch. Never merge or force-push without explicit instruction.
- **PR titles**: conventional commits (`feat(…)`, `fix(…)`, `chore(…)`, `docs(…)`, `refactor(…)`).
- **Language**: Thai for chat replies, i18n keys in `public/js/app.js` have both TH+EN.
- **No emojis in code** unless asked. UI text can have them per design.
- **No `await sleep()` polling loops** to wait for harness-tracked work. Use background tasks + notifications.
- **Sensitive data gitignored**: `imports/` (credentials CSVs, BC master Excel), `.env`, `data/*.db`, `.claude/` (per-repo Claude config).
- **Receipt/print PDF styles intentionally keep `#181818`** — paper readability matters more than the no-black brand rule for screens.
- **CI palette**: white + gold (`#AD9C82` brand, `#8a7d66` darker, `#2a2118` warm text). No pure black on screen.

## Scripts (under `scripts/`)

| Script | What it does |
|---|---|
| `import-bc-master.js` | Bulk-import Vendor / Item / UoM from BC Excel exports into Dev. Idempotent. Supports `--dry-run`, `--limit=N`, `[uom|vendors|items|item-uom]` |
| `sync-foodstory-users.js` | Pull active branches from FoodStory backend (`/th/salebysumdate/getdata`) → seed branches/users in JC-Market. `--reset` rotates existing passwords. Outputs CSV under `imports/`. Reuses `/Users/jiancha/AgenAi_Jiancha/FoodStory/foodstory_login.js` (cookie cache + 2Captcha refresh). |
| `capture-training-screenshots.js` | Playwright headless drives each role through happy-path and dumps PNGs into `docs/training/screenshots/{role}/`. Waits on `localStorage['jcsm_token']` rather than network-idle. Seeds cart via API not UI click. |
| `export-training-pdf.js` | Renders `docs/training/*.md` → PDF via marked + Playwright. Outputs `docs/training/pdf/*.pdf` + combined `all-training.pdf`. |

## Training docs

`docs/training/` — TH manuals for the 4 roles (FC, JC, Finance, IT) with embedded screenshots. Markdown + matching PDFs.

## Known gaps / known issues

- `Transfer0rder` Web Service has a typo (zero, not O). Workaround in `.env`; rename on BC side later and update env to match.
- 138 items have Sales/Purch UoM ≠ Base UoM and Dev is missing the Item Unit of Measure (table 5717) entries — re-run `import-bc-master.js item-uom` after a 5717 export lands.
- Posting groups `FG-BK` (14 items) + `AL` (10 items) don't exist in Dev — Item insert fails for those. Create in BC then re-run `import-bc-master.js items`.
- JC010 has no FoodStory sales in the last 7 days, so the placeholder name "JC010" sticks until activity shows up.
- Sales Price (Unit Price = 0 on all items today). Held intentionally per user; re-run import once a Sales Price export is provided.

## When you (Claude) start a session here

1. Pull the latest `main` if I'm asking about ongoing work — don't assume the last conversation's state is current.
2. If something's surprising, `sqlite3 data/stock-market.db "PRAGMA table_info(orders)"` etc. — schema does drift between PRs.
3. The dev server may already be running on 3863 — `lsof -i :3863 -t` first. Don't kill it unless explicitly told.
4. Static files (`public/*`) are served fresh by `express.static` — reloading the browser sees CSS/JS/HTML edits immediately. Server-side changes (`server.js`, `db.js`, `auth.js`, `bc-client.js`) need a restart.
