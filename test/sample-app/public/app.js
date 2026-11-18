'use strict';
/* Acme Projects — controlled sample SPA for the browser-operator acceptance tests. */
const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
let renderToken = 0;

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}
function toast(msg) {
  toastEl.textContent = msg;
  setTimeout(() => { if (toastEl.textContent === msg) toastEl.textContent = ''; }, 4000);
}
function api(method, path, body) {
  return fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {},
    body: body ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined,
  });
}
function navigate(path, replace) {
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  render();
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (a && !e.ctrlKey && !e.metaKey && a.target !== '_blank') {
    e.preventDefault();
    navigate(a.getAttribute('href'));
  }
});
window.addEventListener('popstate', render);
const link = (href, text, attrs) => h('a', { href, 'data-link': true, ...(attrs || {}) }, text);

async function requireUser() {
  const r = await api('GET', '/api/me').catch(() => null);
  if (!r || r.status === 401) {
    navigate(`/login${sessionStorage.getItem('hadSession') ? '?expired=1' : ''}`, true);
    return null;
  }
  sessionStorage.setItem('hadSession', '1');
  return r.json();
}

function closeMenus(except) {
  for (const btn of document.querySelectorAll('[aria-haspopup="menu"][aria-expanded="true"]')) {
    if (except && (btn === except || btn.parentElement.contains(except))) continue;
    btn.setAttribute('aria-expanded', 'false');
    document.getElementById(btn.getAttribute('aria-controls')).hidden = true;
  }
}
function menuButton(id, label, items, extra) {
  const menu = h('ul', { role: 'menu', id: `${id}-menu`, 'aria-label': label, hidden: true }, ...items);
  const btn = h('button', {
    type: 'button', id, 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': `${id}-menu`, ...(extra || {}),
    onclick: (e) => {
      e.stopPropagation();
      const open = btn.getAttribute('aria-expanded') === 'true';
      closeMenus(btn);
      btn.setAttribute('aria-expanded', String(!open));
      menu.hidden = open;
    },
  }, label);
  return h('li', { class: 'menu-wrap', role: 'none' }, btn, menu);
}
document.addEventListener('click', () => closeMenus());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });

function layout(user, ...content) {
  const team = menuButton('team', 'Team', [
    h('li', { role: 'none' }, link('/settings/team/members', 'Members', { role: 'menuitem' })),
    h('li', { role: 'none' }, link('/settings/team/roles', 'Roles', { role: 'menuitem' })),
  ], { role: 'menuitem' });
  const settings = menuButton('settings', 'Settings', [
    h('li', { role: 'none' }, link('/settings/account', 'Account', { role: 'menuitem' })),
    team,
  ]);
  const header = h('header', {},
    h('strong', {}, 'Acme'),
    h('nav', { 'aria-label': 'Main' },
      link('/dashboard', 'Dashboard'), link('/projects', 'Projects'), link('/reports', 'Reports'),
      link('/checkout', 'Checkout'), link('/orders', 'Orders'),
      user.role === 'admin' ? link('/admin', 'Admin') : null,
      h('ul', { style: 'list-style:none;margin:0;padding:0' }, settings)),
    h('span', {}, user.display),
    h('button', { type: 'button', id: 'sign-out', onclick: async () => { await api('POST', '/api/logout'); sessionStorage.removeItem('hadSession'); navigate('/login'); } }, 'Sign out'));
  app.replaceChildren(header, h('main', {}, ...content));
}

function loginPage() {
  const expired = new URLSearchParams(location.search).get('expired');
  const err = h('div', { role: 'alert', id: 'login-error', class: 'errors' });
  const form = h('form', { id: 'login-form', onsubmit: async (e) => {
    e.preventDefault();
    const r = await api('POST', '/api/login', { username: form.username.value, password: form.password.value }).catch(() => null);
    if (r && r.ok) navigate('/dashboard');
    else err.textContent = 'Invalid username or password';
  } },
    h('h1', {}, 'Sign in'),
    expired ? h('p', { role: 'alert' }, 'Your session has expired. Please sign in again.') : null,
    h('div', { class: 'field' }, h('label', { for: 'username' }, 'Username'), h('input', { id: 'username', name: 'username', autocomplete: 'username' })),
    h('div', { class: 'field' }, h('label', { for: 'password' }, 'Password'), h('input', { id: 'password', name: 'password', type: 'password', autocomplete: 'current-password' })),
    err,
    h('button', { type: 'submit' }, 'Sign in'));
  app.replaceChildren(h('main', {}, form));
}

