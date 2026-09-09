"""Layout contract: the preview is never distorted and the page never scrolls
sideways, at any viewport the studio is likely to meet."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json, sys
ROOT=Path('/Users/christophercohen/Documents/GitHub/neojutsu')
PAINT = """()=>{
  const c=document.getElementById('v-canvas'), r=c.getBoundingClientRect();
  const ar=c.width/c.height, boxAr=r.width/r.height;
  const dw = boxAr > ar ? r.height*ar : r.width;
  const dh = boxAr > ar ? r.height : r.width/ar;
  const doc=document.documentElement;
  const over=[...document.querySelectorAll('body *')].map(e=>{
      const b=e.getBoundingClientRect(); return {e,right:b.right,w:b.width};
    }).filter(o=>o.right > doc.clientWidth+1 && o.w>0)
      .sort((a,b)=>b.right-a.right).slice(0,4)
      .map(o=>`${o.e.tagName.toLowerCase()}${o.e.id?'#'+o.e.id:''}.${(o.e.className||'').toString().split(' ')[0]}`);
  return {drawn:[Math.round(dw),Math.round(dh)], drawnAR:+(dw/dh).toFixed(3),
          intrinsicAR:+ar.toFixed(3), hscroll: doc.scrollWidth > doc.clientWidth+1, over};
}"""
report={}; issues=[]
with sync_playwright() as p:
    b=p.chromium.launch(headless=True,args=['--autoplay-policy=no-user-gesture-required'])
    for vw,vh,label in [(1512,1000,'desktop'),(1280,800,'laptop'),(1100,800,'small laptop'),
                        (900,760,'narrow'),(768,900,'tablet'),(430,900,'phone'),(390,844,'small phone')]:
        page=b.new_context(viewport={"width":vw,"height":vh}).new_page()
        err=[]; page.on('pageerror',lambda e:err.append(str(e)))
        page.goto(ROOT.as_uri()+'/video.html'); page.wait_for_timeout(400)
        page.evaluate("localStorage.clear()"); page.reload(); page.wait_for_timeout(900)
        page.click('#v-play'); page.wait_for_timeout(600)
        r=page.evaluate(PAINT)
        report[label]={'drawn':r['drawn'],'ar':r['drawnAR'],'hscroll':r['hscroll']}
        if abs(r['drawnAR']-r['intrinsicAR'])>0.01:
            issues.append(f"{label}: preview distorted ({r['drawnAR']} vs {r['intrinsicAR']})")
        if r['hscroll']:
            issues.append(f"{label}: page scrolls sideways, widest: {r['over']}")
        if err: issues.append(f'{label}: console errors {err[:1]}')
        page.close()
    b.close()
    # The three rooms share one chrome. Each page uses its own element ids, and
    # three separate times a shared rule failed to reach one of them - so the
    # bars are compared directly rather than trusted to match.
with sync_playwright() as p2:
    b2=p2.chromium.launch(headless=True)
    pg=b2.new_context(viewport={"width":1512,"height":950}).new_page()
    bars={}
    for f,(auto,read) in [('studio.html',('autosave-status','position')),
                          ('video.html',('v-autosave','v-position')),
                          ('game.html',('g-autosave','g-readout'))]:
        pg.goto(ROOT.as_uri()+'/'+f); pg.wait_for_timeout(800)
        bars[f]=pg.evaluate("""([a,r])=>{
          const bar=document.querySelector('.session-bar');
          const cs=e=>{const x=getComputedStyle(e);return x.fontSize+' '+x.fontFamily.split(',')[0];};
          const A=document.getElementById(a), R=document.getElementById(r);
          return {h:Math.round(bar.getBoundingClientRect().height),
                  autosave:A?cs(A):'missing', readout:R?cs(R):'missing'};}""", [auto,read])
    b2.close()
    report['session_bars']=bars
    heights={v['h'] for v in bars.values()}
    if len(heights)!=1: issues.append(f'session bars differ in height: {[(k,v["h"]) for k,v in bars.items()]}')
    autos={v['autosave'] for v in bars.values()}
    if len(autos)!=1: issues.append(f'autosave lines styled differently: {autos}')
    reads={v['readout'] for v in bars.values()}
    if len(reads)!=1: issues.append(f'readouts styled differently: {reads}')

print(json.dumps({'viewports':report,'issues':issues}, indent=2))
if issues: print('\nFAILED'); sys.exit(1)
print('\nLayout holds at every viewport.')
