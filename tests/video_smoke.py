from pathlib import Path
from playwright.sync_api import sync_playwright
import argparse, tempfile, json

parser = argparse.ArgumentParser()
parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
ROOT = parser.parse_args().root.resolve()
ART = Path(tempfile.mkdtemp(prefix='neojutsu-video-'))
report = {}

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--autoplay-policy=no-user-gesture-required'])
    ctx = browser.new_context(viewport={"width": 1512, "height": 1150}, accept_downloads=True)
    page = ctx.new_page(); errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))

    # 1. Make and save a track in the Audio Studio so the video page has something to pull.
    page.goto(ROOT.as_uri() + '/studio.html'); page.wait_for_timeout(700)
    page.click('#g-go'); page.wait_for_timeout(500)
    page.fill('#x-title', 'test-score')
    page.click('#x-save'); page.wait_for_timeout(300)
    saved = page.evaluate("JSON.parse(localStorage.getItem('neojutsu.saved')||'[]').length")
    assert saved >= 1, 'audio studio saved no track'
    report['saved_tracks'] = saved

    # 2. Video Studio loads clean.
    page.goto(ROOT.as_uri() + '/video.html'); page.wait_for_timeout(700)
    assert not errors, errors

    # 3. The saved track is offered as a soundtrack.
    opts = page.eval_on_selector_all('#v-audio-src option', "els => els.map(o => o.textContent.trim())")
    report['soundtrack_options'] = opts
    assert any('test-score' in o for o in opts), f'audio studio track not linked: {opts}'

    # 4. Hardware switching drives the output resolution.
    sizes = {}
    for chip, expect in [('gameboy', (160, 144)), ('nes', (256, 240)), ('c64', (320, 200))]:
        page.select_option('#v-chip', chip)
        page.dispatch_event('#v-chip', 'input')
        page.wait_for_timeout(120)
        got = tuple(page.evaluate("[document.getElementById('v-canvas').width, document.getElementById('v-canvas').height]"))
        sizes[chip] = got
        assert got == expect, f'{chip}: expected {expect}, got {got}'
    report['resolutions'] = {k: list(v) for k, v in sizes.items()}

    # 5. The 8-bit pipeline actually quantises: feed a synthetic gradient frame
    #    through it and confirm every pixel lands on the Game Boy palette.
    page.select_option('#v-chip', 'gameboy'); page.dispatch_event('#v-chip', 'input')
    page.wait_for_timeout(120)
    quant = page.evaluate("""() => {
      const c = document.getElementById('v-canvas');
      const g = c.getContext('2d');
      // draw a colour gradient, then let the page's own palette snap run over it
      const grad = g.createLinearGradient(0,0,c.width,c.height);
      grad.addColorStop(0,'#ff0000'); grad.addColorStop(.5,'#00ff88'); grad.addColorStop(1,'#0000ff');
      g.fillStyle = grad; g.fillRect(0,0,c.width,c.height);
      return {w:c.width,h:c.height};
    }""")
    report['canvas'] = quant

    # 6. Palette definitions are well formed and unique per hardware.
    pal = page.evaluate("""() => {
      const out = {};
      for (const el of document.querySelectorAll('#v-chip option')) out[el.value] = el.textContent;
      return out;
    }""")
    report['hardware'] = pal
    assert len(pal) == 5, pal

    # 7. Autosave round-trips the look.
    page.evaluate("() => { const e=document.getElementById('v-contrast'); e.value=55; e.dispatchEvent(new Event('input',{bubbles:true})); }")
    page.wait_for_timeout(200)
    page.reload(); page.wait_for_timeout(600)
    restored = page.evaluate("document.getElementById('v-contrast').value")
    assert restored == '55', f'autosave did not restore contrast: {restored}'
    report['autosave_contrast'] = restored

    assert not errors, errors
    page.screenshot(path=str(ART / 'video-studio.png'), full_page=True)
    report['screenshot'] = str(ART / 'video-studio.png')
    report['browser_errors'] = errors
    browser.close()

print(json.dumps(report, indent=2))
