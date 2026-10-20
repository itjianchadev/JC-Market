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
 *
 * QR_DEMO=1 overrides both: the QR encodes plain text (not an EMVCo payload),
 * so banking apps refuse it, and a red DEMO badge is drawn over the centre.
 * For the demo site only — it looks like a payment QR but can never move money.
 * Ignored when BC_ENVIRONMENT is Production (same default as bc-client.js), so
 * a stray QR_DEMO=1 on the production server still serves the real QR.
 */
const generatePayload = require('promptpay-qr');
const QRCode = require('qrcode');

const PROMPTPAY_ID = process.env.PROMPTPAY_ID || '0000000000'; // เบอร์/เลขนิติบุคคล
const STATIC_PAYLOAD = (process.env.PROMPTPAY_QR_PAYLOAD || '').trim();
const BC_ENVIRONMENT = process.env.BC_ENVIRONMENT || 'Production';
const IS_PRODUCTION = BC_ENVIRONMENT.trim().toLowerCase() === 'production';
const QR_DEMO = process.env.QR_DEMO === '1' && !IS_PRODUCTION;
if (process.env.QR_DEMO === '1' && IS_PRODUCTION) {
  console.warn('[QR] QR_DEMO=1 ignored: BC_ENVIRONMENT is Production, serving the real payment QR');
}

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

// Non-payable QR for the demo site. Error correction H tolerates the badge
// covering the centre modules, so the text still decodes when scanned.
async function generateDemoQR(amount) {
  const amt = Number(amount);
  const text = `JC-MARKET DEMO - NOT A PAYMENT QR - THB ${Number.isFinite(amt) ? amt.toFixed(2) : '-'}`;
  const svg = await QRCode.toString(text, {
    type: 'svg',
    errorCorrectionLevel: 'H',
    width: 400,
    margin: 2,
    color: { dark: '#000', light: '#fff' },
  });
  const size = Number((svg.match(/viewBox="0 0 (\d+) \d+"/) || [])[1]) || 33;
  const w = size * 0.42, h = size * 0.16;
  const badge = `<rect x="${(size - w) / 2}" y="${(size - h) / 2}" width="${w}" height="${h}" rx="${h * 0.2}" fill="#b3261e" stroke="#fff" stroke-width="${h * 0.08}"/>`
    + `<text x="${size / 2}" y="${size / 2}" fill="#fff" font-family="Arial, sans-serif" font-weight="700" font-size="${h * 0.62}" text-anchor="middle" dominant-baseline="central">DEMO</text>`;
  const out = svg.replace('</svg>', badge + '</svg>');
  return 'data:image/svg+xml;base64,' + Buffer.from(out).toString('base64');
}

async function generateQR(amount) {
  if (QR_DEMO) return generateDemoQR(amount);
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
