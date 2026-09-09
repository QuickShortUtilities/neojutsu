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
  /* A game may be a run of rooms rather than one room. The level, the cast
     and the rules then belong to the stage, not to the game, so read them
     from the first stage and check every other stage boots too. */
  const stages = (Array.isArray(t.levels) && t.levels.length) ? t.levels : [t];
  const st = stages[0];
  const cv=document.createElement('canvas'); cv.width=160; cv.height=144;
  const g = window.NeoGame.create(cv, JSON.parse(JSON.stringify(t)), {hud:false});
  const lvl = g.level;
  // the player must come to rest somewhere, not fall out of the world
  g.tick(1.5);
  const settled = g.player.y < lvl.h*8 + 40;
  const startsAlive = g.state === 'play';
  // and must not be punished before touching a control: no free pickups sitting
  // on the spawn, and nothing landing a hit while standing still
  const g2 = window.NeoGame.create(cv, JSON.parse(JSON.stringify(t)), {hud:false});
  g2.tick(3.2);
  const fairOpening = g2.state === 'play' && g2.lives === (t.lives ?? 3);
  // walking right for a while must not throw and must not instantly end it
  g.input.right = true;
  for (let i=0;i<240;i++) g.tick(1/60);
  g.input.right = false;
  const coins = (st.entities||[]).filter(e=>e.type==='coin'||e.type==='gem').length;
  const need = ((st.rules||t.rules)&&(st.rules||t.rules).collect)||0;
  const script = t.script ? window.NeoScript.compile(t.script) : {errors:[]};
  let tiles = new Set();
  for (let y=0;y<lvl.h;y++) for (let x=0;x<lvl.w;x++) tiles.add(lvl.at(x,y));

  /* Can you see yourself? The studio keeps losing silhouettes to palettes
     that collapse - a dark hero on dark ground, a pale one on a pale sky.
     Draw the frame twice, once with the player lifted out, and compare only
     the pixels the player owns against the ones around it. Contrast is the
     larger of the two directions, because a dark character on a light
     background reads perfectly well. */
  /* What the player has to be able to pick out. Usually that is the body
     they are steering; in a falling-block game there is no body and the thing
     they are steering is the piece, so that is what gets measured. */
  const steered = t.mode === 'blocks';
  const shot = (hide) => {
    const s2 = JSON.parse(JSON.stringify(t));
    const cv = document.createElement('canvas'); cv.width = 192; cv.height = 160;
    const gg = window.NeoGame.create(cv, s2, { hud: false });
    gg.freeCam = true;
    if (steered) {
      gg.tick(1/60);                      // let a piece exist
      gg.panTo(0, 0);
      if (hide && gg.piece) gg.piece.y = -9999;
    } else {
      gg.panTo(Math.max(0, gg.player.x - 96), Math.max(0, gg.player.y - 80));
      if (hide) gg.player.y = -9999;
    }
    gg.draw();
    return cv.getContext('2d').getImageData(0, 0, 192, 160).data;
  };
  /* Every later room, booted on its own. A run whose third room drops you
     into a wall is broken, and nobody finds out until they get there. */
  const badStages = [];
  for (let i = 1; i < stages.length; i++) {
    const gs = window.NeoGame.create(document.createElement('canvas'),
                                     JSON.parse(JSON.stringify(t)), {hud:false});
    gs.goToStage(i); gs.tick(3.2);
    if (gs.state !== 'play') badStages.push(i + ': ' + gs.state);
    else if (gs.lives < (t.lives ?? 3)) badStages.push(i + ': hit at once');
    else if (gs.player.y > gs.level.h*8 + 40) badStages.push(i + ': falls out');
    else if (gs.scriptFault) badStages.push(i + ': ' + gs.scriptFault);
  }

  const on = shot(false), off = shot(true);
  let owned = 0, mn = 255, mx = 0, box = [999, 999, -1, -1];
  for (let i = 0, px = 0; i < on.length; i += 4, px++) {
    if (on[i] === off[i] && on[i+1] === off[i+1] && on[i+2] === off[i+2]) continue;
    const l = on[i]*.299 + on[i+1]*.587 + on[i+2]*.114;
    owned++; if (l < mn) mn = l; if (l > mx) mx = l;
    const x = px % 192, y = (px / 192) | 0;
    if (x < box[0]) box[0] = x; if (y < box[1]) box[1] = y;
    if (x > box[2]) box[2] = x; if (y > box[3]) box[3] = y;
  }
  let bgSum = 0, bgN = 0;
  if (box[2] >= 0) for (let y = Math.max(0, box[1]-7); y < Math.min(160, box[3]+7); y++)
    for (let x = Math.max(0, box[0]-7); x < Math.min(192, box[2]+7); x++) {
      const i = (y*192 + x) * 4;
      if (on[i] === off[i] && on[i+1] === off[i+1] && on[i+2] === off[i+2]) {
        bgSum += off[i]*.299 + off[i+1]*.587 + off[i+2]*.114; bgN++;
      }
    }
  const bg = bgN ? bgSum / bgN : null;
  const contrast = bg === null ? 0 : Math.round(Math.max(mx - bg, bg - mn));
  return {
    mode: t.mode, size:[lvl.w,lvl.h], entities:(st.entities||[]).length,
    coins, need,
    /* Every game has to be finishable, but not every game is finished by
       walking into something. A scroller arrives at the exit strip; a maze is
       cleared of its dots; an arena is cleared of its enemies. */
    hasGoal: stages.every(s => {
      const r = s.rules || t.rules || {};
      if (r.clearAll) return (s.entities||[]).some(e=>e.type==='dot'||e.type==='coin'||e.type==='gem');
      if (r.clearFoes) return (s.entities||[]).some(e=>e.type==='invader'||e.type==='walker'
                                                    ||e.type==='chaser'||e.type==='hunter');
      // A block game is finished by clearing rows and a quest by beating
      // rivals; neither has anything in it to walk into.
      if (r.lines) return t.mode === 'blocks';
      if (r.beat) return (s.entities||[]).some(e=>e.type==='rival');
      return (s.entities||[]).some(e=>e.type==='goal') || /i/.test(String((s.level||{}).tiles||''));
    }),
    stageCount: stages.length, badStages,
    distinctTiles: tiles.size, startsAlive, settled,
    scriptErrors: script.errors, fault: g.scriptFault, fairOpening,
    playerPixels: owned, playerContrast: contrast,
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
                   'stages':r['stageCount'],
                   'tiles':r['distinctTiles'],'kb':round(r['bytes']/1024,1),
                   'need':r['need'],'coins':r['coins']}
        if not r['startsAlive']: issues.append(f'{k}: does not start in play')
        if not r['fairOpening']: issues.append(f'{k}: loses or gains a life in the first three seconds')
        if not r['playerPixels']:
            issues.append(f'{k}: nothing is drawn for the thing you steer')
        elif r['playerContrast'] < 45:
            issues.append(f"{k}: the player is hard to see (contrast {r['playerContrast']})")
        if not r['settled']: issues.append(f'{k}: the player falls out of the world at the start')
        if not r['hasGoal']: issues.append(f'{k}: has no goal to reach')
        if r['need'] > r['coins']: issues.append(f"{k}: asks for {r['need']} pickups but only has {r['coins']}")
        if r['scriptErrors']: issues.append(f"{k}: script errors {r['scriptErrors'][:2]}")
        if r['fault']: issues.append(f"{k}: script faulted at runtime: {r['fault']}")
        if r['distinctTiles'] < 2: issues.append(f'{k}: level is empty')
        if r['badStages']: issues.append(f"{k}: later rooms are broken - {r['badStages']}")
        if r['bytes'] > 60000: issues.append(f"{k}: {r['bytes']} bytes is too big to share comfortably")

    if err: issues.append(f'page errors: {err[:3]}')
    b.close()

print(json.dumps({'report':report,'issues':issues}, indent=2))
if issues: print('\nFAILED'); sys.exit(1)
print(f"\nAll {report['count']} games boot and play.")
