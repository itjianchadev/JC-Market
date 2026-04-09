/**
 * D365 Business Central API Client (OAuth2 Client Credentials)
 * Falls back to mock mode when USE_MOCK_BC=1 or creds missing.
 */
const fetch = require('node-fetch');

const {
  BC_TENANT_ID, BC_CLIENT_ID, BC_CLIENT_SECRET,
  BC_ENVIRONMENT = 'Production', BC_COMPANY_ID,
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

// ─── Sales Invoice ───
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

module.exports = { MOCK, getToken, listItems, createSalesInvoice, addInvoiceLine, postInvoice };
