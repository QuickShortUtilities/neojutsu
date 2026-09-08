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

    # Layers must genuinely compose: a scene stacked over another has to let
    # the one below show through, not repaint the frame.
    STRIP = ("(frac)=>{const c=document.getElementById('v-canvas');"
             "const H=Math.round(c.height*frac);"
             "const d=c.getContext('2d').getImageData(0,0,c.width,H).data;"
             "let sig=0; for(let i=0;i<d.length;i+=4) sig=(sig*31+d[i]+d[i+1]*3+d[i+2]*7)|0; return sig;}")
    while page.locator('.layer-row').count() > 1:
        page.click('#v-layer-del'); page.wait_for_timeout(200)
    pick_scene(page,'skyline'); page.wait_for_timeout(800)
    sky_top = page.evaluate(STRIP, 0.35); sky_all = page.evaluate(STRIP, 1.0)
    page.click('#v-layer-add'); page.wait_for_timeout(400)
    pick_scene(page,'road')
    page.evaluate("()=>{const b=document.getElementById('v-layer-bg'); if(b.checked){b.checked=false;b.dispatchEvent(new Event('change',{bubbles:true}));}}")
    page.evaluate("()=>{const s=document.getElementById('v-blend');s.value='source-over';s.dispatchEvent(new Event('input',{bubbles:true}));}")
    page.evaluate("()=>{const o=document.getElementById('v-opacity');o.value=100;o.dispatchEvent(new Event('input',{bubbles:true}));}")
    page.wait_for_timeout(1000)
    comp_top = page.evaluate(STRIP, 0.35); comp_all = page.evaluate(STRIP, 1.0)
    assert comp_all != sky_all, 'stacked scene made no difference'
    assert comp_top == sky_top, 'upper layer repainted the sky instead of composing'
    report['composes']=True
    assert page.locator('#v-layer-warn').is_hidden(), 'warned about a stack that is fine'
    # Turning the background back on must hide the base, and say so.
    page.evaluate("()=>{const b=document.getElementById('v-layer-bg'); b.checked=true; b.dispatchEvent(new Event('change',{bubbles:true}));}")
    page.wait_for_timeout(800)
    assert page.evaluate(STRIP, 0.35) != sky_top, 'background flag had no effect'
    assert not page.locator('#v-layer-warn').is_hidden(), 'no warning when a layer hides the stack'
    report['warns_when_covering']=True
    page.evaluate("()=>{const b=document.getElementById('v-layer-bg'); b.checked=false; b.dispatchEvent(new Event('change',{bubbles:true}));}")
    page.wait_for_timeout(300)

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
