"""Cloud account and projects, exercised against a stubbed API.

There is no node or wrangler on this machine, so the Worker cannot run locally.
What is testable here is the half that ships to the browser: that the studio is
unchanged when the API is absent, that the account chip and Projects panel
appear only when signed in, and that save, open, delete and share do what the
UI claims. The Worker's own behaviour is covered by worker_contract.py.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json, sys, threading, functools, http.server, socketserver
ROOT=Path('/Users/christophercohen/Documents/GitHub/neojutsu')

# Route interception only applies to http(s), so the site is served rather than
# opened from disk for this suite.
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
_handler = functools.partial(Quiet, directory=str(ROOT))
_srv = socketserver.TCPServer(('127.0.0.1', 0), _handler)
PORT = _srv.server_address[1]
threading.Thread(target=_srv.serve_forever, daemon=True).start()
BASE = f'http://127.0.0.1:{PORT}'
report={}; issues=[]

USER={'id':'g-1','name':'Chris Cohen','email':'chris@example.com','picture':''}
store={}

def install(page, signed_in=True, offline=False):
    """Stand in for the Worker so the browser half can be tested on its own."""
    def handler(route):
        url=route.request.url; method=route.request.method
        if offline:
            return route.fulfill(status=404, content_type='text/html', body='<!doctype html>not found')
        if url.endswith('/api/me'):
            return route.fulfill(json={'user': USER if signed_in else None})
        if '/api/projects' in url:
            path=url.split('?')[0]
            pid=path.rsplit('/',1)[-1]
            if path.endswith('/api/projects'):
                if method=='GET':
                    return route.fulfill(json={'projects':[
                        {'id':k,'kind':'video','title':v['title'],'slug':'s','public':v['public'],
                         'updated_at':v['updated_at']} for k,v in sorted(store.items())]})
                if method=='POST':
                    body=json.loads(route.request.post_data or '{}')
                    key=body.get('id') or f'p{len(store)+1}'
                    store[key]={'title':body.get('title','Untitled'),'data':body.get('data'),
                                'public':0,'updated_at':1700000000000}
                    return route.fulfill(json={'id':key,'kind':'video','title':store[key]['title'],
                                               'slug':'s','updated_at':store[key]['updated_at']})
            if method=='GET' and pid in store:
                v=store[pid]
                return route.fulfill(json={'id':pid,'kind':'video','title':v['title'],'slug':'s',
                                           'public':bool(v['public']),'updated_at':v['updated_at'],'data':v['data']})
            if method=='DELETE' and pid in store:
                store.pop(pid); return route.fulfill(json={'deleted':pid})
            if method=='PATCH' and pid in store:
                body=json.loads(route.request.post_data or '{}')
                store[pid]['public']=1 if body.get('public') else 0
                return route.fulfill(json={'id':pid,'public':bool(store[pid]['public'])})
            return route.fulfill(status=404, json={'code':'not_found','message':'no'})
        return route.fulfill(status=404, json={'code':'not_found','message':'no'})
    page.route('**/api/**', handler)

with sync_playwright() as p:
    b=p.chromium.launch(headless=True,args=['--autoplay-policy=no-user-gesture-required'])

    # 1. No API at all - the studio must be untouched.
    page=b.new_context(viewport={"width":1512,"height":1000}).new_page()
    err=[]; page.on('pageerror',lambda e:err.append(str(e)))
    install(page, offline=True)
    page.goto(BASE+'/video.html'); page.wait_for_timeout(400)
    page.evaluate("localStorage.clear()"); page.reload(); page.wait_for_timeout(1000)
    if err: issues.append(f'errors with no API: {err[:2]}')
    if page.locator('.account').count() and page.locator('.account').is_visible():
        issues.append('account chip shown with no API')
    if not page.locator('#v-cloud').is_hidden(): issues.append('projects panel shown with no API')
    if page.locator('.layer-row').count() < 1: issues.append('studio broken with no API')
    report['offline_clean']=not issues
    page.close()

    # 2. API present, signed out.
    page=b.new_context(viewport={"width":1512,"height":1000}).new_page()
    err=[]; page.on('pageerror',lambda e:err.append(str(e)))
    install(page, signed_in=False)
    page.goto(BASE+'/video.html'); page.wait_for_timeout(400)
    page.evaluate("localStorage.clear()"); page.reload(); page.wait_for_timeout(1000)
    if not page.locator('.account-btn').is_visible(): issues.append('no Sign in button when signed out')
    if page.text_content('.account-btn').strip()!='Sign in': issues.append('wrong signed-out label')
    if not page.locator('#v-cloud').is_hidden(): issues.append('projects panel shown while signed out')
    report['signed_out_ok']=True
    page.close()

    # 3. Signed in: save, list, share, delete.
    page=b.new_context(viewport={"width":1512,"height":1000}).new_page()
    err=[]; page.on('pageerror',lambda e:err.append(str(e)))
    install(page, signed_in=True)
    page.goto(BASE+'/video.html'); page.wait_for_timeout(400)
    page.evaluate("localStorage.clear()"); page.reload(); page.wait_for_timeout(1200)
    if 'Chris' not in page.text_content('.account-btn'): issues.append('account chip does not show the user')
    if page.locator('#v-cloud').is_hidden(): issues.append('projects panel hidden while signed in')

    page.fill('#v-title','Neon Drive'); page.dispatch_event('#v-title','input')
    page.click('#v-cloud-save'); page.wait_for_timeout(700)
    if page.locator('.cloud-item').count()!=1: issues.append(f'save did not list the project ({page.locator(".cloud-item").count()})')
    if 'Neon Drive' not in page.text_content('.cloud-item'): issues.append('saved project has the wrong title')

    page.click('#v-cloud-new'); page.wait_for_timeout(700)
    if page.locator('.cloud-item').count()!=2: issues.append('save as new did not create a second project')
    report['saved']=len(store)

    # what was stored has to be a real project, not an empty shell
    saved=list(store.values())[0]['data']
    if not saved or 'layers' not in saved or 'look' not in saved:
        issues.append(f'saved payload is not a project: {list(saved or {})[:5]}')
    report['payload_keys']=sorted(saved.keys()) if saved else []

    page.on('dialog', lambda d: d.accept())
    page.locator('.cloud-item .del').first.click(); page.wait_for_timeout(700)
    if page.locator('.cloud-item').count()!=1: issues.append('delete did not remove the project')

    page.click('#v-cloud-share'); page.wait_for_timeout(600)
    if not any(v['public'] for v in store.values()): issues.append('share did not make the project public')
    report['shared']=True
    if err: issues.append(f'errors while signed in: {err[:2]}')
    page.close()
    b.close()

print(json.dumps({'report':report,'issues':issues}, indent=2))
if issues:
    _srv.shutdown(); print('\nFAILED'); sys.exit(1)
_srv.shutdown()
print('\nCloud UI behaves.')
