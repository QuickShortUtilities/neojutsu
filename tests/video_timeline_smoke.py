from pathlib import Path
from playwright.sync_api import sync_playwright
import tempfile, json
ROOT=Path('/Users/christophercohen/Documents/GitHub/neojutsu')
ART=Path(tempfile.mkdtemp(prefix='neojutsu-tl-'))
GB={(0x0f,0x38,0x0f),(0x30,0x62,0x30),(0x8b,0xac,0x0f),(0x9b,0xbc,0x0f)}
report={}
SAMPLE="""() => { const c=document.getElementById('v-canvas');
  const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
  const seen=new Set(); let sig=0;
  for(let i=0;i<d.length;i+=4){seen.add(`${d[i]},${d[i+1]},${d[i+2]}`);sig=(sig*31+d[i]+d[i+1]*3+d[i+2]*7)|0;}
  return {colors:[...seen],sig}; }"""
def setv(page,sel,val):
    page.evaluate("([s,v])=>{const e=document.querySelector(s);e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));}",[sel,str(val)])

with sync_playwright() as p:
    b=p.chromium.launch(headless=True,args=['--autoplay-policy=no-user-gesture-required'])
    page=b.new_context(viewport={"width":1512,"height":1200}).new_page()
    errors=[]; page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(ROOT.as_uri()+'/video.html'); page.wait_for_timeout(400)
    page.evaluate("localStorage.clear()"); page.reload(); page.wait_for_timeout(900)
    assert not errors, errors

    assert page.locator('#v-timeline').is_hidden(), 'timeline should start hidden'
    page.click('#v-tl-toggle'); page.wait_for_timeout(400)
    assert page.locator('#v-timeline').is_visible(), 'timeline did not open'
    n = page.locator('.tl-shot').count()
    assert n == 2, f'expected a starter shot list, got {n}'
    report['starter_shots']=n

    # Shot list drives the project length.
    setv(page,'#v-tl-dur',6); page.wait_for_timeout(300)
    total = page.text_content('#v-tl-total')
    report['total_after_edit']=total
    assert total == '10s', f'length should follow the shots: {total}'
    assert page.text_content('#v-len-v') == '10', page.text_content('#v-len-v')

    # Add / remove shots.
    page.click('#v-tl-add'); page.wait_for_timeout(300)
    assert page.locator('.tl-shot').count()==3, 'add shot failed'
    page.click('#v-tl-del'); page.wait_for_timeout(300)
    assert page.locator('.tl-shot').count()==2, 'delete shot failed'
    report['add_remove']=True

    # Distinct scenes per shot, then confirm the picture actually changes
    # as the playhead crosses the boundary.
    page.select_option('#v-chip','gameboy'); page.dispatch_event('#v-chip','input')
    page.evaluate("document.querySelectorAll('.tl-shot')[0].click()")
    page.select_option('#v-tl-scene','fire'); page.dispatch_event('#v-tl-scene','input')
    setv(page,'#v-tl-dur',2)
    page.evaluate("document.querySelectorAll('.tl-shot')[1].click()")
    page.select_option('#v-tl-scene','bars'); page.dispatch_event('#v-tl-scene','input')
    setv(page,'#v-tl-dur',2)
    page.wait_for_timeout(300)

    page.click('#v-play'); page.wait_for_timeout(600)
    metas=set()
    for _ in range(30):
        page.wait_for_timeout(220)
        metas.add(page.text_content('#v-meta'))
    report['scenes_during_playback']=sorted(m.split('·')[-1].strip() for m in metas)
    assert len(metas) >= 2, f'timeline never cut: {metas}'

    frame = page.evaluate(SAMPLE)
    stray = {tuple(int(x) for x in k.split(','))for k in frame['colors']} - GB
    assert not stray, f'timeline playback broke the palette: {stray}'

    # Playhead advances.
    l1 = page.eval_on_selector('#v-tl-playhead','e=>e.style.left')
    page.wait_for_timeout(700)
    l2 = page.eval_on_selector('#v-tl-playhead','e=>e.style.left')
    assert l1 != l2, 'playhead did not move'
    report['playhead_moves']=True

    # A caption on a shot overrides the global title.
    page.click('#v-play'); page.wait_for_timeout(300)
    page.evaluate("document.querySelectorAll('.tl-shot')[0].click()")
    before = page.evaluate(SAMPLE)['sig']
    page.fill('#v-tl-text','SHOT ONE'); page.dispatch_event('#v-tl-text','input')
    page.evaluate("()=>{window.scrollTo(0,0)}")
    page.wait_for_timeout(200)
    page.evaluate("()=>{const s=document.getElementById('v-scrub'); s.value=0; s.dispatchEvent(new Event('input',{bubbles:true}));}")
    page.wait_for_timeout(600)
    after = page.evaluate(SAMPLE)['sig']
    assert before != after, 'shot caption did not render'
    report['shot_caption']=True

    # Survives a reload.
    page.wait_for_timeout(400); page.reload(); page.wait_for_timeout(900)
    assert page.locator('#v-timeline').is_visible(), 'timeline state did not persist'
    assert page.locator('.tl-shot').count()==2, 'shots did not persist'
    report['persists']=True

    page.screenshot(path=str(ART/'timeline.png'), full_page=False)
    report['screenshot']=str(ART/'timeline.png'); report['browser_errors']=errors
    assert not errors, errors
    b.close()
print(json.dumps(report,indent=2))
