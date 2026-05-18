/**
 * Slip Auto-Verification Service (with Anti-Fraud)
 *
 * ใช้ SlipOK API (https://slipok.com) อ่าน QR บนสลิปธนาคาร
 * ตรวจสอบ: ยอดเงิน, ผู้รับ, วันเวลา
 *
 * Anti-fraud:
 *   1) QR verification via SlipOK → ITMX (กันแก้ภาพ)
 *   2) Duplicate qr_ref (กันใช้สลิปซ้ำ)
 *   3) Image SHA-256 hash dedup (กันส่งไฟล์เดิม)
 *   4) Time-window validation (กันใช้สลิปเก่า)
 *   5) Receiver validation (กันโอนผิดบัญชี)
 *
 * ถ้าไม่มี API key → mock mode (auto-approve เพื่อทดสอบ)
 *   → ใน production (NODE_ENV=production) จะปฏิเสธไม่ให้ใช้ mock mode
 */
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SLIPOK_API_KEY = process.env.SLIPOK_API_KEY || '';
const SLIPOK_BRANCH_ID = process.env.SLIPOK_BRANCH_ID || '';
const PROMPTPAY_ID = process.env.PROMPTPAY_ID || '';
const MOCK_VERIFY = !SLIPOK_API_KEY;
const IS_PROD = process.env.NODE_ENV === 'production';

// Time-window (minutes) that a slip may be submitted relative to order creation
const SLIP_TIME_WINDOW_BEFORE_MIN = 5;   // slip transDate ต้องไม่เก่ากว่า order -5 นาที
const SLIP_TIME_WINDOW_AFTER_MIN = 60;   // slip ต้องไม่เกิน +60 นาทีหลัง order (เผื่อ admin review delay)
const SLIP_AMOUNT_TOLERANCE = 0.5;       // ±0.5 บาท

if (MOCK_VERIFY && IS_PROD) {
  console.error('[slip-verify] FATAL: SLIPOK_API_KEY is required in production. Refusing to start.');
  process.exit(1);
}

/**
 * Compute SHA-256 hash of a file
 */
