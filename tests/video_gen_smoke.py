from pathlib import Path
from playwright.sync_api import sync_playwright
import tempfile, json

ROOT = Path('/Users/christophercohen/Documents/GitHub/neojutsu')
ART = Path(tempfile.mkdtemp(prefix='neojutsu-gen-'))
GB = {(0x0f,0x38,0x0f),(0x30,0x62,0x30),(0x8b,0xac,0x0f),(0x9b,0xbc,0x0f)}
report = {}

SAMPLE = """() => {
  const c = document.getElementById('v-canvas');
  const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
  const seen = new Set(); let sig = 0;
  for (let i=0;i<d.length;i+=4){ seen.add(`${d[i]},${d[i+1]},${d[i+2]}`); sig = (sig*31 + d[i]+d[i+1]*3+d[i+2]*7)|0; }
  return {colors:[...seen], sig};
}"""

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=['--autoplay-policy=no-user-gesture-required'])
    page = b.new_context(viewport={"width":1512,"height":1150}).new_page()
    errors=[]; page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(ROOT.as_uri()+'/video.html'); page.wait_for_timeout(700)
    assert not errors, errors

    # Default mode is generate, so there is footage with no upload at all.
    assert page.eval_on_selector('#v-mode','e=>e.value') == 'generate'
    scenes = page.eval_on_selector_all('#v-scene option','els=>els.map(o=>o.value)')
    report['scenes'] = scenes
    assert len(scenes) >= 8, scenes

    page.select_option('#v-chip','gameboy'); page.dispatch_event('#v-chip','input')
    page.click('#v-play'); page.wait_for_timeout(400)

    # Every scene must render real, palette-locked, non-blank footage.
    per_scene = {}
    for sc in scenes:
        page.select_option('#v-scene', sc); page.dispatch_event('#v-scene','input')
        # Poll rather than guess a render time; under load a fixed wait can
        # sample before the first frame has been drawn.
        got = set()
        for _ in range(20):
            page.wait_for_timeout(150)
            s = page.evaluate(SAMPLE)
            got = {tuple(int(n) for n in k.split(',')) for k in s['colors']}
            if len(got) >= 2:
                break
        stray = got - GB
        assert not stray, f'{sc}: off-palette pixels {stray}'
        assert len(got) >= 2, f'{sc}: rendered a blank frame ({len(got)} colour)'
        per_scene[sc] = len(got)
    report['scene_colors'] = per_scene

    # Motion: the frame must actually change over time.
    page.select_option('#v-scene','starfield'); page.dispatch_event('#v-scene','input')
    page.wait_for_timeout(300)
    a = page.evaluate(SAMPLE)['sig']; moved = False
    for _ in range(20):
        page.wait_for_timeout(150)
        if page.evaluate(SAMPLE)['sig'] != a: moved = True; break
    assert moved, 'scene is static - animation not advancing'
    report['animates'] = True

    # Seeds behave like Audio Studio seeds: same seed reproduces, dice changes it.
    page.click('#v-play')  # stop, so time is frozen and only the seed varies
    page.wait_for_timeout(200)
    def frame_for(seed):
        page.fill('#v-seed', seed); page.dispatch_event('#v-seed','input')
        page.wait_for_timeout(350)
        return page.evaluate(SAMPLE)['sig']
    s1 = frame_for('abc123'); s2 = frame_for('zzz999'); s3 = frame_for('abc123')
    report['seed'] = {'abc123': s1, 'zzz999': s2, 'abc123_again': s3}
    assert s1 == s3, 'same seed did not reproduce the same frame'
    assert s1 != s2, 'different seeds produced identical frames'

    page.click('#v-dice'); page.wait_for_timeout(150)
    assert page.eval_on_selector('#v-seed','e=>e.value') != 'abc123', 'dice did not change the seed'

    # Palette switch still governs generated footage.
    page.select_option('#v-chip','c64'); page.dispatch_event('#v-chip','input')
    page.wait_for_timeout(400)
    dims = page.evaluate("[document.getElementById('v-canvas').width, document.getElementById('v-canvas').height]")
    assert dims == [320,200], dims
    report['c64_dims'] = dims

    page.screenshot(path=str(ART/'gen.png'), full_page=False)
    report['screenshot']=str(ART/'gen.png'); report['browser_errors']=errors
    assert not errors, errors
    b.close()
print(json.dumps(report, indent=2))
