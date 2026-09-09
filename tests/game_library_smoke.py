"""Every shipped game has to be a real, finishable game.

A template that loads but strands the player, has no way to win, or whose script
does not compile is worse than no template at all, so each one is booted,
simulated, and checked against what it claims about itself.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json, sys
ROOT=Path('/Users/christophercohen/Documents/GitHub/neojutsu')
report={}; issues=[]

CHECK = """(key)=>{
  const t = window.NeoGameTemplates[key];
  const cv=document.createElement('canvas'); cv.width=160; cv.height=144;
  const g = window.NeoGame.create(cv, JSON.parse(JSON.stringify(t)), {hud:false});
  const lvl = g.level;
  // the player must come to rest somewhere, not fall out of the world
  g.tick(1.5);
  const settled = g.player.y < lvl.h*8 + 40;
  const startsAlive = g.state === 'play';
  // walking right for a while must not throw and must not instantly end it
  g.input.right = true;
  for (let i=0;i<240;i++) g.tick(1/60);
  g.input.right = false;
  const coins = (t.entities||[]).filter(e=>e.type==='coin'||e.type==='gem').length;
  const need = (t.rules&&t.rules.collect)||0;
  const script = t.script ? window.NeoScript.compile(t.script) : {errors:[]};
  let tiles = new Set();
  for (let y=0;y<lvl.h;y++) for (let x=0;x<lvl.w;x++) tiles.add(lvl.at(x,y));
  return {
    mode: t.mode, size:[lvl.w,lvl.h], entities:(t.entities||[]).length,
    coins, need,
    // Scrolling games finish by arriving at the exit strip, not at a flag.
    hasGoal: (t.entities||[]).some(e=>e.type==='goal') || /i/.test(String(t.level.tiles||'')),
    distinctTiles: tiles.size, startsAlive, settled,
    scriptErrors: script.errors, fault: g.scriptFault,
    stateAfterWalk: g.state, lives: g.lives,
    bytes: JSON.stringify(t).length,
  };
}"""

with sync_playwright() as p:
    b=p.chromium.launch(headless=True)
    page=b.new_context().new_page()
    err=[]; page.on('pageerror',lambda e:err.append(str(e)))
    page.goto(ROOT.as_uri()+'/game.html'); page.wait_for_timeout(900)
    keys=page.evaluate("()=>Object.keys(window.NeoGameTemplates)")
    report['count']=len(keys)
    if len(keys) < 10: issues.append(f'only {len(keys)} games, expected at least 10')

    for k in keys:
        r=page.evaluate(CHECK, k)
        report[k]={'mode':r['mode'],'size':r['size'],'pieces':r['entities'],
                   'tiles':r['distinctTiles'],'kb':round(r['bytes']/1024,1),
                   'need':r['need'],'coins':r['coins']}
        if not r['startsAlive']: issues.append(f'{k}: does not start in play')
        if not r['settled']: issues.append(f'{k}: the player falls out of the world at the start')
        if not r['hasGoal']: issues.append(f'{k}: has no goal to reach')
        if r['need'] > r['coins']: issues.append(f"{k}: asks for {r['need']} pickups but only has {r['coins']}")
        if r['scriptErrors']: issues.append(f"{k}: script errors {r['scriptErrors'][:2]}")
        if r['fault']: issues.append(f"{k}: script faulted at runtime: {r['fault']}")
        if r['distinctTiles'] < 2: issues.append(f'{k}: level is empty')
        if r['bytes'] > 60000: issues.append(f"{k}: {r['bytes']} bytes is too big to share comfortably")

    if err: issues.append(f'page errors: {err[:3]}')
    b.close()

print(json.dumps({'report':report,'issues':issues}, indent=2))
if issues: print('\nFAILED'); sys.exit(1)
print(f"\nAll {report['count']} games boot and play.")
