from pathlib import Path
from playwright.sync_api import sync_playwright
import tempfile, json
ROOT = Path('/Users/christophercohen/Documents/GitHub/neojutsu')
ART = Path(tempfile.mkdtemp(prefix='neojutsu-layers-'))
GB = {(0x0f,0x38,0x0f),(0x30,0x62,0x30),(0x8b,0xac,0x0f),(0x9b,0xbc,0x0f)}
report={}
SAMPLE = """() => { const c=document.getElementById('v-canvas');
  const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
  const seen=new Set(); let sig=0;
  for(let i=0;i<d.length;i+=4){seen.add(`${d[i]},${d[i+1]},${d[i+2]}`);sig=(sig*31+d[i]+d[i+1]*3+d[i+2]*7)|0;}
  return {colors:[...seen],sig}; }"""
def setv(page,sel,val):
    page.evaluate("([s,v])=>{const e=document.querySelector(s);e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));}",[sel,str(val)])

def pick_scene(page, key):
    page.evaluate("(k)=>{const s=document.getElementById('v-scene'); s.value=k; s.dispatchEvent(new Event('input',{bubbles:true}));}", key)

with sync_playwright() as p:
    b=p.chromium.launch(headless=True,args=['--autoplay-policy=no-user-gesture-required'])
    page=b.new_context(viewport={"width":1512,"height":1150}).new_page()
    errors=[]; page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(ROOT.as_uri()+'/video.html'); page.wait_for_timeout(400)
    page.evaluate("localStorage.clear()")
    page.reload(); page.wait_for_timeout(800)
    assert not errors, errors

    assert page.locator('.layer-row').count()==1, 'should open with one layer'
    page.select_option('#v-chip','gameboy'); page.dispatch_event('#v-chip','input')
    pick_scene(page, 'skyline')
    page.fill('#v-seed','neojutsu'); page.dispatch_event('#v-seed','input')
    page.click('#v-play'); page.wait_for_timeout(700)
    one = page.evaluate(SAMPLE)
    report['one_layer_colors']=len(one['colors'])

    # Adding a layer composites and visibly changes the frame.
    page.click('#v-layer-add'); page.wait_for_timeout(900)
    assert page.locator('.layer-row').count()==2, 'add did not create a layer'
    two = page.evaluate(SAMPLE)
    assert two['sig'] != one['sig'], 'second layer did not change the picture'
    stray = {tuple(int(n) for n in k.split(','))for k in two['colors']} - GB
    assert not stray, f'compositing broke the palette: {stray}'
    report['two_layer_colors']=len(two['colors'])

    # Hiding the top layer must fall back toward the single-layer picture.
    page.evaluate("document.querySelectorAll('.layer-row .layer-eye')[0].click()")
    page.wait_for_timeout(700)
    hidden = page.evaluate(SAMPLE)
    assert hidden['sig'] != two['sig'], 'hiding a layer changed nothing'
    report['hide_works']=True
    page.evaluate("document.querySelectorAll('.layer-row .layer-eye')[0].click()")
    page.wait_for_timeout(400)

    # Blend mode alters the composite.
    before = page.evaluate(SAMPLE)['sig']
    page.select_option('#v-blend','difference'); page.dispatch_event('#v-blend','input')
    page.wait_for_timeout(700)
    assert page.evaluate(SAMPLE)['sig'] != before, 'blend mode had no effect'
    report['blend_works']=True

    # Opacity alters the composite.
    before = page.evaluate(SAMPLE)['sig']
    setv(page,'#v-opacity',25); page.wait_for_timeout(700)
    assert page.evaluate(SAMPLE)['sig'] != before, 'opacity had no effect'
    report['opacity_works']=True

    # Cap at four, and removal works.
    for _ in range(6):
        if page.eval_on_selector('#v-layer-add','e=>e.disabled'): break
        page.click('#v-layer-add'); page.wait_for_timeout(150)
    n = page.locator('.layer-row').count()
    assert n==4, f'layer cap not enforced: {n}'
    assert page.eval_on_selector('#v-layer-add','e=>e.disabled'), 'add button not disabled at cap'
    page.click('#v-layer-del'); page.wait_for_timeout(300)
    assert page.locator('.layer-row').count()==3, 'remove failed'
    report['cap_and_remove']=True

    # Layers survive a reload.
    page.wait_for_timeout(400); page.reload(); page.wait_for_timeout(900)
    assert page.locator('.layer-row').count()==3, 'layers did not persist'
    report['persists']=True

    page.screenshot(path=str(ART/'layers.png'), full_page=False)
    report['screenshot']=str(ART/'layers.png'); report['browser_errors']=errors
    assert not errors, errors
    b.close()
print(json.dumps(report,indent=2))
