from pathlib import Path
from playwright.sync_api import sync_playwright
import tempfile, json

ROOT = Path('/Users/christophercohen/Documents/GitHub/neojutsu')
ART = Path(tempfile.mkdtemp(prefix='neojutsu-fx-'))
GB = {(0x0f,0x38,0x0f),(0x30,0x62,0x30),(0x8b,0xac,0x0f),(0x9b,0xbc,0x0f)}
report = {}
SAMPLE = """() => {
  const c = document.getElementById('v-canvas');
  const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
  const seen=new Set(); let sig=0, dark=0;
  for (let i=0;i<d.length;i+=4){ seen.add(`${d[i]},${d[i+1]},${d[i+2]}`); sig=(sig*31+d[i]+d[i+1]*3+d[i+2]*7)|0;
    if (d[i]+d[i+1]+d[i+2] < 120) dark++; }
  return {w:c.width,h:c.height,colors:[...seen],sig,dark,total:d.length/4};
}"""
def setv(page, sel, val):
    page.evaluate("([s,v])=>{const e=document.querySelector(s); e.value=v; e.dispatchEvent(new Event('input',{bubbles:true}));}", [sel, str(val)])

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=['--autoplay-policy=no-user-gesture-required'])
    page = b.new_context(viewport={"width":1512,"height":1150}).new_page()
    errors=[]; page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(ROOT.as_uri()+'/video.html'); page.wait_for_timeout(800)
    assert not errors, errors

    scenes = page.eval_on_selector_all('#v-scene option','e=>e.map(o=>o.value)')
    report['scene_count'] = len(scenes)
    assert len(scenes) == 13, scenes

    page.select_option('#v-chip','gameboy'); page.dispatch_event('#v-chip','input')
    page.select_option('#v-scene','skyline'); page.dispatch_event('#v-scene','input')
    page.fill('#v-seed','neojutsu'); page.dispatch_event('#v-seed','input')
    page.click('#v-play'); page.wait_for_timeout(600)

    # Frame formats reshape the output for social crops.
    dims={}
    for fmt,expect_portrait in [('native',False),('9:16',True),('1:1',False),('16:9',False)]:
        page.select_option('#v-format',fmt); page.dispatch_event('#v-format','input')
        page.wait_for_timeout(300)
        s=page.evaluate(SAMPLE); dims[fmt]=[s['w'],s['h']]
        if expect_portrait: assert s['w'] < s['h'], f'{fmt} not portrait: {s["w"]}x{s["h"]}'
    assert dims['1:1'][0]==dims['1:1'][1], dims['1:1']
    assert dims['16:9'][0] > dims['16:9'][1], dims['16:9']
    report['formats']=dims

    page.select_option('#v-format','native'); page.dispatch_event('#v-format','input')
    page.wait_for_timeout(300)
    base = page.evaluate(SAMPLE)

    # Vignette must actually darken the frame, and stay on palette.
    setv(page,'#v-vig',90); page.wait_for_timeout(500)
    vig = page.evaluate(SAMPLE)
    assert vig['dark'] > base['dark'], f"vignette did not darken: {base['dark']} -> {vig['dark']}"
    assert not ({tuple(int(n) for n in k.split(',')) for k in vig['colors']} - GB), 'vignette broke the palette'
    report['vignette_dark_px'] = [base['dark'], vig['dark']]
    setv(page,'#v-vig',0); page.wait_for_timeout(300)

    # Every effect must change the picture and none may leave the palette.
    fx_effect={}
    for sel,name in [('#v-bloom','glow'),('#v-glitch','glitch'),('#v-chroma','chroma'),('#v-curve','curve')]:
        before = page.evaluate(SAMPLE)['sig']
        setv(page,sel,80); page.wait_for_timeout(500)
        after = page.evaluate(SAMPLE)
        stray = {tuple(int(n) for n in k.split(',')) for k in after['colors']} - GB
        assert not stray, f'{name} left the palette: {stray}'
        fx_effect[name] = before != after['sig']
        setv(page,sel,0); page.wait_for_timeout(250)
    report['fx_changed_frame']=fx_effect
    assert all(fx_effect.values()), fx_effect

    # Title overlay renders.
    page.wait_for_timeout(300); before = page.evaluate(SAMPLE)['sig']
    page.fill('#v-text','NEO | side a'); page.dispatch_event('#v-text','input')
    page.wait_for_timeout(600)
    after = page.evaluate(SAMPLE)
    assert before != after['sig'], 'title text did not render'
    assert not ({tuple(int(n) for n in k.split(',')) for k in after['colors']} - GB), 'text broke the palette'
    report['text_renders']=True

    # Auto-cut moves between scenes, and the running order is seeded.
    page.fill('#v-text',''); page.dispatch_event('#v-text','input')
    page.select_option('#v-cut','2'); page.dispatch_event('#v-cut','input')
    page.wait_for_timeout(200)
    seen=set()
    for _ in range(28):
        page.wait_for_timeout(250)
        seen.add(page.text_content('#v-meta'))
    report['scenes_seen_while_cutting']=len(seen)
    assert len(seen) >= 2, f'auto-cut never changed scene: {seen}'

    order = page.evaluate("""() => {
      const keys = Object.keys(window.NeoScene.SCENES), r = window.NeoScene.rng('neojutsu:order');
      for (let i=keys.length-1;i>0;i--){const j=Math.floor(r()*(i+1));[keys[i],keys[j]]=[keys[j],keys[i]];}
      return keys;
    }""")
    order2 = page.evaluate("""() => {
      const keys = Object.keys(window.NeoScene.SCENES), r = window.NeoScene.rng('neojutsu:order');
      for (let i=keys.length-1;i>0;i--){const j=Math.floor(r()*(i+1));[keys[i],keys[j]]=[keys[j],keys[i]];}
      return keys;
    }""")
    assert order == order2, 'cut order is not deterministic'
    report['cut_order']=order[:5]

    assert not errors, errors
    report['browser_errors']=errors
    b.close()
print(json.dumps(report, indent=2))
