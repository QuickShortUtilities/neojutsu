/* NeoJutsu API.
 *
 * The same Worker serves the site and this API, so there is one origin, no CORS
 * and session cookies simply work. Everything under /api is handled here; every
 * other path falls through to the static assets.
 *
 * Projects are small because the studios are seed-based - a track or a video is
 * a few KB of JSON, not a rendered file - so D1 is the whole storage story.
 */

const SESSION_COOKIE = 'nj_session';
const STATE_COOKIE = 'nj_oauth';
const SESSION_DAYS = 30;
const MAX_PROJECT_BYTES = 256 * 1024;   // a seed-based project is nowhere near this
const MAX_PROJECTS = 200;

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
const fail = (status, code, message) => json({ code, message }, status);

// ---------- small crypto helpers ----------
const enc = new TextEncoder();
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = str => {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - s.length % 4) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
};

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function sign(secret, payload) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = b64url(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body)));
  return `${body}.${sig}`;
}
async function unsign(secret, token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), unb64url(sig), enc.encode(body));
  } catch { return null; }
  if (!ok) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(unb64url(body)));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

// ---------- cookies ----------
function readCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
const setCookie = (name, value, maxAge) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
const clearCookie = name => `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

// ---------- auth ----------
function requireConfig(env) {
  const missing = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SESSION_SECRET']
    .filter(k => !env[k]);
  return missing.length ? missing : null;
}

async function authStart(request, env, url) {
  const missing = requireConfig(env);
  if (missing) return fail(503, 'not_configured', `Sign-in is not set up yet (missing ${missing.join(', ')}).`);
  // The state is signed rather than stored, so no round trip is needed to check
  // it on the way back. `next` lets us return the user to the page they left.
  const next = url.searchParams.get('next') || '/';
  const state = await sign(env.SESSION_SECRET, {
    n: /^\/[\w\-./]*$/.test(next) ? next : '/',       // same-origin paths only
    r: crypto.randomUUID(),
    exp: Date.now() + 10 * 60 * 1000,
  });
  const redirect = `${url.origin}/api/auth/callback`;
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  auth.searchParams.set('redirect_uri', redirect);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('scope', 'openid email profile');
  auth.searchParams.set('state', state);
  auth.searchParams.set('prompt', 'select_account');
  return new Response(null, {
    status: 302,
    headers: { location: auth.toString(), 'set-cookie': setCookie(STATE_COOKIE, state, 600) },
  });
}

async function authCallback(request, env, url) {
  const missing = requireConfig(env);
  if (missing) return fail(503, 'not_configured', 'Sign-in is not set up yet.');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return fail(400, 'bad_request', 'Missing code or state.');
  // Both halves must agree: the signature proves we minted it, the cookie proves
  // it came back to the same browser.
  if (state !== readCookie(request, STATE_COOKIE)) return fail(400, 'bad_state', 'Sign-in expired. Please try again.');
  const claim = await unsign(env.SESSION_SECRET, state);
  if (!claim) return fail(400, 'bad_state', 'Sign-in expired. Please try again.');

  const body = new URLSearchParams({
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: `${url.origin}/api/auth/callback`,
    grant_type: 'authorization_code',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) return fail(502, 'google_error', 'Google would not complete the sign-in.');
  const tok = await res.json();
  // The id_token arrived straight from Google's token endpoint over TLS,
  // authenticated by our client secret, so the payload can be read directly.
  const parts = String(tok.id_token || '').split('.');
  if (parts.length !== 3) return fail(502, 'google_error', 'Google returned no identity.');
  let profile;
  try { profile = JSON.parse(new TextDecoder().decode(unb64url(parts[1]))); }
  catch { return fail(502, 'google_error', 'Google returned an unreadable identity.'); }
  if (!profile.sub) return fail(502, 'google_error', 'Google returned no account id.');

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (id, email, name, picture, created_at, seen_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5)
     ON CONFLICT(id) DO UPDATE SET email = ?2, name = ?3, picture = ?4, seen_at = ?5`
  ).bind(profile.sub, profile.email || '', profile.name || '', profile.picture || '', now).run();

  const session = await sign(env.SESSION_SECRET, {
    sub: profile.sub,
    exp: now + SESSION_DAYS * 86400 * 1000,
  });
  return new Response(null, {
    status: 302,
    headers: {
      location: claim.n || '/',
      'set-cookie': [setCookie(SESSION_COOKIE, session, SESSION_DAYS * 86400), clearCookie(STATE_COOKIE)].join(', '),
    },
  });
}

async function currentUser(request, env) {
  if (!env.SESSION_SECRET || !env.DB) return null;
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const claim = await unsign(env.SESSION_SECRET, token);
  if (!claim || !claim.sub) return null;
  const row = await env.DB.prepare('SELECT id, email, name, picture FROM users WHERE id = ?1')
    .bind(claim.sub).first();
  return row || null;
}

// ---------- projects ----------
const slugify = s => String(s || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '').slice(0, 60) || 'untitled';

