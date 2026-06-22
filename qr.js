/**
 * PromptPay QR Generator
 * สร้าง QR Code สำหรับชำระเงินผ่าน PromptPay
 */
const generatePayload = require('promptpay-qr');
const QRCode = require('qrcode');

const PROMPTPAY_ID = process.env.PROMPTPAY_ID || '0000000000'; // เบอร์/เลขนิติบุคคล

async function generateQR(amount) {
  const payload = generatePayload(PROMPTPAY_ID, { amount });
  const dataUrl = await QRCode.toDataURL(payload, {
    width: 400,
    margin: 2,
    color: { dark: '#000', light: '#fff' },
  });
  return dataUrl;
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

module.exports = { generateQR, generateTextQR };
