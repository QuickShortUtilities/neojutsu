from pathlib import Path
from playwright.sync_api import sync_playwright
import tempfile, json
ROOT=Path('/Users/christophercohen/Documents/GitHub/neojutsu')
ART=Path(tempfile.mkdtemp(prefix='neojutsu-tf-'))
GB={(0x0f,0x38,0x0f),(0x30,0x62,0x30),(0x8b,0xac,0x0f),(0x9b,0xbc,0x0f)}
report={}
SIG="""()=>{const c=document.getElementById('v-canvas');
  const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
  const seen=new Set(); let sig=0;
  for(let i=0;i<d.length;i+=4){seen.add(`${d[i]},${d[i+1]},${d[i+2]}`);sig=(sig*31+d[i]+d[i+1]*3+d[i+2]*7)|0;}
  return {sig,colors:[...seen]};}"""
def setv(page,sel,val):
    page.evaluate("([s,v])=>{const e=document.querySelector(s);e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));}",[sel,str(val)])
def pick_scene(page,k):
    page.evaluate("(k)=>{const s=document.getElementById('v-scene');s.value=k;s.dispatchEvent(new Event('input',{bubbles:true}));}",k)

with sync_playwright() as p:
    b=p.chromium.launch(headless=True,args=['--autoplay-policy=no-user-gesture-required'])
    page=b.new_context(viewport={"width":1512,"height":1200}).new_page()
    errors=[]; page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(ROOT.as_uri()+'/video.html'); page.wait_for_timeout(400)
    page.evaluate("localStorage.clear()"); page.reload(); page.wait_for_timeout(900)
    assert not errors, errors
    page.select_option('#v-chip','gameboy'); page.dispatch_event('#v-chip','input')
    page.evaluate("()=>{const d=document.getElementById('v-transform-fold'); if(d) d.open=true;}")
    page.wait_for_timeout(200)

    # Characters: the sprite system must offer several, and each must render.
    chars = page.evaluate("()=>Object.keys(window.NeoScene.CHARS)")
    report['characters']=chars
    assert len(chars) >= 6, chars
    people = page.evaluate("()=>Object.entries(window.NeoScene.SCENES).filter(([k,v])=>v.cat==='people').map(([k])=>k)")
    report['people_scenes']=people
    assert len(people) >= 3, people

    # A second layer transformed must change the picture, per control.
    pick_scene(page,'skyline'); page.wait_for_timeout(700)
    page.click('#v-layer-add'); page.wait_for_timeout(400)
    pick_scene(page,'walker')
    page.evaluate("()=>{const b=document.getElementById('v-layer-bg'); if(b.checked){b.checked=false;b.dispatchEvent(new Event('change',{bubbles:true}));}}")
    page.wait_for_timeout(800)
    moved={}
    for sel,name,val in [('#v-lx','x',60),('#v-ly','y',-40),('#v-lscale','scale',180),('#v-lrot','rotate',25)]:
        before=page.evaluate(SIG)['sig']
        setv(page,sel,val); page.wait_for_timeout(600)
        after=page.evaluate(SIG)
        moved[name]= before != after['sig']
        stray={tuple(int(n) for n in k.split(','))for k in after['colors']} - GB
        assert not stray, f'{name} broke the palette: {stray}'
        setv(page,sel,0 if name!='scale' else 100); page.wait_for_timeout(300)
    report['transform_controls']=moved
    assert all(moved.values()), moved

    # Automation moves a layer with no further input.
    page.select_option('#v-lm-param','x'); page.wait_for_timeout(150)
    page.select_option('#v-lm-shape','sine'); page.wait_for_timeout(500)
    page.click('#v-play'); page.wait_for_timeout(500)
    a=page.evaluate(SIG)['sig']; drift=False
    for _ in range(24):
        page.wait_for_timeout(200)
        if page.evaluate(SIG)['sig']!=a: drift=True; break
    assert drift, 'layer automation did not move anything'
    report['automation_moves']=True
    metas = page.evaluate("()=>[...document.querySelectorAll('.layer-row .layer-meta')].map(e=>e.textContent)")
    report['stack_meta']=metas
    assert any('~' in m for m in metas), f'automated layer not marked in the stack: {metas}'
    report['automation_marked']=True

    # And it survives a reload.
    page.click('#v-play'); page.wait_for_timeout(400)
    page.reload(); page.wait_for_timeout(900)
    m=page.evaluate("()=>document.getElementById('v-lm-shape').value")
    assert m=='sine', f'automation did not persist: {m}'
    report['persists']=True

    page.screenshot(path=str(ART/'transform.png'))
    report['shot']=str(ART/'transform.png'); report['browser_errors']=errors
    assert not errors, errors
    b.close()
print(json.dumps(report,indent=2))
