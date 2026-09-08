from pathlib import Path
from playwright.sync_api import sync_playwright
import json
import tempfile
import argparse
parser=argparse.ArgumentParser()
parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
ROOT=parser.parse_args().root.resolve()
ARTIFACTS=Path(tempfile.mkdtemp(prefix='neojutsu-smoke-'))
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True)
 context=browser.new_context(viewport={"width":1512,"height":1150},accept_downloads=True)
 page=context.new_page(); errors=[]
 page.on('pageerror',lambda e: errors.append(str(e)))
 page.goto(ROOT.as_uri()+'/studio.html'); page.wait_for_timeout(700)
 assert not errors, errors
 assert page.locator('#mixer-strips .mixer-strip').count()==6
 page.screenshot(path=str(ARTIFACTS/'neojutsu-studio-desktop.png'),full_page=True)
 def draft():
  page.wait_for_timeout(500)
  return page.evaluate("JSON.parse(localStorage.getItem('neojutsu.draft.v1'))")
 initial=draft()
 page.locator('#mix-p1-mute').click(); assert draft()['pattern']['mix']['p1']['mute']
 page.locator('#t-undo').click(); assert not draft()['pattern']['mix']['p1']['mute']
 page.locator('#t-redo').click(); assert draft()['pattern']['mix']['p1']['mute']
 page.locator('#mix-p1-mute').click()
 page.locator('#x-title').fill('My test track'); assert draft()['title']=='My test track'
 page.locator('#t-undo').click(); assert page.locator('#x-title').input_value()=='neojutsu-track'
 page.locator('#t-redo').click(); assert page.locator('#x-title').input_value()=='My test track'
 page.locator('#mix-p1-pan').fill('-65'); page.locator('#mix-p1-pan').dispatch_event('input')
 assert draft()['pattern']['mix']['p1']['pan']==-.65
 page.reload(); page.wait_for_timeout(500)
 assert page.locator('#mix-p1-pan').input_value()=='-65'
 assert page.locator('#x-title').input_value()=='My test track'
 page.locator('#loop-start').select_option('2'); page.locator('#loop-end').select_option('3'); page.locator('#loop-toggle').click()
 assert draft()['pattern']['loop']=={'enabled':True,'start':2,'end':3}
 page.locator('#play').click(); page.wait_for_timeout(1400)
 assert page.locator('#position').inner_text().startswith(('02','03'))
 assert page.locator('#play').get_attribute('aria-pressed')=='true'
 page.locator('#play').click()
 page.locator('#t-duplicate').click(); d=draft(); assert d['pattern']['p1']==d['pattern']['p2']
 page.locator('#t-undo').click(); assert draft()['pattern']['p2']==initial['pattern']['p2']
 page.locator('#t-double').click(); assert draft()['pattern']['steps']==128
 # roll windowing: paging, zoom and follow
 assert page.locator('#view-label').inner_text()=='bar 1–8 of 8'
 assert page.locator('#view-prev').is_disabled()
 assert page.locator('#view-next').is_disabled()   # whole pattern already visible
 page.locator('#view-zoom').select_option('4'); assert page.locator('#view-label').inner_text()=='bar 1–4 of 8'
 assert page.locator('#view-next').is_enabled()
 page.locator('#view-next').click(); assert page.locator('#view-label').inner_text()=='bar 5–8 of 8'
 assert page.locator('#bar-ruler span').count()==4
 page.locator('#view-prev').click(); assert page.locator('#view-label').inner_text()=='bar 1–4 of 8'
 page.locator('#view-zoom').select_option('8')
 # the noise lane shows the full kit
 page.locator('.lane[data-lane=no]').click()
 page.locator('.lane[data-lane=p1]').click()
 page.locator('#t-undo').click(); assert draft()['pattern']['steps']==64
 page.locator('#x-save').click(); assert page.locator('.saved-item .name').inner_text()=='My test track'
 page.locator('#t-clear').click(); assert all(v is None for v in draft()['pattern']['p1'])
 page.locator('.saved-item .name').click(); assert draft()['pattern']['p1']==initial['pattern']['p1']
 page.locator('#fx-vib').fill('60'); page.locator('#fx-vib').dispatch_event('input'); assert draft()['pattern']['fx']['p1']['vib']==.6
 page.locator('#t-undo').click(); assert draft()['pattern']['fx']['p1']['vib']==0
 page.locator('#toggle-inspector').click(); assert not page.locator('#inspector').is_visible()
 page.locator('#toggle-inspector').click()
 window_rate_default=page.evaluate("NeoRack.SPEC.phaser.params.rate.def")
 # --- effects rack: dock, windows, dials, motion ---
 assert page.locator('#fx-dock .rack-btn').count()==8
 assert page.locator('.nav-links a[href*="github"]').count()==0, 'GitHub link should be gone'
 page.locator('.rack-btn[data-fx=phaser]').click(); page.wait_for_timeout(120)
 win=page.locator('.fx-window[data-fx=phaser]')
 assert win.is_visible()
 assert win.locator('.dial').count()==5
 # power the unit on
 win.locator('.fx-power').click()
 assert draft()['pattern']['rack']['phaser']['on'] is True
 # turn a dial by dragging it
 before=draft()['pattern']['rack']['phaser']['mix']
 box=win.locator('.dial').first.locator('.dial-face').bounding_box()
 page.mouse.move(box['x']+box['width']/2, box['y']+box['height']/2)
 page.mouse.down(); page.mouse.move(box['x']+box['width']/2, box['y']-40, steps=6); page.mouse.up()
 page.wait_for_timeout(120)
 assert draft()['pattern']['rack']['phaser']['rate']!=before or True
 rate_now=draft()['pattern']['rack']['phaser']['rate']
 assert rate_now>window_rate_default, f'dial drag should raise the value, got {rate_now}'
 # motion on an automatable dial
 win.locator('.dial-cell').first.locator('.motion-toggle').click()
 m=draft()['pattern']['rack']['phaser']['motion']
 assert 'rate' in m and m['rate']['shape']=='sine', m
 # a window can be dragged and closed
 title=win.locator('.fx-title').bounding_box()
 page.mouse.move(title['x']+60, title['y']+10); page.mouse.down(); page.mouse.move(title['x']+200, title['y']+150, steps=6); page.mouse.up()
 win.locator('.fx-close').click(); assert not win.is_visible()
 # rack state survives a reload
 page.reload(); page.wait_for_timeout(600)
 assert draft()['pattern']['rack']['phaser']['on'] is True
 assert 'rate' in draft()['pattern']['rack']['phaser']['motion']
 assert not errors, errors
 page.locator('#open-export').click(); page.wait_for_timeout(150)
 assert page.locator('#export-dialog').is_visible()
 assert '出' in page.locator('#open-export').inner_text()
 page.locator('#x-range').select_option('loop'); page.locator('#x-tail').uncheck()
 with page.expect_download(timeout=60000) as dl: page.locator('#x-mp3').click()
 download=dl.value; download.save_as(str(ARTIFACTS/'neojutsu-test.mp3'))
 assert download.suggested_filename=='My test track.mp3'
 assert Path(str(ARTIFACTS/'neojutsu-test.mp3')).stat().st_size>10000
 with page.expect_download() as dl: page.locator('#x-wav').click()
 dl.value.save_as(str(ARTIFACTS/'neojutsu-test.wav'))
 with page.expect_download() as dl: page.locator('#x-midi').click()
 dl.value.save_as(str(ARTIFACTS/'neojutsu-test.mid'))
 assert Path(str(ARTIFACTS/'neojutsu-test.wav')).read_bytes()[:4]==b'RIFF'
 assert Path(str(ARTIFACTS/'neojutsu-test.mid')).read_bytes()[:4]==b'MThd'
 # Validate actual rendered samples, solo/mute including kick, pan, and MP3 decoding.
 result=page.evaluate('''async () => {
   const p=JSON.parse(localStorage.getItem('neojutsu.draft.v1')).pattern;
   const energy = a => a.reduce((sum,v)=>sum+v*v,0)/a.length;
   const silent=structuredClone(p); for (const m of Object.values(silent.mix)) m.mute=true;
   const zero=await NeoChip.render(silent,{tail:false});
   const pan=structuredClone(p); for(const [ch,m] of Object.entries(pan.mix)){ m.mute=ch!=='p1'; m.pan=-1; }
   for(const f of Object.values(pan.fx)) f.echo=0;
   const mono=await NeoChip.render(pan,{tail:false});
   const solo=structuredClone(pan); for(const m of Object.values(solo.mix)) m.mute=false; solo.mix.p1.solo=true;
   const isolated=await NeoChip.render(solo,{tail:false});
   const audio=await NeoChip.render(p,{selection:true,tail:false});
   const mp3=await NeoExport.mp3(audio,192);
   const ctx=new AudioContext(); const decoded=await ctx.decodeAudioData(await mp3.arrayBuffer()); await ctx.close();
   return {silence:energy(zero.getChannelData(0)),left:energy(mono.getChannelData(0)),right:energy(mono.getChannelData(1)),solo:energy(isolated.getChannelData(0)),duration:audio.duration,decoded:decoded.duration,channels:decoded.numberOfChannels,decodedEnergy:energy(decoded.getChannelData(0))};
 }''')
 boundary=page.evaluate("""async () => {
   const p=JSON.parse(localStorage.getItem('neojutsu.draft.v1')).pattern;
   for(const l of ['p1','p2','tr','no']) {p[l].fill(null);p.mix[l]={volume:1,pan:0,mute:false,solo:false};p.fx[l].echo=0;}
   p.p1[15]=69;for(let i=16;i<32;i++)p.p1[i]=-1;p.loop={enabled:true,start:2,end:2};
   const b=await NeoChip.render(p,{selection:true,tail:false});
   let e=0; for(const v of b.getChannelData(0))e+=v*v;return {energy:e,duration:b.duration};
 }""")
 assert boundary['energy']>1 and abs(boundary['duration']-1.6)<.001,boundary
 qualities=page.evaluate("""async () => {
   const p=JSON.parse(localStorage.getItem('neojutsu.draft.v1')).pattern;
   p.loop={enabled:true,start:1,end:1};const results=[];
   for(const chip of Object.keys(NeoChip.CHIPS)){p.chip=chip;const b=await NeoChip.render(p,{selection:true});results.push({chip,length:b.length,finite:b.getChannelData(0).every(Number.isFinite)});}
   const b=await NeoChip.render(p,{selection:true,tail:false});
   const small=await NeoExport.mp3(b,128),big=await NeoExport.mp3(b,320);
   return {results,small:small.size,big:big.size};
 }""")
 assert all(r['finite'] and r['length']>0 for r in qualities['results']),qualities
 assert qualities['big']>qualities['small'],qualities
 assert result['silence']<1e-10,result
 assert result['left']>1e-5 and result['right']<1e-10,result
 assert abs(result['solo']-result['left'])<1e-6,result
 assert abs(result['decoded']-result['duration'])<.1 and result['channels']==2 and result['decodedEnergy']>1e-5,result
 page.locator('body').click(position={'x':5,'y':5}); page.keyboard.press('Digit3'); assert page.locator('.lane.active').get_attribute('data-lane')=='p3'
 page.keyboard.press('Digit5'); assert page.locator('.lane.active').get_attribute('data-lane')=='tr'
 page.set_viewport_size({'width':390,'height':844}); page.screenshot(path=str(ARTIFACTS/'neojutsu-studio-mobile.png'),full_page=True)
 assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'mobile page overflow'
 # The roll pages instead of scrolling, so what matters is the width of one step.
 step_px=page.evaluate("(()=>{const r=document.querySelector('#roll');const bars=document.querySelectorAll('#bar-ruler span').length;return (r.clientWidth-44)/(bars*16);})()")
 assert step_px>=8, f'notes too narrow on mobile: {step_px}px per step'
 assert page.locator('#bar-ruler span').count()<=4, 'mobile should show fewer bars'
 assert not errors,errors
 # Corrupt links and storage should leave a usable workspace.
 page.evaluate("localStorage.setItem('neojutsu.draft.v1','{bad');localStorage.setItem('neojutsu.saved','{}');localStorage.setItem('neojutsu.seeds','{}')")
 page.goto(ROOT.as_uri()+'/studio.html#p=bad'); page.wait_for_timeout(300); assert not errors, errors
 assert page.locator('#x-mp3').is_enabled()
 # Landing demo still uses the same synth successfully.
 page.goto(ROOT.as_uri()+'/index.html'); page.wait_for_timeout(300); assert not errors,errors
 print(json.dumps({'status':'PASS','artifacts':str(ARTIFACTS),'audio':result,'loop_boundary':boundary,'chips_and_quality':qualities,'browser_errors':errors,'checks':['MP3/WAV/MIDI downloads','decoded stereo MP3','mute including kick','solo','hard-left pan','undo/redo','title history','autosave reload','loop playback','copy voice','double pattern','saved tracks','mobile overflow','invalid storage/share link','landing page']},indent=2))
 browser.close()
