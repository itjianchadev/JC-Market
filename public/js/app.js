const TOKEN_KEY = 'jcsm_token';
const USER_KEY = 'jcsm_user';

function getToken(){return localStorage.getItem(TOKEN_KEY)}
function getUser(){try{return JSON.parse(localStorage.getItem(USER_KEY))}catch{return null}}
function setAuth(t,u){localStorage.setItem(TOKEN_KEY,t);localStorage.setItem(USER_KEY,JSON.stringify(u))}
function clearAuth(){localStorage.removeItem(TOKEN_KEY);localStorage.removeItem(USER_KEY);location.href='/login.html'}
function requireLogin(){if(!getToken()){location.href='/login.html';return false}return true}

async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(getToken() ? { 'Authorization': 'Bearer ' + getToken() } : {}),
      ...(opts.headers || {}),
    },
  });
  if (r.status === 401) { clearAuth(); return; }
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

function renderNav(active) {
  const u = getUser();
  if (!u) return '';
  const links = [
    ['index.html','🛒 ร้านค้า'],
    ['cart.html','🧺 ตะกร้า'],
    ['orders.html','📋 คำสั่งซื้อ'],
  ];
  if (u.role === 'admin') links.push(['admin.html','⚙️ Admin']);
  return `<div class="nav">
    <div class="brand">🛍️ JC-Stock Market</div>
    ${links.map(([h,l])=>`<a href="${h}" class="${active===h?'active':''}">${l}</a>`).join('')}
    <div class="spacer"></div>
    <div class="user">${u.full_name} (${u.branch_name||u.role})</div>
    <a href="#" onclick="clearAuth();return false">ออกจากระบบ</a>
  </div>`;
}