async function dashboard(m, user) {
  const list = h('ul', { id: 'activity' }, h('li', { class: 'skeleton' }, 'Loading activity…'));
  const status = h('p', { id: 'stats-status' });
  layout(user,
    h('h1', {}, 'Dashboard'),
    h('p', {}, `Welcome back, ${user.display}.`),
    h('section', {}, h('h2', {}, 'Recent activity'), list),
    h('p', {}, h('button', { type: 'button', id: 'refresh-stats', onclick: async () => {
      // A "read-looking" control that actually writes (exercises the network write guard).
      const r = await api('POST', '/api/refresh-stats').catch(() => null);
      status.textContent = r && r.ok ? 'Stats refreshed' : 'Could not refresh stats';
    } }, 'Refresh stats'), ' ', status),
    h('p', {}, h('a', { href: '/captcha' }, 'Partner portal'), ' · ', link('/broken-ui', 'Preferences (beta)')));
  const token = renderToken;
  const r = await api('GET', '/api/activity?delay=1200').catch(() => null);
  if (token !== renderToken) return;
  list.replaceChildren(...(r && r.ok ? (await r.json()).map((t) => h('li', {}, t)) : [h('li', { role: 'alert' }, 'Could not load activity')]));
}

async function projects(m, user) {
  const r = await api('GET', '/api/projects');
  const items = r.ok ? await r.json() : [];
  layout(user,
    h('h1', {}, 'Projects'),
    user.role === 'admin' ? h('p', {}, link('/projects/new', 'New project', { id: 'new-project' })) : null,
    h('ul', { id: 'project-list' }, ...items.map((p) => h('li', {}, link(`/projects/${p.id}`, p.name)))));
}

function field(id, label, input) {
  return h('div', { class: 'field', id: `${id}-field` }, h('label', { for: id }, label), input);
}

async function newProject(m, user) {
  if (user.role !== 'admin') return layout(user, h('h1', {}, 'Not authorized'));
  const errors = h('div', { role: 'alert', id: 'form-errors', class: 'errors' });
  const type = h('select', { id: 'p-type', name: 'type' }, h('option', { value: '' }, 'Choose…'), h('option', { value: 'internal' }, 'Internal'), h('option', { value: 'client' }, 'Client'));
  const clientFields = h('div', { id: 'client-fields', hidden: true },
    field('p-client', 'Client name', h('input', { id: 'p-client', name: 'client' })),
    field('p-email', 'Billing email', h('input', { id: 'p-email', name: 'email', type: 'email' })));
  const hasDeadline = h('input', { id: 'p-has-deadline', type: 'checkbox', name: 'hasDeadline' });
  const deadlineField = h('div', { id: 'deadline-field', hidden: true }, field('p-deadline', 'Deadline', h('input', { id: 'p-deadline', name: 'deadline', type: 'date' })));
  type.addEventListener('change', () => { clientFields.hidden = type.value !== 'client'; });
  hasDeadline.addEventListener('change', () => { deadlineField.hidden = !hasDeadline.checked; });
  const form = h('form', { id: 'project-form', novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    const f = form.elements;
    const problems = [];
    const mark = (el, bad) => el.setAttribute('aria-invalid', String(bad));
    mark(f.name, !f.name.value.trim()); if (!f.name.value.trim()) problems.push('Project name is required');
    mark(type, !type.value); if (!type.value) problems.push('Choose a project type');
    if (type.value === 'client') {
      mark(f.client, !f.client.value.trim()); if (!f.client.value.trim()) problems.push('Client name is required');
      const emailOk = f.email.value.includes('@') && f.email.validity.valid;
      mark(f.email, !emailOk); if (!emailOk) problems.push('Enter a valid billing email');
    }
    if (hasDeadline.checked && !f.deadline.value) problems.push('Choose a deadline');
    if (problems.length) { errors.textContent = `${problems.join('. ')}.`; return; }
    errors.textContent = '';
    const body = { name: f.name.value.trim(), type: type.value, client: f.client.value, email: f.email.value, deadline: hasDeadline.checked ? f.deadline.value : '' };
    const r = await api('POST', '/api/projects', body).catch(() => null);
    if (r && r.status === 201) { const p = await r.json(); toast('Project created'); navigate(`/projects/${p.id}`); }
    else if (r && r.status === 403) errors.textContent = 'You do not have permission to create projects.';
    else errors.textContent = 'Could not create project. Please try again.';
  } },
    field('p-name', 'Project name', h('input', { id: 'p-name', name: 'name', required: true })),
    field('p-type', 'Project type', type),
    clientFields,
    h('div', { class: 'field' }, h('label', {}, hasDeadline, ' Has deadline')),
    deadlineField,
    errors,
    h('button', { type: 'submit' }, 'Create project'));
  layout(user, h('h1', {}, 'New project'), form);
}

