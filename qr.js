/**
 * PromptPay / Thai-QR Payment Generator
 * สร้าง QR ชำระเงินตามยอดของแต่ละ order
 *
 * Two modes:
 *  1. PROMPTPAY_QR_PAYLOAD set — the merchant's real static Thai-QR payload
 *     (e.g. the KShop / KBank bill-payment QR decoded from the printed slip).
 *     We keep every merchant field (Biller ID, Ref1/Ref2) byte-for-byte and
 *     only turn it dynamic: Point-of-Initiation 11→12, insert the amount
 *     (tag 54), recompute the CRC (tag 63). Money lands in the exact same
 *     account as the static QR.
 *  2. Fallback — generate a plain PromptPay (tag 29) QR from PROMPTPAY_ID.
 *     Used only when PROMPTPAY_QR_PAYLOAD is not configured.
 */
const generatePayload = require('promptpay-qr');
const QRCode = require('qrcode');

const PROMPTPAY_ID = process.env.PROMPTPAY_ID || '0000000000'; // เบอร์/เลขนิติบุคคล
const STATIC_PAYLOAD = (process.env.PROMPTPAY_QR_PAYLOAD || '').trim();

// CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) — the EMVCo QR checksum.
function crc16(s) {
  let c = 0xffff;
  for (let i = 0; i < s.length; i++) {
    c ^= s.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) c = (c & 0x8000 ? (c << 1) ^ 0x1021 : c << 1) & 0xffff;
  }
  return c.toString(16).toUpperCase().padStart(4, '0');
}

// Turn a static EMVCo payload into a dynamic one carrying `amount` (THB).
// Preserves all merchant tags; only rewrites 01 (dynamic), 54 (amount), 63 (CRC).
function injectAmount(base, amount) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error(`invalid QR amount: ${amount}`);

  const tags = {};
  for (let i = 0; i < base.length; ) {
    const t = base.slice(i, i + 2);
    const l = parseInt(base.slice(i + 2, i + 4), 10);
    tags[t] = base.slice(i + 4, i + 4 + l);
    i += 4 + l;
  }
  tags['01'] = '12';            // Point of Initiation → dynamic (one-time)
  tags['54'] = amt.toFixed(2);  // Transaction Amount
  delete tags['63'];            // CRC re-added last

  // EMVCo tags in ascending numeric order; 2-char keys sort lexicographically.
  const body = Object.keys(tags).sort()
    .map((t) => t + String(tags[t].length).padStart(2, '0') + tags[t])
    .join('') + '6304';
  return body + crc16(body);
}

async function generateQR(amount) {
  const payload = STATIC_PAYLOAD
    ? injectAmount(STATIC_PAYLOAD, amount)
    : generatePayload(PROMPTPAY_ID, { amount });
  return QRCode.toDataURL(payload, {
    width: 400,
    margin: 2,
    color: { dark: '#000', light: '#fff' },
  });
}

// Generic QR for any text/URL (e.g. the driver-app link printed on the trip
// manifest). Tighter margin than the payment QR.
async function generateTextQR(text) {
  return QRCode.toDataURL(text, {
    width: 240,
    margin: 1,
    color: { dark: '#000', light: '#fff' },
  });
}

module.exports = { generateQR, generateTextQR, injectAmount };
