/* Cloud account and projects.
 *
 * Shared by both studios. Everything here is optional: the same files are also
 * served from static hosting where /api does not exist, so a failed probe must
 * leave the studio working exactly as it did before, with the cloud UI simply
 * absent rather than broken.
 */
(() => {
  'use strict';

  let user = null, available = false, probed = false;
  const listeners = new Set();
  const notify = () => listeners.forEach(fn => { try { fn(user, available); } catch {} });

  async function api(path, options = {}) {
    const res = await fetch(path, { credentials: 'same-origin', ...options });
    const type = res.headers.get('content-type') || '';
    if (!type.includes('application/json')) throw new Error('offline');
    const body = await res.json();
    if (!res.ok) throw Object.assign(new Error(body.message || 'Request failed'), { code: body.code, status: res.status });
    return body;
  }

  async function probe() {
    if (probed) return available;
    probed = true;
    try {
      const me = await api('/api/me');
      user = me.user || null; available = true;
    } catch { user = null; available = false; }
    notify();
    return available;
  }

  const signIn = () => { location.href = `/api/auth/start?next=${encodeURIComponent(location.pathname)}`; };
  const signOut = () => { location.href = '/api/auth/logout'; };

  const list = kind => api(`/api/projects${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`).then(r => r.projects || []);
  const load = id => api(`/api/projects/${encodeURIComponent(id)}`);
  const save = ({ id, kind, title, data }) =>
    api('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' },
                           body: JSON.stringify({ id, kind, title, data }) });
  const remove = id => api(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const setPublic = (id, pub) =>
    api(`/api/projects/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' },
                                                     body: JSON.stringify({ public: !!pub }) });

  // ---------- the account chip in the nav ----------
  function mountNav() {
    const nav = document.querySelector('.nav-links');
    if (!nav || nav.querySelector('.account')) return;
    const wrap = document.createElement('span');
    wrap.className = 'account';
    wrap.hidden = true;
    nav.insertBefore(wrap, nav.firstChild);

    const render = () => {
      wrap.hidden = !available;
      wrap.innerHTML = '';
      if (!available) return;
      if (!user) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'account-btn';
        b.textContent = 'Sign in';
        b.addEventListener('click', signIn);
        wrap.append(b);
        return;
      }
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'account-btn is-in';
      b.title = user.email || '';
      const who = (user.name || user.email || 'account').split(' ')[0];
      b.innerHTML = user.picture
        ? `<img src="${user.picture}" alt="" referrerpolicy="no-referrer"><span>${who}</span>`
        : `<span>${who}</span>`;
      const menu = document.createElement('div');
      menu.className = 'account-menu'; menu.hidden = true;
      const out = document.createElement('button');
      out.type = 'button'; out.className = 'mini'; out.textContent = 'Sign out';
      out.addEventListener('click', signOut);
      menu.append(out);
      b.addEventListener('click', () => { menu.hidden = !menu.hidden; });
      document.addEventListener('click', e => { if (!wrap.contains(e.target)) menu.hidden = true; });
      wrap.append(b, menu);
    };
    listeners.add(render);
    render();
  }

  function onChange(fn) { listeners.add(fn); if (probed) fn(user, available); }

  window.NeoCloud = {
    get user() { return user; },
    get available() { return available; },
    probe, signIn, signOut, list, load, save, remove, setPublic, onChange,
  };

  const start = () => { mountNav(); probe(); };
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', start) : start();
})();