function hashFile(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Verify a slip image with full anti-fraud pipeline.
 * @param {string} slipFilePath - path to slip image
 * @param {number} expectedAmount - expected payment amount
 * @param {object} opts
 *   - orderCreatedAt: ISO / 'YYYY-MM-DD HH:mm:ss' string of order creation
 *   - checkDuplicate: async fn({hash, qrRef}) => {duplicate: bool, reason: str}
 * @returns {{verified, amount, sender, receiver, ref, transDate, raw, reason, slip_hash}}
 */
async function verifySlip(slipFilePath, expectedAmount, opts = {}) {
  // 1) Compute image hash (regardless of verify mode)
  let slip_hash = '';
  try { slip_hash = hashFile(slipFilePath); } catch (e) { /* best-effort */ }

  // 2) Duplicate image hash check (before hitting SlipOK — save API quota)
  if (opts.checkDuplicate && slip_hash) {
    const dup = await opts.checkDuplicate({ hash: slip_hash, qrRef: null });
    if (dup && dup.duplicate) {
      return {
        verified: false,
        reason: dup.reason || 'ภาพสลิปนี้เคยถูกใช้แล้ว',
        slip_hash,
      };
    }
  }

  // 3) Run QR verification (SlipOK or mock)
  const core = MOCK_VERIFY
    ? mockVerify(expectedAmount)
    : await slipOKVerify(slipFilePath, expectedAmount);
  core.slip_hash = slip_hash;

  // If QR verify already failed, stop here (skip further checks to avoid double-faulting)
  if (!core.verified) return core;

  // 4) Duplicate qr_ref check (after we know the real ref)
  if (opts.checkDuplicate && core.ref) {
    const dup = await opts.checkDuplicate({ hash: slip_hash, qrRef: core.ref });
    if (dup && dup.duplicate) {
      return {
        ...core,
        verified: false,
        reason: dup.reason || `สลิปนี้ (ref: ${core.ref}) ถูกใช้แล้ว`,
      };
    }
  }

  // 5) Time-window validation
  if (opts.orderCreatedAt && core.transDate) {
    const tw = checkTimeWindow(core.transDate, opts.orderCreatedAt);
    if (!tw.ok) {
      return { ...core, verified: false, reason: tw.reason };
    }
  }

  return core;
}

function checkTimeWindow(slipTransDate, orderCreatedAt) {
  const slipMs = new Date(slipTransDate).getTime();
  const orderMs = new Date(orderCreatedAt).getTime();
  if (isNaN(slipMs) || isNaN(orderMs)) return { ok: true }; // can't validate → skip
  const minBefore = orderMs - SLIP_TIME_WINDOW_BEFORE_MIN * 60 * 1000;
  const maxAfter = orderMs + SLIP_TIME_WINDOW_AFTER_MIN * 60 * 1000;
  if (slipMs < minBefore) {
    return { ok: false, reason: `สลิปเก่ากว่า order (โอนก่อนสร้าง order เกิน ${SLIP_TIME_WINDOW_BEFORE_MIN} นาที — อาจใช้สลิปเก่า)` };
  }
  if (slipMs > maxAfter) {
    return { ok: false, reason: `วันที่บนสลิปไม่สมเหตุสมผล (โอนหลังสร้าง order เกิน ${SLIP_TIME_WINDOW_AFTER_MIN} นาที)` };
  }
  return { ok: true };
}

// ─── SlipOK API ───
async function slipOKVerify(slipFilePath, expectedAmount) {
  try {
    const absPath = slipFilePath.startsWith('/')
      ? path.join(__dirname, slipFilePath)
      : slipFilePath;

    // SlipOK v1 API
    const url = SLIPOK_BRANCH_ID
      ? `https://api.slipok.com/api/line/apikey/${SLIPOK_BRANCH_ID}`
      : 'https://api.slipok.com/api/line/apikey/0';

    const formData = new (require('form-data'))();
    formData.append('files', fs.createReadStream(absPath));

    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'x-authorization': SLIPOK_API_KEY,
        ...formData.getHeaders(),
      },
      body: formData,
    });

    if (!r.ok) {
      const txt = await r.text();
      return { verified: false, reason: `SlipOK API error: ${r.status} ${txt}` };
    }

    const data = await r.json();
    if (!data.success) {
      return { verified: false, reason: data.message || 'SlipOK: slip unreadable' };
    }

    const slip = data.data;
    const slipAmount = parseFloat(slip.amount) || 0;
    const receiverName = slip.receiver?.displayName || '';
    const receiverProxy = slip.receiver?.proxy?.value || '';

    // Validate amount (allow ±0.5 baht tolerance)
    const amountMatch = Math.abs(slipAmount - expectedAmount) < SLIP_AMOUNT_TOLERANCE;

    // Validate receiver (check PromptPay ID if configured)
    let receiverMatch = true;
    if (PROMPTPAY_ID && receiverProxy) {
      const cleanProxy = receiverProxy.replace(/[- ]/g, '');
      const cleanExpected = PROMPTPAY_ID.replace(/[- ]/g, '');
      receiverMatch = cleanProxy.includes(cleanExpected) || cleanExpected.includes(cleanProxy);
    }

    const verified = amountMatch && receiverMatch;
    let reason = '';
    if (!amountMatch) reason = `ยอดไม่ตรง: สลิป ฿${slipAmount} ≠ คำสั่งซื้อ ฿${expectedAmount}`;
    if (!receiverMatch) reason += (reason ? ' | ' : '') + 'ผู้รับเงินไม่ตรง';

    return {
      verified,
      amount: slipAmount,
      sender: slip.sender?.displayName || '',
      receiver: receiverName,
      ref: slip.transRef || '',
      transDate: slip.transDate || '',
      reason: reason || (verified ? 'ตรวจสอบผ่าน' : 'ไม่ผ่านการตรวจสอบ'),
      raw: slip,
    };
  } catch (e) {
    return { verified: false, reason: `SlipOK error: ${e.message}` };
  }
}

// ─── Mock Mode (dev only) ───
function mockVerify(expectedAmount) {
  console.log(`[slip-verify] MOCK: auto-approve ฿${expectedAmount}`);
  return {
    verified: true,
    amount: expectedAmount,
    sender: 'FC Branch (Mock)',
    receiver: 'JC Group (Mock)',
    // Random ref so each mock slip gets a unique qr_ref (duplicate test still works)
    ref: 'MOCK-' + crypto.randomBytes(8).toString('hex').toUpperCase(),
    transDate: new Date().toISOString(),
    reason: 'Mock auto-verify (ยังไม่มี SlipOK API Key)',
    raw: null,
  };
}

module.exports = { verifySlip, hashFile, MOCK_VERIFY };
