/**
 * D365 Business Central API Client (OAuth2 Client Credentials)
 * Falls back to mock mode when USE_MOCK_BC=1 or creds missing.
 */
const fetch = require('node-fetch');

const {
  BC_TENANT_ID, BC_CLIENT_ID, BC_CLIENT_SECRET,
  BC_ENVIRONMENT = 'Production', BC_COMPANY_ID, BC_COMPANY_NAME,
  BC_API_BASE = 'https://api.businesscentral.dynamics.com/v2.0',
  USE_MOCK_BC,
} = process.env;

const MOCK = USE_MOCK_BC === '1' || !BC_TENANT_ID || !BC_CLIENT_ID || !BC_CLIENT_SECRET;

let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
  if (MOCK) return 'MOCK_TOKEN';
  if (cachedToken && Date.now() < tokenExpiry - 60_000) return cachedToken;
  const url = `https://login.microsoftonline.com/${BC_TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: BC_CLIENT_ID,
    client_secret: BC_CLIENT_SECRET,
    scope: 'https://api.businesscentral.dynamics.com/.default',
  });
  const r = await fetch(url, { method: 'POST', body });
  if (!r.ok) throw new Error(`BC token failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  cachedToken = j.access_token;
  tokenExpiry = Date.now() + (j.expires_in * 1000);
  return cachedToken;
}

function baseUrl() {
  return `${BC_API_BASE}/${BC_TENANT_ID}/${BC_ENVIRONMENT}/api/v2.0/companies(${BC_COMPANY_ID})`;
}

