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
print(json.dumps({'viewports':report,'issues':issues}, indent=2))
if issues: print('\nFAILED'); sys.exit(1)
print('\nLayout holds at every viewport.')