async function projectDetail(m, user) {
  const r = await api('GET', `/api/projects/${m[1]}`);
  if (!r.ok) return layout(user, h('h1', {}, 'Project not found'));
  const p = await r.json();
  const names = ['Overview', 'Files', 'Activity'];
  const tabs = names.map((n, k) => h('button', { type: 'button', role: 'tab', id: `tab-${n.toLowerCase()}`, 'aria-controls': `panel-${n.toLowerCase()}`, 'aria-selected': String(k === 0), tabindex: k === 0 ? '0' : '-1' }, n));
  const panels = names.map((n, k) => h('div', { role: 'tabpanel', id: `panel-${n.toLowerCase()}`, 'aria-labelledby': `tab-${n.toLowerCase()}`, hidden: k !== 0 }));
  let activityLoaded = false;
  const select = async (k) => {
    tabs.forEach((t, j) => { t.setAttribute('aria-selected', String(j === k)); t.tabIndex = j === k ? 0 : -1; panels[j].hidden = j !== k; });
    tabs[k].focus();
    if (k === 2 && !activityLoaded) {
      activityLoaded = true;
      panels[2].replaceChildren(h('p', { class: 'skeleton' }, 'Loading activity…'));
      const a = await api('GET', '/api/activity?delay=800');
      panels[2].replaceChildren(h('ul', {}, ...(await a.json()).map((t) => h('li', {}, t))));
    }
  };
  tabs.forEach((t, k) => {
    t.addEventListener('click', () => select(k));
    t.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') select((k + 1) % tabs.length);
      if (e.key === 'ArrowLeft') select((k + tabs.length - 1) % tabs.length);
    });
  });
  const delStatus = h('p', { role: 'alert', id: 'delete-status' });
  panels[0].append(
    h('dl', {}, h('dt', {}, 'Type'), h('dd', {}, p.type), h('dt', {}, 'Client'), h('dd', {}, p.client || '—'), h('dt', {}, 'Deadline'), h('dd', {}, p.deadline || '—')),
    user.role === 'admin' ? h('button', { type: 'button', id: 'delete-project', onclick: async () => {
      if (!confirm(`Delete ${p.name}?`)) return;
      const d = await api('DELETE', `/api/projects/${p.id}`).catch(() => null);
      if (d && d.ok) { toast('Project deleted'); navigate('/projects'); } else delStatus.textContent = 'Could not delete project';
    } }, 'Delete project') : null,
    delStatus);
  const fileInput = h('input', { id: 'file-input', type: 'file', multiple: true });
  const fileList = h('ul', { id: 'file-list' });
  const uploadStatus = h('p', { id: 'upload-status', role: 'status' });
  fileInput.addEventListener('change', () => fileList.replaceChildren(...Array.from(fileInput.files).map((f) => h('li', {}, `${f.name} (${f.size} bytes)`))));
  const tasks = h('ul', { class: 'tasks', id: 'task-list', 'aria-label': 'Task order' }, ...['Design', 'Build', 'Test', 'Ship'].map((t) => h('li', { draggable: 'true', 'data-task': t }, t)));
  let dragged = null;
  tasks.addEventListener('dragstart', (e) => { dragged = e.target.closest('li'); e.dataTransfer.setData('text/plain', dragged.dataset.task); });
  tasks.addEventListener('dragover', (e) => e.preventDefault());
  tasks.addEventListener('drop', (e) => {
    e.preventDefault();
    const target = e.target.closest('li');
    if (dragged && target && dragged !== target) tasks.insertBefore(dragged, target);
  });
  panels[1].append(
    h('div', { class: 'field' }, h('label', { for: 'file-input' }, 'Attach files'), fileInput),
    fileList,
    h('button', { type: 'button', id: 'upload-btn', onclick: async () => {
      const fd = new FormData();
      for (const f of fileInput.files) fd.append('file', f);
      const u = await api('POST', '/api/files', fd).catch(() => null);
      uploadStatus.textContent = u && u.ok ? `Uploaded ${fileInput.files.length} file(s)` : 'Upload failed';
    } }, 'Upload files'),
    uploadStatus,
    h('h3', {}, 'Task order'),
    tasks);
  layout(user, h('h1', {}, p.name), h('div', { role: 'tablist', 'aria-label': 'Project sections' }, ...tabs), ...panels);
}

