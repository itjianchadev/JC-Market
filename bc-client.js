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

// ─── Items ───
async function listItems() {
  if (MOCK) return { mock: true, value: [] };
  return bcFetch('/items?$top=1000');
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

// ─── Purchase Receipts (Posted) ───
async function listPurchaseReceipts(orderNumber) {
  if (MOCK) return { mock: true, value: [] };
  return bcFetch(`/purchaseReceipts?$filter=orderNumber eq '${orderNumber}'&$expand=purchaseReceiptLines`);
}

module.exports = { MOCK, getToken, listItems, listItemCategories, listItemCards, listSalesPrices, listItemUnitsOfMeasure, createSalesOrder, getSalesOrder, addSalesOrderLine, shipAndInvoiceSalesOrder, findPostedInvoiceByExternalDoc, createSalesInvoice, addInvoiceLine, postInvoice, deleteSalesInvoice, deleteSalesOrder, listVendors, createPurchaseOrder, getPurchaseOrder, addPurchaseOrderLine, patchPurchaseOrderLine, getPurchaseOrderLines, listPurchaseReceipts, createTransferOrder, addTransferOrderLine };