async function bcFetch(path, opts = {}) {
  const token = await getToken();
  const r = await fetch(`${baseUrl()}${path}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`BC ${path} → ${r.status}: ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

// Fetch ALL pages of an API v2.0 list endpoint by following @odata.nextLink.
// A single GET with an explicit $top caps the response — /items returned only
// the first 1000 records and silently dropped the rest on larger catalogs.
async function bcFetchAll(path) {
  const token = await getToken();
  let url = `${baseUrl()}${path}`;
  const all = [];
  for (let guard = 0; url && guard < 100; guard++) {
    const r = await fetch(url, { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } });
    if (!r.ok) throw new Error(`BC ${path} (page ${guard}) → ${r.status}: ${await r.text()}`);
    const j = await r.json();
    if (Array.isArray(j.value)) all.push(...j.value);
    url = j['@odata.nextLink'] || null;
  }
  return { value: all };
}

// ─── Items ───
async function listItems() {
  if (MOCK) return { mock: true, value: [] };
  return bcFetchAll('/items');   // paginated — ALL items, not just the first 1000
}

// ─── Item Categories ───
async function listItemCategories() {
  if (MOCK) return { mock: true, value: [] };
  return bcFetch('/itemCategories');
}

// ─── Item Card (OData V4) — ดึง field ที่ /api/v2.0/items ไม่ expose เช่น Purch. UoM ───
function odataBase() {
  if (!BC_COMPANY_NAME) throw new Error('BC_COMPANY_NAME env var required for OData');
  return `${BC_API_BASE}/${BC_TENANT_ID}/${BC_ENVIRONMENT}/ODataV4/Company('${encodeURIComponent(BC_COMPANY_NAME)}')`;
}

async function odataGet(path) {
  const token = await getToken();
  const r = await fetch(`${odataBase()}${path}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
  });
  if (!r.ok) throw new Error(`BC OData ${path} → ${r.status}: ${await r.text()}`);
  return r.json();
}

async function listItemCards() {
  if (MOCK) return { mock: true, value: [] };
  return odataGet(`/ItemCard?$select=No,Description,Base_Unit_of_Measure,Sales_Unit_of_Measure,Purch_Unit_of_Measure&$top=5000`);
}

// ─── Sales Prices (Classic, Page 7002) ───
// NOTE: Page 7002 มี default view filter ที่ซ่อน records — ต้องใส่ explicit $filter ถึงจะเห็นทุก row
async function listSalesPrices() {
  if (MOCK) return { mock: true, value: [] };
  return odataGet(`/SalesPrice?$filter=Item_No ne ''&$select=Item_No,Sales_Type,Sales_Code,Unit_of_Measure_Code,Minimum_Quantity,Unit_Price,Starting_Date,Ending_Date&$top=10000`);
}

// ─── Item Units of Measure (Page 5404) — qty per base UoM สำหรับแปลงหน่วย ───
async function listItemUnitsOfMeasure() {
  if (MOCK) return { mock: true, value: [] };
  return odataGet(`/ItemUnitOfMeasure?$select=Item_No,Code,Qty_per_Unit_of_Measure&$top=10000`);
}

// ─── Sale Billing (SB) — Exsys Localize Billing ext, table 70332 "Billing Header".
// Read-only: a consolidated bill per customer (Bill_to_Customer_No) whose lines are
// the posted Sales Invoices (SIV-) and Credit Memos (SCN-, negative). Branches view
// these in JC-Market and pay; accounting applies the payment in BC and each line's
// Remaining_Amount drops to 0. The header carries no total — it's sum(line Amount).
// Returns a normalized array (header fields + computed total/remaining/paid + lines).
async function getSalesBillings(customerNo, billNo) {
  if (MOCK) return [];
  const LINES = 'Posted_Sales_Billing_ExcelControl1000000015';
  let path = `/Posted_Sales_Billing_Excel?$expand=${LINES}`;
  const esc = v => String(v).replace(/'/g, "''"); // OData quote-escape
  const filters = [];
  if (customerNo) filters.push(`Bill_to_Customer_No eq '${esc(customerNo)}'`);
  if (billNo) filters.push(`No eq '${esc(billNo)}'`);
  if (filters.length) path += `&$filter=${filters.join(' and ')}`;
  const round2 = n => Math.round((n || 0) * 100) / 100;
  const j = await odataGet(path);
  return (j.value || []).map(sb => {
    const lines = (sb[LINES] || []).map(l => ({
      doc_type: l.Document_Type,            // Invoice | Credit Memo
      doc_no: l.Document_No,                // SIV-… / SCN-…
      invoice_date: l.Invoice_Date,
      description: l.Description || '',
      amount: round2(l.Amount),
      remaining: round2(l.Remaining_Amount),
    }));
    const total = round2(lines.reduce((s, l) => s + l.amount, 0));
    const remaining = round2(lines.reduce((s, l) => s + l.remaining, 0));
    return {
      no: sb.No,
      bill_type: sb.Bill_Type,
      customer_no: sb.Bill_to_Customer_No,
      document_date: sb.Document_Date,
      due_date: sb.Due_Date,
      status: sb.Status,
      remark: sb.Remark || '',
      total,
      remaining,
      paid: Math.abs(remaining) < 0.005,
      lines,
    };
  });
}

// ─── Transfer Orders (Page 5740) — JC master outlets receive general goods
// from CTI via Transfer Orders (no Sales Order, no payment). Service names
// live in env vars so the user can fix typos in BC's "Web Services" page
// without touching code (e.g. the published name today is "Transfer0rder"
// with a zero where an O should be).
const TO_HEADER_SVC = process.env.BC_WS_TRANSFER_ORDER || 'TransferOrder';
const TO_LINE_SVC = process.env.BC_WS_TRANSFER_ORDER_LINE || 'TransferOrderLine';

async function createTransferOrder(payload) {
  if (MOCK) return { mock: true, No: 'TRO-MOCK-' + Date.now() };
  const tok = await getToken();
  const r = await fetch(`${odataBase()}/${TO_HEADER_SVC}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`BC POST /${TO_HEADER_SVC} → ${r.status}: ${(await r.text()).slice(0, 500)}`);
  return r.json();
}

async function addTransferOrderLine(payload) {
  if (MOCK) return { mock: true, Line_No: payload.Line_No };
  const tok = await getToken();
  const r = await fetch(`${odataBase()}/${TO_LINE_SVC}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`BC POST /${TO_LINE_SVC} → ${r.status}: ${(await r.text()).slice(0, 500)}`);
  return r.json();
}

// ─── Sales Order ───
async function createSalesOrder(payload) {
  if (MOCK) return { mock: true, id: 'MOCK-SO-' + Date.now(), number: 'SO-MOCK-' + Date.now() };
  return bcFetch('/salesOrders', { method: 'POST', body: JSON.stringify(payload) });
}

async function getSalesOrder(orderId) {
  if (MOCK) return { mock: true, totalAmountExcludingTax: 0, totalTaxAmount: 0, totalAmountIncludingTax: 0 };
  return bcFetch(`/salesOrders(${orderId})`);
}

async function addSalesOrderLine(orderId, line) {
  if (MOCK) return { mock: true };
  return bcFetch(`/salesOrders(${orderId})/salesOrderLines`, {
    method: 'POST', body: JSON.stringify(line),
  });
}

// Post the SO with both shipment and invoice in one go. BC's bound action only
// posts the per-line shipQuantity / invoiceQuantity values, which default to 0
// — so we PATCH each line to set them to whatever's still outstanding before
// calling shipAndInvoice. Returns 204 No Content on success; the resulting
// Posted Sales Invoice has to be looked up via findPostedInvoiceByExternalDoc.
async function shipAndInvoiceSalesOrder(orderId) {
  if (MOCK) return { mock: true, posted: true };
  const token = await getToken();
  const base = baseUrl();
  const authHeaders = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' };

  // Pull lines + etags
  const linesRes = await fetch(`${base}/salesOrders(${orderId})/salesOrderLines`, { headers: authHeaders });
  if (!linesRes.ok) throw new Error(`BC fetch SO lines → ${linesRes.status}: ${await linesRes.text()}`);
  const lines = (await linesRes.json()).value || [];

  // Set shipQuantity + invoiceQuantity = remaining qty per line
  for (const l of lines) {
    if (l.lineType !== 'Item' && l.lineType !== 'G/L Account') continue;
    const remaining = (l.quantity || 0) - (l.shippedQuantity || 0);
    if (remaining <= 0) continue;
    const r = await fetch(`${base}/salesOrders(${orderId})/salesOrderLines(${l.id})`, {
      method: 'PATCH',
      headers: { ...authHeaders, 'If-Match': l['@odata.etag'] },
      body: JSON.stringify({ shipQuantity: remaining, invoiceQuantity: remaining }),
    });
    if (!r.ok) throw new Error(`BC PATCH SO line ${l.id} → ${r.status}: ${await r.text()}`);
  }

  // Now post
  const r = await fetch(`${base}/salesOrders(${orderId})/Microsoft.NAV.shipAndInvoice`, {
    method: 'POST', headers: authHeaders, body: '{}',
  });
  if (!r.ok && r.status !== 204) throw new Error(`BC shipAndInvoice → ${r.status}: ${await r.text()}`);
  return { ok: true };
}

// Look up the Posted Sales Invoice that was created by shipAndInvoice. The action
// itself returns no body, so we re-query by externalDocumentNumber to grab the
// resulting invoice number for our records.
async function findPostedInvoiceByExternalDoc(externalDocNumber) {
  if (MOCK) return { mock: true, value: [] };
  const enc = encodeURIComponent(externalDocNumber);
  return bcFetch(`/salesInvoices?$filter=externalDocumentNumber eq '${enc}' and status eq 'Open'&$top=1`);
}

// ─── Sales Invoice (kept for future use after SO posted) ───
async function createSalesInvoice(payload) {
  if (MOCK) return { mock: true, id: 'MOCK-INV-' + Date.now(), number: 'SI-MOCK-' + Date.now() };
  return bcFetch('/salesInvoices', { method: 'POST', body: JSON.stringify(payload) });
}

async function addInvoiceLine(invoiceId, line) {
  if (MOCK) return { mock: true };
  return bcFetch(`/salesInvoices(${invoiceId})/salesInvoiceLines`, {
    method: 'POST', body: JSON.stringify(line),
  });
}

async function postInvoice(invoiceId) {
  if (MOCK) return { mock: true, posted: true };
  return bcFetch(`/salesInvoices(${invoiceId})/Microsoft.NAV.post`, { method: 'POST' });
}

// Drop a Sales Invoice that hasn't been posted yet — used to clean up the
// orphan draft we leave behind when post fails midway.
async function deleteSalesInvoice(invoiceId) {
  if (MOCK) return { mock: true };
  const token = await getToken();
  const r = await fetch(`${baseUrl()}/salesInvoices(${invoiceId})`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!r.ok && r.status !== 204) throw new Error(`BC DELETE invoice → ${r.status}: ${await r.text()}`);
  return { ok: true };
}

// Drop the Sales Order in BC after a separate Posted Sales Invoice has captured
// the transaction — keeps "Open Sales Orders" clean and frees inventory reserves.
// node-fetch's parser chokes on BC's DELETE response ("Parse Error: Expected
// HTTP/, RTSP/ or ICE/"); global fetch (undici) handles it cleanly. `If-Match: *`
// skips etag matching since we don't keep one cached here.
async function deleteSalesOrder(orderId) {
  if (MOCK) return { mock: true };
  const token = await getToken();
  const r = await globalThis.fetch(`${baseUrl()}/salesOrders(${orderId})`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
      'If-Match': '*',
    },
  });
  if (!r.ok && r.status !== 204) throw new Error(`BC DELETE SO → ${r.status}: ${await r.text()}`);
  return { ok: true };
}

// ─── Vendors ───
async function listVendors() {
  if (MOCK) return { mock: true, value: [] };
  return bcFetch('/vendors?$top=500');
}

// ─── Locations ───
// In-memory code → id cache. Locations rarely change so we lookup-then-cache
// indefinitely for the process lifetime. Lets PO creation stamp the branch's
// Location Code without an extra round trip on every order.
const _locCache = new Map();
async function findLocationIdByCode(code) {
  if (!code) return null;
  if (MOCK) return null;
  if (_locCache.has(code)) return _locCache.get(code);
  const enc = encodeURIComponent(code);
  const j = await bcFetch(`/locations?$filter=code eq '${enc}'&$select=id,code&$top=1`);
  const id = (j.value && j.value[0] && j.value[0].id) || null;
  _locCache.set(code, id);
  return id;
}

// ─── G/L Accounts ───
// Resolve a G/L Account number (e.g. 'SV-TP0001') to its BC id (GUID) so we can
// stamp freight lines onto sales/purchase orders via lineType:'Account'. Cached
// for the process lifetime like locations — the chart of accounts is static.
const _glCache = new Map();
async function findGLAccountIdByNo(no) {
  if (!no) return null;
  if (MOCK) return null;
  if (_glCache.has(no)) return _glCache.get(no);
  const enc = encodeURIComponent(no);
  const j = await bcFetch(`/accounts?$filter=number eq '${enc}'&$select=id,number&$top=1`);
  const id = (j.value && j.value[0] && j.value[0].id) || null;
  _glCache.set(no, id);
  return id;
}

// ─── Purchase Order ───
async function createPurchaseOrder(payload) {
  if (MOCK) return { mock: true, id: 'MOCK-PO-' + Date.now(), number: 'PO-MOCK-' + Date.now() };
  return bcFetch('/purchaseOrders', { method: 'POST', body: JSON.stringify(payload) });
}

async function getPurchaseOrder(poId) {
  if (MOCK) return { mock: true, totalAmountExcludingTax: 0, totalTaxAmount: 0, totalAmountIncludingTax: 0 };
  return bcFetch(`/purchaseOrders(${poId})`);
}

async function addPurchaseOrderLine(poId, line) {
  if (MOCK) return { mock: true, id: 'MOCK-POL-' + Date.now(), '@odata.etag': 'mock' };
  return bcFetch(`/purchaseOrders(${poId})/purchaseOrderLines`, {
    method: 'POST', body: JSON.stringify(line),
  });
}

async function patchPurchaseOrderLine(poId, lineId, etag, patch) {
  if (MOCK) return { mock: true };
  const token = await getToken();
  const url = `${baseUrl()}/purchaseOrders(${poId})/purchaseOrderLines(${lineId})`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'If-Match': etag,
    },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`BC PATCH POLine → ${r.status}: ${await r.text()}`);
  return r.json();
}

// ─── Purchase Order Lines ───
async function getPurchaseOrderLines(poId) {
  if (MOCK) return { mock: true, value: [] };
  return bcFetch(`/purchaseOrders(${poId})/purchaseOrderLines`);
}

// ─── Document Dimensions ───
// Stamp a Dimension onto a document header (e.g. DEPARTMENT = branch code).
// entity = 'salesOrders' | 'purchaseOrders'. BC rejects an unknown valueCode,
// so callers guard (try/catch) — a missing Department value must NOT block the
// document. POSTing the same code twice also errors; only stamp once, right
// after the doc is created.
async function setDocumentDimension(entity, docId, code, valueCode) {
  if (MOCK) return { mock: true };
  return bcFetch(`/${entity}(${docId})/dimensionSetLines`, {
    method: 'POST', body: JSON.stringify({ code, valueCode }),
  });
}

// ─── Purchase Receipts (Posted) ───
async function listPurchaseReceipts(orderNumber) {
  if (MOCK) return { mock: true, value: [] };
  return bcFetch(`/purchaseReceipts?$filter=orderNumber eq '${orderNumber}'&$expand=purchaseReceiptLines`);
}

// Post a partial receive on a PO.
// `lineQtyMap`: { [bcPoLineId]: receiveQuantity } — qty to receive on each line
//   (any line not in the map gets 0 so it isn't touched this round).
// BC v2.0 exposes only Microsoft.NAV.receiveAndInvoice (no plain `receive`).
// To get a Posted Purchase Receipt without a Posted Purchase Invoice we set
// invoiceQuantity = 0 on every line first — BC then posts only the receipt
// half and leaves vendor invoicing for finance to handle later when the
// vendor's actual invoice arrives. Returns the bound action result; the
// caller can call listPurchaseReceipts(orderNumber) to find the new receipt.
async function receivePurchaseOrderLines(poId, lineQtyMap) {
  if (MOCK) return { mock: true };
  const token = await getToken();
  const base = baseUrl();
  const authHeaders = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  // Pull lines + etags fresh — receive may run a long time after PO was made.
  const linesRes = await fetch(`${base}/purchaseOrders(${poId})/purchaseOrderLines`, { headers: authHeaders });
  if (!linesRes.ok) throw new Error(`BC fetch PO lines → ${linesRes.status}: ${await linesRes.text()}`);
  const lines = (await linesRes.json()).value || [];
  if (!lines.length) throw new Error('PO has no lines on BC');

  // PATCH every line — explicit 0 for items not being received this round so
  // BC doesn't fall back to whatever Qty. to Receive was previously set to.
  for (const l of lines) {
    if (l.lineType !== 'Item' && l.lineType !== 'G/L Account') continue;
    const desired = Number(lineQtyMap[l.id] || 0);
    const r = await fetch(`${base}/purchaseOrders(${poId})/purchaseOrderLines(${l.id})`, {
      method: 'PATCH',
      headers: { ...authHeaders, 'If-Match': l['@odata.etag'] },
      body: JSON.stringify({ receiveQuantity: desired, invoiceQuantity: 0 }),
    });
    if (!r.ok) throw new Error(`BC PATCH PO line ${l.id} → ${r.status}: ${await r.text()}`);
  }

  // Trigger the bound action — receiveAndInvoice posts only what each line's
  // receive/invoice qty asks for, so with invoiceQuantity = 0 throughout we
  // get a Posted Purchase Receipt and no invoice.
  const r = await fetch(`${base}/purchaseOrders(${poId})/Microsoft.NAV.receiveAndInvoice`, {
    method: 'POST', headers: authHeaders, body: '{}',
  });
  if (!r.ok && r.status !== 204) throw new Error(`BC receiveAndInvoice → ${r.status}: ${await r.text()}`);
  return { ok: true };
}

module.exports = { MOCK, getToken, listItems, listItemCategories, listItemCards, listSalesPrices, listItemUnitsOfMeasure, getSalesBillings, createSalesOrder, getSalesOrder, addSalesOrderLine, shipAndInvoiceSalesOrder, findPostedInvoiceByExternalDoc, createSalesInvoice, addInvoiceLine, postInvoice, deleteSalesInvoice, deleteSalesOrder, listVendors, findLocationIdByCode, findGLAccountIdByNo, createPurchaseOrder, getPurchaseOrder, addPurchaseOrderLine, patchPurchaseOrderLine, getPurchaseOrderLines, listPurchaseReceipts, receivePurchaseOrderLines, setDocumentDimension, createTransferOrder, addTransferOrderLine };