async function reports(m, user) {
  const list = h('ul', { class: 'reports-list', id: 'reports' });
  const status = h('p', { id: 'reports-status', class: 'skeleton' }, 'Loading reports…');
  const errorBox = h('div', { id: 'reports-error' });
  const sentinel = h('div', { id: 'reports-more', style: 'height:1px' });
  let page = 0;
  let more = true;
  let loading = false;
  const load = async (reset) => {
    if (loading) return;
    loading = true;
    if (reset) { page = 0; more = true; list.replaceChildren(); }
    errorBox.replaceChildren();
    status.textContent = 'Loading reports…';
    const r = await api('GET', `/api/reports?page=${page + 1}`).catch(() => null);
    loading = false;
    if (!r || !r.ok) {
      status.textContent = '';
      errorBox.replaceChildren(h('p', { role: 'alert' }, 'Failed to load reports'), h('button', { type: 'button', onclick: () => load(false) }, 'Retry'));
      return;
    }
    const data = await r.json();
    page = data.page;
    more = data.more;
    list.append(...data.items.map((t) => h('li', {}, t)));
    status.textContent = more ? '' : 'All reports loaded';
  };
  layout(user,
    h('h1', {}, 'Reports'),
    h('p', {},
      h('a', { href: '/api/export.csv', download: 'projects.csv', id: 'export-csv' }, 'Export CSV'), ' ',
      h('button', { type: 'button', id: 'open-preview', onclick: () => window.open('/reports/preview', '_blank') }, 'Open preview'), ' ',
      h('button', { type: 'button', id: 'reload-reports', onclick: () => load(true) }, 'Reload data')),
    status, errorBox, list, sentinel);
  new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting) && more && page > 0) load(false); }).observe(sentinel);
  await load(true);
}

async function checkout(m, user) {
  const s = { step: 1, plan: '', company: '', seats: '', order: null };
  const body = h('div', { id: 'wizard' });
  const steps = ['Plan', 'Details', 'Review', 'Done'];
  const draw = () => {
    const errors = h('div', { role: 'alert', class: 'errors', id: 'wizard-errors' });
    const indicator = h('ol', { class: 'steps', 'aria-label': 'Checkout progress' }, ...steps.map((t, k) => h('li', { 'aria-current': k + 1 === s.step ? 'step' : null }, t)));
    let content;
    if (s.step === 1) {
      content = [h('fieldset', {}, h('legend', {}, 'Choose a plan'),
        ...['Starter', 'Team', 'Enterprise'].map((p) => h('label', { style: 'display:block' }, h('input', { type: 'radio', name: 'plan', value: p, checked: s.plan === p, onchange: () => { s.plan = p; } }), ` ${p}`))),
        errors,
        h('button', { type: 'button', onclick: () => { if (!s.plan) { errors.textContent = 'Choose a plan'; return; } s.step = 2; draw(); } }, 'Next')];
    } else if (s.step === 2) {
      const company = h('input', { id: 'company', value: s.company });
      const seats = h('input', { id: 'seats', type: 'number', min: '1', value: s.seats });
      content = [field('company', 'Company name', company), field('seats', 'Seats', seats), errors,
        h('button', { type: 'button', onclick: () => { s.company = company.value; s.seats = seats.value; s.step = 1; draw(); } }, 'Back'), ' ',
        h('button', { type: 'button', onclick: () => {
          s.company = company.value.trim(); s.seats = seats.value;
          const bad = [];
          if (!s.company) bad.push('Company name is required');
          if (!(Number(s.seats) >= 1)) bad.push('Seats must be at least 1');
          if (bad.length) { errors.textContent = `${bad.join('. ')}.`; return; }
          s.step = 3; draw();
        } }, 'Next')];
    } else if (s.step === 3) {
      content = [h('h2', {}, 'Review your order'),
        h('dl', {}, h('dt', {}, 'Plan'), h('dd', { id: 'review-plan' }, s.plan), h('dt', {}, 'Company'), h('dd', { id: 'review-company' }, s.company), h('dt', {}, 'Seats'), h('dd', { id: 'review-seats' }, s.seats)),
        errors,
        h('button', { type: 'button', onclick: () => { s.step = 2; draw(); } }, 'Edit details'), ' ',
        h('button', { type: 'button', id: 'place-order', onclick: async () => {
          const r = await api('POST', '/api/orders', { plan: s.plan, company: s.company, seats: Number(s.seats) }).catch(() => null);
          if (r && r.status === 201) { s.order = await r.json(); s.step = 4; draw(); }
          else if (r && r.status === 500) errors.textContent = 'Payment service unavailable. Your order was not placed.';
          else errors.textContent = 'Something went wrong. Check your orders before trying again.';
        } }, 'Place order')];
    } else {
      content = [h('h2', {}, 'Order confirmed'), h('p', { id: 'order-number' }, `Order number ${s.order.id}`), link('/orders', 'View orders')];
    }
    body.replaceChildren(indicator, ...content);
  };
  layout(user, h('h1', {}, 'Checkout'), body);
  draw();
}

