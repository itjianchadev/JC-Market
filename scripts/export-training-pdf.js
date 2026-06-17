// Render each markdown training doc into a PDF, plus a combined master PDF.
// Markdown → HTML (marked) → PDF (Playwright/Chromium).
//
// Run: node scripts/export-training-pdf.js
// Output: docs/training/pdf/{name}.pdf  +  docs/training/pdf/all-training.pdf
//
// Uses the Playwright install in the sibling FoodStory project — same as
// scripts/capture-training-screenshots.js — so we don't need to install a
// second copy of Chromium.

const path = require('path');
const fs = require('fs');
const { marked } = require('marked');
const { chromium } = require('/Users/jiancha/AgenAi_Jiancha/FoodStory/node_modules/playwright');

const TRAINING_DIR = path.join(__dirname, '..', 'docs', 'training');
const OUT_DIR = path.join(TRAINING_DIR, 'pdf');
fs.mkdirSync(OUT_DIR, { recursive: true });

const DOCS = [
  { md: 'README.md',           pdf: '00-index.pdf',         title: 'JC-Market Training — สารบัญ' },
  { md: 'jf-branch-owner.md',  pdf: '01-jf-branch-owner.pdf', title: 'คู่มือ FC (สาขาแฟรนไชส์)' },
  { md: 'jc-master.md',        pdf: '02-jc-master.pdf',     title: 'คู่มือ JC (สาขา Master)' },
  { md: 'finance.md',          pdf: '03-finance.pdf',       title: 'คู่มือ Finance' },
  { md: 'it-admin.md',         pdf: '04-it-admin.pdf',      title: 'คู่มือ IT / Admin' },
  { md: 'tms-cti.md',          pdf: '05-tms-cti.pdf',       title: 'คู่มือ TMS — คลัง CTI' },
  { md: 'tms-transport.md',    pdf: '06-tms-transport.pdf', title: 'คู่มือ TMS — ขนส่ง (คนขับ)' },
];

// Inline images as data URIs so the rendered HTML works from any base URL.
function inlineImages(html, mdDir) {
  return html.replace(/<img\s+([^>]*?)src="([^"]+)"([^>]*)>/g, (m, pre, src, post) => {
    if (src.startsWith('data:') || src.startsWith('http')) return m;
    const filePath = path.resolve(mdDir, src);
    if (!fs.existsSync(filePath)) {
      console.warn('  ⚠️ image not found:', src);
      return m;
    }
    const buf = fs.readFileSync(filePath);
    const ext = path.extname(src).slice(1).toLowerCase() || 'png';
    const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    return `<img ${pre}src="data:${mime};base64,${buf.toString('base64')}"${post}>`;
  });
}

function buildHtml(title, bodyHtml) {
  return `<!doctype html>
<html lang="th"><head>
<meta charset="utf-8">
<title>${title}</title>
<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box}
  body{font-family:'Sarabun',sans-serif;color:#2a2118;line-height:1.6;font-size:14px;padding:48px 56px;max-width:900px;margin:0 auto}
  h1{font-size:26px;color:#8a7d66;border-bottom:2px solid #AD9C82;padding-bottom:8px;margin-bottom:18px}
  h2{font-size:20px;color:#2a2118;margin-top:28px;margin-bottom:12px;border-bottom:1px solid #ebe6dd;padding-bottom:6px}
  h3{font-size:16px;color:#8a7d66;margin-top:20px;margin-bottom:8px}
  p,li{margin-bottom:8px}
  ul,ol{padding-left:24px;margin-bottom:12px}
  code{background:#f5efe5;padding:2px 6px;border-radius:4px;font-family:'Menlo','Consolas',monospace;font-size:13px;color:#2a2118}
  pre{background:#f5efe5;padding:12px;border-radius:8px;overflow:auto;margin:12px 0;font-size:12px}
  pre code{background:transparent;padding:0}
  blockquote{border-left:4px solid #AD9C82;background:#fafaf8;padding:10px 16px;margin:12px 0;color:#525252}
  table{border-collapse:collapse;width:100%;margin:12px 0;font-size:13px}
  th,td{border:1px solid #ebe6dd;padding:8px 10px;text-align:left}
  th{background:#f5efe5;color:#8a7d66;font-weight:600}
  img{max-width:100%;border:1px solid #ebe6dd;border-radius:8px;margin:8px 0;box-shadow:0 1px 4px rgba(42,33,24,.08);page-break-inside:avoid}
  a{color:#8a7d66}
  hr{border:none;border-top:1px solid #ebe6dd;margin:24px 0}
  strong{color:#2a2118}
  @page{margin:18mm 14mm;size:A4}
</style>
</head>
<body>
${bodyHtml}
</body></html>`;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const combinedSections = [];

  for (const doc of DOCS) {
    const mdPath = path.join(TRAINING_DIR, doc.md);
    const md = fs.readFileSync(mdPath, 'utf8');
    let bodyHtml = marked.parse(md);
    bodyHtml = inlineImages(bodyHtml, path.dirname(mdPath));

    // Per-file PDF
    const html = buildHtml(doc.title, bodyHtml);
    await page.setContent(html, { waitUntil: 'networkidle' });
    const outFile = path.join(OUT_DIR, doc.pdf);
    await page.pdf({ path: outFile, format: 'A4', printBackground: true });
    console.log(`  📄 ${doc.pdf}`);

    combinedSections.push(`<section style="page-break-after:always">${bodyHtml}</section>`);
  }

  // Combined PDF
  const combinedHtml = buildHtml('JC-Market Training — รวมทั้งหมด', combinedSections.join('\n'));
  await page.setContent(combinedHtml, { waitUntil: 'networkidle' });
  const combinedFile = path.join(OUT_DIR, 'all-training.pdf');
  await page.pdf({ path: combinedFile, format: 'A4', printBackground: true });
  console.log(`  📄 all-training.pdf  (combined)`);

  await browser.close();
  console.log(`\n✅ Done — PDFs under ${path.relative(process.cwd(), OUT_DIR)}/`);
})().catch(e => { console.error('❌', e.message); console.error(e.stack); process.exit(1); });
