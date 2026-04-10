/**
 * Slip Auto-Verification Service
 *
 * ใช้ SlipOK API (https://slipok.com) อ่าน QR บนสลิปธนาคาร
 * ตรวจสอบ: ยอดเงิน, ผู้รับ, วันเวลา
 *
 * ถ้าไม่มี API key → mock mode (auto-approve เพื่อทดสอบ)
 */
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const SLIPOK_API_KEY = process.env.SLIPOK_API_KEY || '';
const SLIPOK_BRANCH_ID = process.env.SLIPOK_BRANCH_ID || '';
const PROMPTPAY_ID = process.env.PROMPTPAY_ID || '';
const MOCK_VERIFY = !SLIPOK_API_KEY;

/**
 * Verify a slip image
 * @param {string} slipFilePath - path to slip image
 * @param {number} expectedAmount - expected payment amount
 * @returns {{ verified, amount, sender, receiver, ref, transDate, raw, reason }}
 */
async function verifySlip(slipFilePath, expectedAmount) {
  if (MOCK_VERIFY) {
    return mockVerify(expectedAmount);
  }
  return slipOKVerify(slipFilePath, expectedAmount);
}

// ─── SlipOK API ───
async function slipOKVerify(slipFilePath, expectedAmount) {
  try {
    const absPath = slipFilePath.startsWith('/')
      ? path.join(__dirname, slipFilePath)
      : slipFilePath;

    // Read file and create form data
    const FormData = (await import('node-fetch')).FormData || global.FormData;
    const fileBuffer = fs.readFileSync(absPath);
    const blob = new (require('node-fetch').Blob || Blob)([fileBuffer]);

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
    const amountMatch = Math.abs(slipAmount - expectedAmount) < 0.5;

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

// ─── Mock Mode ───
function mockVerify(expectedAmount) {
  console.log(`[slip-verify] MOCK: auto-approve ฿${expectedAmount}`);
  return {
    verified: true,
    amount: expectedAmount,
    sender: 'FC Branch (Mock)',
    receiver: 'JC Group (Mock)',
    ref: 'MOCK-' + Date.now(),
    transDate: new Date().toISOString(),
    reason: 'Mock auto-verify (ยังไม่มี SlipOK API Key)',
    raw: null,
  };
}

module.exports = { verifySlip, MOCK_VERIFY };