async function orders(m, user) {
  const r = await api('GET', '/api/orders');
  const list = r.ok ? await r.json() : [];
  layout(user, h('h1', {}, 'Orders'),
    list.length ? h('ul', { id: 'order-list' }, ...list.map((o) => h('li', {}, `${o.id} — ${o.plan} — ${o.seats} seats — ${o.company}`))) : h('p', { id: 'no-orders' }, 'No orders yet'));
}

function simple(title) {
  return async (m, user) => layout(user, h('h1', {}, title), h('p', {}, `${title} page.`));
}

async function adminPage(m, user) {
  if (user.role !== 'admin') return layout(user, h('h1', {}, 'Not authorized'));
  layout(user, h('h1', {}, 'Administration'), h('p', {}, 'Manage organisation-wide settings.'));
}

async function brokenUi(m, user) {
  const tips = h('p', { id: 'tips' });
  layout(user,
    h('h1', {}, 'Preferences (beta)'),
    h('div', { class: 'field' }, h('label', { for: 'display-name' }, 'Display name'), h('input', { id: 'display-name', value: user.display })),
    h('p', {}, h('button', { type: 'button', id: 'preview-changes', onclick: () => { tips.textContent = 'Preview ready'; } }, 'Preview changes'), ' ',
      h('button', { type: 'button', id: 'show-tips' }, 'Show tips')),
    tips,
    h('div', { class: 'cards' }, ...['a', 'b', 'c', 'd'].map((k) => h('div', { class: 'card', id: `card-${k}` }, `Card ${k.toUpperCase()}`))));
  // Defect: the cookie banner's full-screen click-catcher is never removed while the banner is open.
  const layer = h('div', { class: 'cookie-layer', id: 'cookie-layer' });
  const banner = h('div', { class: 'cookie-banner', id: 'cookie-banner' }, h('span', {}, 'We use cookies to improve your experience.'),
    h('button', { type: 'button', id: 'dismiss-cookies', onclick: () => { layer.remove(); banner.remove(); } }, 'Dismiss'));
  app.append(layer, banner);
}

const routes = [
  [/^\/$/, () => navigate('/dashboard', true)],
  [/^\/login$/, loginPage],
  [/^\/dashboard$/, auth(dashboard)],
  [/^\/projects$/, auth(projects)],
  [/^\/projects\/new$/, auth(newProject)],
  [/^\/projects\/(\d+)$/, auth(projectDetail)],
  [/^\/reports$/, auth(reports)],
  [/^\/reports\/preview$/, auth(simple('Report preview'))],
  [/^\/checkout$/, auth(checkout)],
  [/^\/orders$/, auth(orders)],
  [/^\/settings\/account$/, auth(simple('Account settings'))],
  [/^\/settings\/team\/members$/, auth(simple('Team members'))],
  [/^\/settings\/team\/roles$/, auth(simple('Team roles'))],
  [/^\/admin$/, auth(adminPage)],
  [/^\/broken-ui$/, auth(brokenUi)],
];
function auth(fn) {
  return async (m) => {
    const token = renderToken;
    const user = await requireUser();
    if (!user || token !== renderToken) return;
    await fn(m, user);
  };
}
function render() {
  renderToken++;
  const path = location.pathname;
  for (const [re, fn] of routes) {
    const m = re.exec(path);
    if (m) return fn(m);
  }
  app.replaceChildren(h('main', {}, h('h1', {}, 'Page not found')));
}
render();
