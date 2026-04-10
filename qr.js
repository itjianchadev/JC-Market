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

module.exports = { generateQR };
