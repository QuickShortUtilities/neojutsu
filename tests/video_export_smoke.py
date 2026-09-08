from pathlib import Path
from playwright.sync_api import sync_playwright
import tempfile, json, time
ROOT=Path('/Users/christophercohen/Documents/GitHub/neojutsu')
ART=Path(tempfile.mkdtemp(prefix='neojutsu-export-'))
report={}
def pick_scene(page, key):
    page.evaluate("(k)=>{const s=document.getElementById('v-scene'); s.value=k; s.dispatchEvent(new Event('input',{bubbles:true}));}", key)
def setv(page,sel,val):
    page.evaluate("([s,v])=>{const e=document.querySelector(s);e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));}",[sel,str(val)])

with sync_playwright() as p:
    b=p.chromium.launch(headless=True,args=['--autoplay-policy=no-user-gesture-required'])
    ctx=b.new_context(viewport={"width":1512,"height":1000},accept_downloads=True)
    page=ctx.new_page(); errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))

    # A saved track, so the AAC path gets exercised too.
    page.goto(ROOT.as_uri()+'/studio.html'); page.wait_for_timeout(700)
    page.click('#g-go'); page.wait_for_timeout(500)
    page.fill('#x-title','score'); page.click('#x-save'); page.wait_for_timeout(300)

    page.goto(ROOT.as_uri()+'/video.html'); page.wait_for_timeout(800)
    assert not errors, errors
    page.select_option('#v-chip','gameboy'); page.dispatch_event('#v-chip','input')
    pick_scene(page,'grid')
    setv(page,'#v-container','mp4')
    setv(page,'#v-fps',24); setv(page,'#v-scale',2); setv(page,'#v-len',5)
    page.wait_for_timeout(300)

    # --- silent MP4 ---
    t0=time.time()
    with page.expect_download(timeout=180000) as dl:
        page.click('#v-open-export'); page.wait_for_timeout(350); page.click('#v-x-go')
    path=ART/'silent.mp4'; dl.value.save_as(str(path))
    page.evaluate("()=>document.getElementById('v-export-dialog').close()"); page.wait_for_timeout(200)
    elapsed=time.time()-t0
    data=path.read_bytes()
    assert data[4:8]==b'ftyp', f'not an MP4: {data[:12]!r}'
    assert b'avc1' in data[:4096] or b'avcC' in data, 'no H.264 track found'
    report['silent_mp4']={'bytes':len(data),'seconds_to_render':round(elapsed,1),'video_length_s':5,
                          'faster_than_realtime': elapsed < 5}
    assert len(data) > 5000, f'suspiciously small: {len(data)}'

    # --- MP4 with the Audio Studio soundtrack ---
    opts=page.eval_on_selector_all('#v-audio-src option','e=>e.map(o=>o.value)')
    track=[o for o in opts if o.startswith('saved:')][0]
    page.select_option('#v-audio-src',track); page.wait_for_timeout(1500)
    length=page.text_content('#v-len-v')
    t0=time.time()
    with page.expect_download(timeout=300000) as dl2:
        page.click('#v-open-export'); page.wait_for_timeout(350); page.click('#v-x-go')
    path2=ART/'scored.mp4'; dl2.value.save_as(str(path2))
    page.evaluate("()=>document.getElementById('v-export-dialog').close()"); page.wait_for_timeout(200)
    elapsed2=time.time()-t0
    d2=path2.read_bytes()
    assert d2[4:8]==b'ftyp', 'scored export is not an MP4'
    assert b'mp4a' in d2, 'no AAC audio track in the scored export'
    report['scored_mp4']={'bytes':len(d2),'seconds_to_render':round(elapsed2,1),
                          'video_length_s':int(length),'faster_than_realtime': elapsed2 < int(length)}
    assert report['scored_mp4']['faster_than_realtime'], 'MP4 export was not faster than real time'

    # A seed has to reproduce the footage. The video pipeline is checked for
    # exact reproduction on a silent export - MP4 headers carry a creation
    # timestamp at one-second resolution, so those few bytes are excluded and
    # the entire encoded payload must match. Scored exports are only bounded by
    # size, because the browser's AAC encoder is not bit-reproducible.
    page.select_option('#v-audio-src','none'); page.wait_for_timeout(800)
    outs=[]
    for i in range(2):
        with page.expect_download(timeout=300000) as d:
            page.click('#v-open-export'); page.wait_for_timeout(350); page.click('#v-x-go')
        f=ART/f'repeat{i}.mp4'; d.value.save_as(str(f)); outs.append(f.read_bytes())
        page.evaluate("()=>document.getElementById('v-export-dialog').close()"); page.wait_for_timeout(200)
    a, c = outs
    assert len(a) == len(c), f'silent export lengths differ: {len(a)} vs {len(c)}'
    diffs = [i for i, (x, y) in enumerate(zip(a, c)) if x != y]
    assert all(i < 1024 for i in diffs), f'video differs outside the header at {[i for i in diffs if i>=1024][:8]}'
    assert len(diffs) <= 8, f'{len(diffs)} bytes differ between identical silent exports'
    report['deterministic_video'] = {'differing_bytes': len(diffs), 'confined_to_header': True}

    report['files']=[str(path),str(path2)]
    report['browser_errors']=errors
    assert not errors, errors
    b.close()
print(json.dumps(report,indent=2))
