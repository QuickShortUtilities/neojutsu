"""A packaged game has to work on someone else's machine.

The studio is served, a game is packaged, the resulting file is saved and then
opened on its own - no server, no network, nothing from this repo - and played.
If that file does not run, the whole "send it to a friend" idea is a claim
rather than a feature.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json, sys, tempfile, threading, functools, http.server, socketserver
ROOT=Path('/Users/christophercohen/Documents/GitHub/neojutsu')
ART=Path(tempfile.mkdtemp(prefix='neojutsu-pkg-'))
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self,*a): pass
_srv=socketserver.TCPServer(('127.0.0.1',0), functools.partial(Quiet, directory=str(ROOT)))
PORT=_srv.server_address[1]
threading.Thread(target=_srv.serve_forever,daemon=True).start()
BASE=f'http://127.0.0.1:{PORT}'
GB={(0x0f,0x38,0x0f),(0x30,0x62,0x30),(0x8b,0xac,0x0f),(0x9b,0xbc,0x0f)}
report={}; issues=[]

with sync_playwright() as p:
    b=p.chromium.launch(headless=True)
    ctx=b.new_context(viewport={"width":1512,"height":1100}, accept_downloads=True)
    page=ctx.new_page(); err=[]; page.on('pageerror',lambda e:err.append(str(e)))

    # a track to score it with, so the package carries music too
    page.goto(BASE+'/studio.html'); page.wait_for_timeout(800)
    page.click('#g-go'); page.wait_for_timeout(600)
    page.fill('#x-title','pack tune'); page.click('#x-save'); page.wait_for_timeout(300)

    page.goto(BASE+'/game.html'); page.wait_for_timeout(1200)
    if err: issues.append(f'studio errors: {err[:2]}')
    page.fill('#g-title','Friend Game'); page.dispatch_event('#g-title','input')
    tracks=page.eval_on_selector_all('#g-audio-src option','e=>e.map(o=>o.value)')
    scored=[t for t in tracks if t.startswith('saved:')]
    if scored:
        page.select_option('#g-audio-src', scored[0]); page.wait_for_timeout(800)
    report['scored']=bool(scored)

    with page.expect_download(timeout=120000) as dl:
        page.click('#g-package')
    pkg=ART/'game.html'; dl.value.save_as(str(pkg))
    size=pkg.stat().st_size
    report['package_kb']=round(size/1024)
    if size < 20000: issues.append(f'package suspiciously small: {size} bytes')
    text=pkg.read_text(encoding='utf-8')
    for needed in ['NeoGame','NeoPalette','NeoChip','NeoScene']:
        if needed not in text: issues.append(f'package is missing {needed}')
    page.close()

    # Now open it as a plain file, with the server irrelevant.
    page2=ctx.new_page(); err2=[]; page2.on('pageerror',lambda e:err2.append(str(e)))
    page2.goto(pkg.as_uri()); page2.wait_for_timeout(1500)
    if err2: issues.append(f'packaged file errors: {err2[:3]}')

    info=page2.evaluate("""()=>{
      const c=document.querySelector('canvas');
      return {canvas:[c.width,c.height], title:document.getElementById('t').textContent,
              hasEngine: typeof window.NeoGame!=='undefined'};}""")
    report['standalone']=info
    if not info['hasEngine']: issues.append('engine missing in the packaged file')
    if info['title']!='Friend Game': issues.append(f"title not carried: {info['title']}")

    # it has to render a real, on-palette frame
    cols=page2.evaluate("""()=>{const c=document.querySelector('canvas');
      const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      const s=new Set(); for(let i=0;i<d.length;i+=4) s.add(`${d[i]},${d[i+1]},${d[i+2]}`);
      return [...s];}""")
    stray={tuple(int(n) for n in k.split(','))for k in cols} - GB
    report['colours']=len(cols)
    if stray: issues.append(f'packaged frame off-palette: {list(stray)[:3]}')
    if len(cols) < 2: issues.append('packaged frame is blank')

    # and it has to actually play: press right, the player moves
    moved=page2.evaluate("""()=>new Promise(res=>{
      const before=document.querySelector('canvas').toDataURL().length;
      window.dispatchEvent(new KeyboardEvent('keydown',{code:'ArrowRight'}));
      setTimeout(()=>{ window.dispatchEvent(new KeyboardEvent('keyup',{code:'ArrowRight'}));
        res(document.querySelector('canvas').toDataURL().length!==before); }, 900);
    })""")
    report['plays_standalone']=moved
    if not moved: issues.append('packaged game did not respond to input')
    b.close()
_srv.shutdown()

print(json.dumps({'report':report,'issues':issues}, indent=2))
if issues: print('\nFAILED'); sys.exit(1)
print('\nA packaged game runs on its own.')
