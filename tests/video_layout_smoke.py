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

    # ---- controls must fit the box they are drawn in ----
    # A grid item's automatic minimum size is its content, so `1fr 1fr` is not
    # two halves: a column holding a long option grows past its share and
    # squeezes its neighbour. That crushed Lives to 47px and an intro slider
    # to 25px before anyone noticed.
    b3=p2.chromium.launch(headless=True)
    fits={}
    pg=b3.new_context(viewport={"width":1512,"height":1100}).new_page()
    for f in ['game.html','video.html']:
        pg.goto(ROOT.as_uri()+'/'+f); pg.wait_for_timeout(400)
        pg.evaluate("localStorage.clear()"); pg.reload(); pg.wait_for_timeout(1500)
        fits[f]=pg.evaluate("""()=>{
          const rows=[...document.querySelectorAll('.two-up')].map((row,i)=>{
            const kids=[...row.children].map(k=>({
              cls:(k.className||'').toString().split(' ')[0],
              w:Math.round(k.getBoundingClientRect().width),
              label:(k.querySelector('span')?.textContent||'').trim().slice(0,18),
            }));
            const cls=(row.className||'').toString();
            const even = !/lead-tight|lead-short|trail-tight/.test(cls);
            return {i, cols:getComputedStyle(row).gridTemplateColumns, kids, even};
          });
          // any control too narrow to use, and any button its content spills out of
          // A slider needs room to drag; a select needs room for a value and
          // its caret. Different controls, different floors.
          const floor = e => e.tagName === 'INPUT' && e.type === 'range' ? 64 : 48;
          const tiny=[...document.querySelectorAll('.two-up input[type=range], .two-up .neo-select-btn, .two-up input[type=number]')]
            .map(e=>({w:Math.round(e.getBoundingClientRect().width), min:floor(e),
                      what:e.tagName.toLowerCase()+(e.type?'['+e.type+']':'')}))
            .filter(x=>x.w>0 && x.w<x.min);
          const spill=[...document.querySelectorAll('.neo-select-btn')]
            .filter(b=>b.scrollWidth > b.clientWidth+1)
            .map(b=>b.querySelector('.neo-select-value')?.textContent||'?');
          return {rows, tiny, spill};
        }""")
    pg.close(); b3.close()
    report['control_fit']=fits
    for f,d in fits.items():
        for t in d['tiny']:
            issues.append(f"{f}: a {t['what']} in a two-up row is only {t['w']}px wide, needs {t['min']}")
        for sp in d['spill']:
            issues.append(f"{f}: the select button cannot hold its own content ({sp!r})")
        for row in d['rows']:
            ws=[k['w'] for k in row['kids'] if k['w']>0]
            # An unmarked row is meant to be halves. A row marked lead-tight,
            # lead-short or trail-tight is uneven on purpose, and only has to
            # keep its controls usable - checked above.
            if row['even'] and len(ws)==2 and abs(ws[0]-ws[1])>8:
                labels=[k['label'] for k in row['kids']]
                issues.append(f"{f}: two-up row {row['i']} {labels} split {ws[0]}/{ws[1]}px")

print(json.dumps({'viewports':report,'issues':issues}, indent=2))
if issues: print('\nFAILED'); sys.exit(1)
print('\nLayout holds at every viewport.')