async function listProjects(user, env, url) {
  const kind = url.searchParams.get('kind');
  const stmt = kind
    ? env.DB.prepare('SELECT id, kind, title, slug, public, updated_at FROM projects WHERE user_id = ?1 AND kind = ?2 ORDER BY updated_at DESC LIMIT 200').bind(user.id, kind)
    : env.DB.prepare('SELECT id, kind, title, slug, public, updated_at FROM projects WHERE user_id = ?1 ORDER BY updated_at DESC LIMIT 200').bind(user.id);
  const { results } = await stmt.all();
  return json({ projects: results || [] });
}

async function saveProject(request, user, env) {
  let payload;
  try { payload = await request.json(); } catch { return fail(400, 'bad_json', 'Body must be JSON.'); }
  const { id, kind, title, data } = payload || {};
  if (!['audio', 'video', 'game'].includes(kind)) return fail(400, 'bad_kind', 'kind must be "audio", "video" or "game".');
  const body = JSON.stringify(data ?? {});
  if (body.length > MAX_PROJECT_BYTES) return fail(413, 'too_large', 'That project is too large to save.');

  const now = Date.now();
  const name = String(title || 'Untitled').slice(0, 120);
  if (id) {
    const owned = await env.DB.prepare('SELECT id FROM projects WHERE id = ?1 AND user_id = ?2').bind(id, user.id).first();
    if (!owned) return fail(404, 'not_found', 'No such project.');
    await env.DB.prepare('UPDATE projects SET title = ?1, slug = ?2, data = ?3, updated_at = ?4 WHERE id = ?5')
      .bind(name, slugify(name), body, now, id).run();
    return json({ id, kind, title: name, slug: slugify(name), updated_at: now });
  }
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM projects WHERE user_id = ?1').bind(user.id).first();
  if (count && count.n >= MAX_PROJECTS) return fail(409, 'too_many', 'You have reached the project limit.');
  const newId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  await env.DB.prepare(
    `INSERT INTO projects (id, user_id, kind, title, slug, data, public, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?7)`
  ).bind(newId, user.id, kind, name, slugify(name), body, now).run();
  return json({ id: newId, kind, title: name, slug: slugify(name), updated_at: now }, 201);
}

async function getProject(id, request, env) {
  const row = await env.DB.prepare(
    'SELECT id, user_id, kind, title, slug, data, public, updated_at FROM projects WHERE id = ?1'
  ).bind(id).first();
  if (!row) return fail(404, 'not_found', 'No such project.');
  if (!row.public) {
    const user = await currentUser(request, env);
    if (!user || user.id !== row.user_id) return fail(404, 'not_found', 'No such project.');
  }
  let data = {};
  try { data = JSON.parse(row.data); } catch {}
  return json({ id: row.id, kind: row.kind, title: row.title, slug: row.slug,
                public: !!row.public, updated_at: row.updated_at, data });
}

async function setPublic(id, request, user, env) {
  let payload = {};
  try { payload = await request.json(); } catch {}
  const owned = await env.DB.prepare('SELECT id FROM projects WHERE id = ?1 AND user_id = ?2').bind(id, user.id).first();
  if (!owned) return fail(404, 'not_found', 'No such project.');
  const pub = payload.public ? 1 : 0;
  await env.DB.prepare('UPDATE projects SET public = ?1 WHERE id = ?2').bind(pub, id).run();
  return json({ id, public: !!pub });
}

async function deleteProject(id, user, env) {
  const res = await env.DB.prepare('DELETE FROM projects WHERE id = ?1 AND user_id = ?2').bind(id, user.id).run();
  if (!res.meta || !res.meta.changes) return fail(404, 'not_found', 'No such project.');
  return json({ deleted: id });
}

// ---------- router ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (!env.DB) return fail(503, 'no_database', 'The database is not bound to this Worker yet.');

    if (path === '/api/health') return json({ ok: true, configured: !requireConfig(env) });
    if (path === '/api/auth/start') return authStart(request, env, url);
    if (path === '/api/auth/callback') return authCallback(request, env, url);
    if (path === '/api/auth/logout') {
      return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': clearCookie(SESSION_COOKIE) } });
    }

    if (path === '/api/me') {
      const user = await currentUser(request, env);
      return json({ user: user ? { id: user.id, name: user.name, email: user.email, picture: user.picture } : null });
    }

    // Public read comes before the auth wall so a shared link works signed out.
    const one = path.match(/^\/api\/projects\/([A-Za-z0-9]{4,32})$/);
    if (one && request.method === 'GET') return getProject(one[1], request, env);

    const user = await currentUser(request, env);
    if (!user) return fail(401, 'signed_out', 'Sign in to do that.');

    if (path === '/api/projects') {
      if (request.method === 'GET') return listProjects(user, env, url);
      if (request.method === 'POST') return saveProject(request, user, env);
      return fail(405, 'method_not_allowed', 'Use GET or POST.');
    }
    if (one) {
      if (request.method === 'DELETE') return deleteProject(one[1], user, env);
      if (request.method === 'PATCH') return setPublic(one[1], request, user, env);
      return fail(405, 'method_not_allowed', 'Use GET, PATCH or DELETE.');
    }
    return fail(404, 'not_found', 'No such endpoint.');
  },
};
