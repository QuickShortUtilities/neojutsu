"""Worker contract, exercised in a browser with a stubbed database.

There is no node or wrangler here, so the Worker cannot be run properly. What
matters most about it is not plumbing but authorisation: sessions must be
unforgeable and expire, and one account must never reach another's private work.
Those are pure logic, so the module is imported into a page with a fake D1 and
the rules are checked directly.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json, sys, threading, functools, http.server, socketserver
ROOT=Path('/Users/christophercohen/Documents/GitHub/neojutsu')
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self,*a): pass
_srv=socketserver.TCPServer(('127.0.0.1',0), functools.partial(Quiet, directory=str(ROOT)))
PORT=_srv.server_address[1]
threading.Thread(target=_srv.serve_forever,daemon=True).start()
BASE=f'http://127.0.0.1:{PORT}'

HARNESS = r"""
async () => {
  const mod = await import('/worker/index.js');
  const worker = mod.default;

  // A stand-in for D1: enough of the shape to run the Worker's own queries.
  const users = new Map(), projects = new Map();
  const norm = s => s.replace(/\s+/g, ' ').trim();
  const DB = {
    prepare(sql) {
      const q = norm(sql); let args = [];
      const self = {
        bind(...a) { args = a; return self; },
        async first() {
          if (q.startsWith('SELECT id, email, name, picture FROM users')) return users.get(args[0]) || null;
          if (q.startsWith('SELECT COUNT(*) AS n FROM projects')) {
            return { n: [...projects.values()].filter(p => p.user_id === args[0]).length };
          }
          if (q.startsWith('SELECT id FROM projects WHERE id = ?1 AND user_id = ?2')) {
            const p = projects.get(args[0]);
            return p && p.user_id === args[1] ? { id: p.id } : null;
          }
          if (q.startsWith('SELECT id, user_id, kind, title, slug, data, public')) return projects.get(args[0]) || null;
          return null;
        },
        async all() {
          const rows = [...projects.values()]
            .filter(p => p.user_id === args[0] && (args.length < 2 || p.kind === args[1]))
            .map(({ data, ...rest }) => rest);
          return { results: rows };
        },
        async run() {
          if (q.startsWith('INSERT INTO users')) {
            users.set(args[0], { id: args[0], email: args[1], name: args[2], picture: args[3] });
            return { meta: { changes: 1 } };
          }
          if (q.startsWith('INSERT INTO projects')) {
            projects.set(args[0], { id: args[0], user_id: args[1], kind: args[2], title: args[3],
                                    slug: args[4], data: args[5], public: 0, updated_at: args[6] });
            return { meta: { changes: 1 } };
          }
          if (q.startsWith('UPDATE projects SET title')) {
            const p = projects.get(args[4]); if (p) Object.assign(p, { title: args[0], slug: args[1], data: args[2], updated_at: args[3] });
            return { meta: { changes: p ? 1 : 0 } };
          }
          if (q.startsWith('UPDATE projects SET public')) {
            const p = projects.get(args[1]); if (p) p.public = args[0];
            return { meta: { changes: p ? 1 : 0 } };
          }
          if (q.startsWith('DELETE FROM projects')) {
            const p = projects.get(args[0]);
            if (p && p.user_id === args[1]) { projects.delete(args[0]); return { meta: { changes: 1 } }; }
            return { meta: { changes: 0 } };
          }
          return { meta: { changes: 0 } };
        },
      };
      return self;
    },
  };
  const env = { DB, SESSION_SECRET: 'test-secret-value', GOOGLE_CLIENT_ID: 'cid',
                GOOGLE_CLIENT_SECRET: 'csec',
                ASSETS: { fetch: () => new Response('site', { status: 200 }) } };

  users.set('userA', { id: 'userA', email: 'a@x', name: 'A', picture: '' });
  users.set('userB', { id: 'userB', email: 'b@x', name: 'B', picture: '' });

  // `cookie` is a forbidden header on a browser-constructed Request, so pass a
  // request-shaped object: the Worker only reads url, method, headers and json.
  const call = (path, { method = 'GET', cookie, body } = {}) => {
    const map = new Map([['content-type', 'application/json']]);
    if (cookie) map.set('cookie', cookie);
    return worker.fetch({
      url: 'https://neojutsu.com' + path,
      method,
      headers: { get: k => map.get(String(k).toLowerCase()) ?? null },
      json: async () => (body === undefined ? {} : body),
    }, env, {});
  };
  const read = async r => { try { return await r.json(); } catch { return null; } };

  // Mint sessions the way the Worker does, using its own exported behaviour via
  // a round trip through the API is not possible without Google, so sign here
  // with the same secret and shape.
  const enc = new TextEncoder();
  const b64url = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  async function mint(sub, exp) {
    const key = await crypto.subtle.importKey('raw', enc.encode(env.SESSION_SECRET), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
    const payload = b64url(enc.encode(JSON.stringify({ sub, exp })));
    const sig = b64url(await crypto.subtle.sign('HMAC', key, enc.encode(payload)));
    return `nj_session=${payload}.${sig}`;
  }

  const out = {};
  const A = await mint('userA', Date.now() + 3600e3);
  const B = await mint('userB', Date.now() + 3600e3);
  const expired = await mint('userA', Date.now() - 1000);

  out.health = (await read(await call('/api/health'))).ok === true;
  out.static_passthrough = (await call('/index.html')).status === 200;

  out.me_signed_out = (await read(await call('/api/me'))).user === null;
  out.me_signed_in = (await read(await call('/api/me', { cookie: A }))).user.id === 'userA';

  out.list_requires_auth = (await call('/api/projects')).status === 401;
  out.save_requires_auth = (await call('/api/projects', { method: 'POST', body: { kind: 'video' } })).status === 401;

  // forged and expired sessions must not authenticate
  out.forged_rejected = (await read(await call('/api/me', { cookie: 'nj_session=abc.def' }))).user === null;
  const tampered = A.replace('nj_session=', 'nj_session=x');
  out.tampered_rejected = (await read(await call('/api/me', { cookie: tampered }))).user === null;
  out.expired_rejected = (await read(await call('/api/me', { cookie: expired }))).user === null;

  // save, then read back
  const saved = await read(await call('/api/projects', { method: 'POST', cookie: A,
    body: { kind: 'video', title: 'Neon Drive', data: { look: {}, layers: [] } } }));
  out.saved_id = !!saved.id;
  out.saved_slug = saved.slug === 'neon-drive';
  const mine = await read(await call(`/api/projects/${saved.id}`, { cookie: A }));
  out.owner_can_read = mine.title === 'Neon Drive';

  // another account must not see it, signed in or out
  out.stranger_blocked = (await call(`/api/projects/${saved.id}`, { cookie: B })).status === 404;
  out.anon_blocked = (await call(`/api/projects/${saved.id}`)).status === 404;
  out.stranger_cannot_delete = (await call(`/api/projects/${saved.id}`, { method: 'DELETE', cookie: B })).status === 404;
  out.stranger_cannot_share = (await call(`/api/projects/${saved.id}`, { method: 'PATCH', cookie: B, body: { public: true } })).status === 404;
  out.stranger_cannot_overwrite =
    (await call('/api/projects', { method: 'POST', cookie: B, body: { id: saved.id, kind: 'video', title: 'stolen', data: {} } })).status === 404;

  // sharing opens it to everyone, and only then
  await call(`/api/projects/${saved.id}`, { method: 'PATCH', cookie: A, body: { public: true } });
  out.public_readable_by_anon = (await call(`/api/projects/${saved.id}`)).status === 200;
  await call(`/api/projects/${saved.id}`, { method: 'PATCH', cookie: A, body: { public: false } });
  out.unshare_closes_it = (await call(`/api/projects/${saved.id}`)).status === 404;

  // validation
  out.bad_kind_rejected = (await call('/api/projects', { method: 'POST', cookie: A, body: { kind: 'malware', title: 'x', data: {} } })).status === 400;
  const huge = 'x'.repeat(300 * 1024);
  out.oversize_rejected = (await call('/api/projects', { method: 'POST', cookie: A, body: { kind: 'video', title: 'x', data: { huge } } })).status === 413;
  out.list_is_own_only = (await read(await call('/api/projects', { cookie: B }))).projects.length === 0;

  // the open redirect that an unchecked `next` would give an attacker
  const eviled = await call('/api/auth/start?next=https://evil.example/steal');
  out.no_open_redirect = !(eviled.headers.get('location') || '').includes('evil.example');

  out.owner_can_delete = (await call(`/api/projects/${saved.id}`, { method: 'DELETE', cookie: A })).status === 200;
  return out;
}
"""

with sync_playwright() as p:
    b=p.chromium.launch(headless=True)
    page=b.new_context().new_page()
    err=[]; page.on('pageerror',lambda e:err.append(str(e)))
    page.goto(BASE+'/video.html'); page.wait_for_timeout(600)
    res=page.evaluate(HARNESS)
    b.close()
_srv.shutdown()

failed=[k for k,v in res.items() if v is not True]
print(json.dumps(res, indent=2))
if err: print('page errors:', err[:3])
if failed:
    print('\nFAILED:', failed); sys.exit(1)
print('\nWorker contract holds.')
