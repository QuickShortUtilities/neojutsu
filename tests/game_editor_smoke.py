"""The editor's safety net: undo, resize, sound and validation.

An editor without undo is a trap, and a resize that quietly loses work is worse
than none, so both are checked against what they claim rather than just for
absence of errors.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json, sys
ROOT=Path('/Users/christophercohen/Documents/GitHub/neojutsu')
report={}; issues=[]
with sync_playwright() as p:
    b=p.chromium.launch(headless=True)
    page=b.new_context(viewport={"width":1512,"height":1150}).new_page()
    err=[]; page.on('pageerror',lambda e:err.append(str(e)))
    page.goto(ROOT.as_uri()+'/game.html'); page.wait_for_timeout(400)
    page.evaluate("localStorage.clear()"); page.reload(); page.wait_for_timeout(1200)
    if err: issues.append(f'load errors: {err[:2]}')

    # --- undo restores what an edit changed ---
    r = page.evaluate("""()=>{
      const S=window.NeoGameStudio, g=()=>S.game;
      const before = g().level.at(4,4);
      // paint the way the pointer handler does: mark history, then edit
      document.getElementById('g-undo').disabled = true;
      return {before};}""")
    page.evaluate("""()=>{
      const S=window.NeoGameStudio;
      S.brush={kind:'tile',id:1};
    }""")
    # drive a real stroke on the canvas
    box = page.locator('#g-canvas').bounding_box()
    page.mouse.move(box['x']+60, box['y']+60); page.mouse.down(); page.mouse.move(box['x']+90, box['y']+60); page.mouse.up()
    page.wait_for_timeout(400)
    painted = page.evaluate("()=>{const g=window.NeoGameStudio.game; let n=0; const l=g.level; for(let i=0;i<l.tiles.length;i++) if(l.tiles[i]===1) n++; return n;}")
    undo_enabled = page.eval_on_selector('#g-undo','e=>e.disabled')==False
    page.click('#g-undo'); page.wait_for_timeout(600)
    after_undo = page.evaluate("()=>{const g=window.NeoGameStudio.game; let n=0; const l=g.level; for(let i=0;i<l.tiles.length;i++) if(l.tiles[i]===1) n++; return n;}")
    page.click('#g-redo'); page.wait_for_timeout(600)
    after_redo = page.evaluate("()=>{const g=window.NeoGameStudio.game; let n=0; const l=g.level; for(let i=0;i<l.tiles.length;i++) if(l.tiles[i]===1) n++; return n;}")
    report['undo']={'painted':painted,'afterUndo':after_undo,'afterRedo':after_redo,'buttonEnabled':undo_enabled}
    if not undo_enabled: issues.append('undo stayed disabled after an edit')
    if after_undo >= painted: issues.append(f'undo did not restore the level ({painted} -> {after_undo})')
    if after_redo != painted: issues.append(f'redo did not reapply the edit ({after_undo} -> {after_redo}, want {painted})')

    # --- resize keeps the work that fits ---
    r = page.evaluate("""()=>{
      const g=window.NeoGameStudio.game;
      const before={w:g.level.w,h:g.level.h};
      let solid=0; for(let y=0;y<Math.min(14,g.level.h);y++) for(let x=0;x<Math.min(24,g.level.w);x++) if(g.level.at(x,y)) solid++;
      return {before, solidInCorner:solid};}""")
    page.evaluate("NeoWindows.open('build')"); page.wait_for_timeout(200)
    page.select_option('#g-size','24x14'); page.wait_for_timeout(800)
    after = page.evaluate("""()=>{const g=window.NeoGameStudio.game;
      let solid=0; for(let y=0;y<g.level.h;y++) for(let x=0;x<g.level.w;x++) if(g.level.at(x,y)) solid++;
      return {w:g.level.w,h:g.level.h,solid};}""")
    report['resize']={'from':r['before'],'to':[after['w'],after['h']],
                      'kept':after['solid'],'expected':r['solidInCorner']}
    if [after['w'],after['h']]!=[24,14]: issues.append(f"resize did not apply: {after}")
    if after['solid']!=r['solidInCorner']:
        issues.append(f"resize lost work: kept {after['solid']} of {r['solidInCorner']}")

    # --- sound effects exist for the events the engine announces ---
    sfx = page.evaluate("""()=>{
      const names=new Set(window.NeoSfx.names);
      const announced=['jump','doubleJump','coin','gem','key','hurt','kill','shoot','spring','checkpoint','win','lose','break'];
      return {missing:announced.filter(n=>!names.has(n)), total:names.size};}""")
    report['sfx']=sfx
    if sfx['missing']: issues.append(f"no sound for: {sfx['missing']}")

    # --- validation catches a broken game before it is played ---
    v = page.evaluate("""()=>{
      const V=window.NeoGame.validate;
      const ok=Object.keys(window.NeoGameTemplates).filter(k=>!V(window.NeoGameTemplates[k]).ok);
      const broken=V({level:{w:4,h:4,tiles:'zzzz'},entities:[{type:'nope',x:0,y:0}],
                      rules:{collect:5,keys:2},script:'on start\\n boom\\nend'});
      const empty=V(null);
      return {templatesFailing:ok, brokenErrors:broken.errors.length, nullOk:empty.ok};}""")
    report['validate']=v
    if v['templatesFailing']: issues.append(f"shipped games fail validation: {v['templatesFailing']}")
    if v['brokenErrors'] < 4: issues.append(f"validator too lenient: only {v['brokenErrors']} errors on a broken spec")
    if v['nullOk']: issues.append('validator accepted null')

    if err: issues.append(f'errors: {err[:3]}')
    b.close()
print(json.dumps({'report':report,'issues':issues}, indent=2))
if issues: print('\nFAILED'); sys.exit(1)
print('\nThe editor has a safety net.')
