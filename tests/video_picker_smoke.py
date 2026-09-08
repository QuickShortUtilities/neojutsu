from pathlib import Path
from playwright.sync_api import sync_playwright
import tempfile, json
ROOT=Path('/Users/christophercohen/Documents/GitHub/neojutsu')
ART=Path(tempfile.mkdtemp(prefix='neojutsu-picker-'))
GB={(0x0f,0x38,0x0f),(0x30,0x62,0x30),(0x8b,0xac,0x0f),(0x9b,0xbc,0x0f)}
report={}
with sync_playwright() as p:
    b=p.chromium.launch(headless=True,args=['--autoplay-policy=no-user-gesture-required'])
    page=b.new_context(viewport={"width":1512,"height":1200}).new_page()
    errors=[]; page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(ROOT.as_uri()+'/video.html'); page.wait_for_timeout(400)
    page.evaluate("localStorage.clear()"); page.reload(); page.wait_for_timeout(900)
    assert not errors, errors
    page.select_option('#v-chip','gameboy'); page.dispatch_event('#v-chip','input')

    assert page.locator('#v-picker').is_hidden(), 'picker should start closed'
    page.click('#v-scene-open'); page.wait_for_timeout(1200)
    assert page.locator('#v-picker').is_visible(), 'picker did not open'
    tiles = page.locator('.picker-tile').count()
    report['tiles']=tiles
    assert tiles==29, tiles

    # Every thumbnail must render real, on-palette footage - a preview that
    # lies about the look is worse than no preview.
    stats = page.evaluate("""() => {
      const out=[];
      for (const c of document.querySelectorAll('.picker-tile canvas')) {
        const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
        const seen=new Set();
        for(let i=0;i<d.length;i+=4) seen.add(`${d[i]},${d[i+1]},${d[i+2]}`);
        out.push({w:c.width,h:c.height,colors:[...seen]});
      }
      return out;
    }""")
    blank=[i for i,s in enumerate(stats) if len(s['colors'])<2]
    assert not blank, f'blank thumbnails at {blank}'
    stray=set()
    for s in stats:
        stray |= {tuple(int(n) for n in k.split(','))for k in s['colors']} - GB
    assert not stray, f'thumbnails off-palette: {stray}'
    report['thumb_size']=[stats[0]['w'],stats[0]['h']]
    report['all_thumbs_live']=True

    # Category tabs narrow the grid to a genre.
    cats = page.locator('.picker-cat').count()
    report['categories']=cats
    assert cats >= 10, cats
    page.evaluate("()=>[...document.querySelectorAll('.picker-cat')].find(b=>b.textContent.includes('RPG')).click()")
    page.wait_for_timeout(700)
    rpg = page.locator('.picker-tile').count()
    report['rpg_tiles']=rpg
    assert 1 <= rpg < 29, f'RPG tab showed {rpg} tiles'
    page.evaluate("()=>[...document.querySelectorAll('.picker-cat')].find(b=>b.textContent.includes('All')).click()")
    page.wait_for_timeout(500)
    assert page.locator('.picker-tile').count()==29, 'All tab did not restore the full grid'

    # Filter narrows the grid.
    page.fill('#v-picker-search','fire'); page.wait_for_timeout(500)
    n=page.locator('.picker-tile').count()
    report['filtered']=n
    assert 1<=n<3, f'filter returned {n}'
    page.fill('#v-picker-search',''); page.wait_for_timeout(500)

    # Choosing a tile sets the layer scene and closes.
    page.evaluate("""()=>{const t=[...document.querySelectorAll('.picker-tile')]
      .find(e=>e.textContent.toLowerCase().includes('kaleido')); t.click();}""")
    page.wait_for_timeout(500)
    assert page.locator('#v-picker').is_hidden(), 'picker did not close on choose'
    assert page.eval_on_selector('#v-scene','e=>e.value')=='kaleido', page.eval_on_selector('#v-scene','e=>e.value')
    assert 'Kaleido' in page.text_content('#v-scene-name'), page.text_content('#v-scene-name')
    report['choose_works']=True

    # Double-clicking a layer row opens the picker for that layer.
    page.click('#v-layer-add'); page.wait_for_timeout(400)
    page.evaluate("()=>document.querySelectorAll('.layer-row')[0].dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))")
    page.wait_for_timeout(900)
    assert page.locator('#v-picker').is_visible(), 'double-click did not open the picker'
    heading = page.text_content('#v-picker-title')
    assert 'LAYER' in heading, heading
    report['dblclick_opens_picker'] = heading
    # It must act on the row that was double-clicked.
    top_index = page.evaluate("()=>[...document.querySelectorAll('.layer-row')].findIndex(r=>r.classList.contains('current'))")
    assert top_index == 0, f'double-click did not select that row: {top_index}'
    page.evaluate("()=>{const t=[...document.querySelectorAll('.picker-tile')].find(e=>e.textContent.toLowerCase().includes('tunnel')); t.click();}")
    page.wait_for_timeout(500)
    assert page.eval_on_selector('#v-scene','e=>e.value')=='tunnel', 'choice did not apply to that layer'
    report['dblclick_choice_applies']=True
    # Clicking the eye must not hijack into the picker.
    page.evaluate("()=>document.querySelectorAll('.layer-row .layer-eye')[0].dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))")
    page.wait_for_timeout(500)
    assert page.locator('#v-picker').is_hidden(), 'double-click on the eye opened the picker'
    report['eye_not_hijacked']=True

    # The Look controls moved out of the sidebar into the middle column.
    assert page.locator('.lookbar .look-grid').count()==1, 'look bar missing'
    inside = page.evaluate("()=>!!document.querySelector('.stage .lookbar')")
    assert inside, 'look bar is not in the centre column'
    report['look_moved']=True

    # Sidebar should now be far shorter than before the move.
    h = page.evaluate("()=>Math.round(document.querySelector('.panel.gen').getBoundingClientRect().height)")
    report['sidebar_height']=h
    assert h < 1000, f'sidebar still very long: {h}px'

    page.screenshot(path=str(ART/'layout.png'), full_page=False)
    page.click('#v-scene-open'); page.wait_for_timeout(1200)
    page.screenshot(path=str(ART/'picker.png'), full_page=False)
    report['shots']=[str(ART/'layout.png'),str(ART/'picker.png')]
    report['browser_errors']=errors
    assert not errors, errors
    b.close()
print(json.dumps(report,indent=2))
