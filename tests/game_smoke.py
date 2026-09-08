"""The Game Studio has to be a game, not a picture of one.

Everything here drives the engine by hand with fixed steps rather than a clock,
so the checks are about behaviour - gravity, collision, jumping, collecting,
dying, winning - and not about timing.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json, sys, tempfile
ROOT=Path('/Users/christophercohen/Documents/GitHub/neojutsu')
ART=Path(tempfile.mkdtemp(prefix='neojutsu-game-'))
GB={(0x0f,0x38,0x0f),(0x30,0x62,0x30),(0x8b,0xac,0x0f),(0x9b,0xbc,0x0f)}
report={}; issues=[]

def E(page, js, arg=None):
    return page.evaluate(js, arg) if arg is not None else page.evaluate(js)

with sync_playwright() as p:
    b=p.chromium.launch(headless=True)
    page=b.new_context(viewport={"width":1512,"height":1100}).new_page()
    err=[]; page.on('pageerror',lambda e:err.append(str(e)))
    page.goto(ROOT.as_uri()+'/game.html'); page.wait_for_timeout(400)
    page.evaluate("localStorage.clear()"); page.reload(); page.wait_for_timeout(1000)
    if err: issues.append(f'load errors: {err[:2]}')

    # --- gravity and ground collision ---
    fall = E(page, """()=>{const g=window.NeoGameStudio.game; g.reset();
      const y0=g.player.y; g.tick(1.2);
      return {y0:Math.round(y0), y1:Math.round(g.player.y), grounded:g.player.grounded};}""")
    report['falls_and_lands']=fall
    if not fall['grounded']: issues.append('player never landed on the ground')
    if fall['y1'] <= fall['y0']: issues.append('gravity did not pull the player down')

    # --- the player does not sink through solid tiles ---
    sink = E(page, """()=>{const g=window.NeoGameStudio.game; g.tick(3);
      const y=g.player.y; g.tick(2); return Math.abs(g.player.y-y)<0.5;}""")
    if not sink: issues.append('player drifts through the floor when standing still')
    report['floor_is_solid']=sink

    # --- walking ---
    walk = E(page, """()=>{const g=window.NeoGameStudio.game; g.reset(); g.tick(1.0);
      const x0=g.player.x; g.input.right=true; g.tick(1.0); g.input.right=false;
      const x1=g.player.x; g.input.left=true; g.tick(1.0); g.input.left=false;
      return {moved:Math.round(x1-x0), back:Math.round(g.player.x-x1)};}""")
    report['walking']=walk
    if walk['moved'] <= 10: issues.append(f"walking right barely moved ({walk['moved']}px)")
    if walk['back'] >= -5: issues.append(f"walking left did not move back ({walk['back']}px)")

    # --- jumping clears real height and comes back down ---
    # A held jump is the real one; a tap is meant to be a short hop, so the
    # ledge-clearing check holds the button the way a player would.
    jump = E(page, """()=>{const g=window.NeoGameStudio.game; g.reset(); g.tick(1.0);
      const ground=g.player.y; let peak=ground;
      g.input.a=true;
      for(let i=0;i<60;i++){ g.tick(1/60); peak=Math.min(peak,g.player.y); }
      g.input.a=false; g.tick(1.5);
      return {rise:Math.round(ground-peak), landedBack:Math.abs(g.player.y-ground)<1.5};}""")
    report['jumping']=jump
    # The level's own ledges sit three tiles above the ground, so a full jump
    # must clear 24px with something in hand.
    if jump['rise'] < 30: issues.append(f"jump only cleared {jump['rise']}px - the level's 3-tile ledges need 24")
    if not jump['landedBack']: issues.append('player did not land back on the same ground')

    # --- a held jump goes higher than a tapped one ---
    varjump = E(page, """()=>{const g=window.NeoGameStudio.game;
      const test=(hold)=>{ g.reset(); g.tick(1.0); const y0=g.player.y; let peak=y0;
        g.input.a=true;
        for(let i=0;i<50;i++){ if(i*(1/60)>hold) g.input.a=false; g.tick(1/60); peak=Math.min(peak,g.player.y); }
        g.input.a=false; return Math.round(y0-peak); };
      return {tap:test(0.05), held:test(0.6)};}""")
    report['variable_jump']=varjump
    if varjump['held'] <= varjump['tap']: issues.append(f"holding jump is not higher than tapping ({varjump})")

    # --- collecting ---
    collect = E(page, """()=>{const g=window.NeoGameStudio.game; g.reset();
      const coin=g.entities.find(e=>e.type==='coin'&&e.alive);
      if(!coin) return {none:true};
      g.player.x=coin.x-1; g.player.y=coin.y-1; g.tick(1/60);
      return {score:g.score, coinGone:!coin.alive};}""")
    report['collect']=collect
    if not collect.get('coinGone') or collect.get('score',0)<1: issues.append(f'collecting a coin did nothing: {collect}')

    # --- hazards cost a life ---
    hazard = E(page, """()=>{const g=window.NeoGameStudio.game; g.reset();
      const before=g.lives; const T=window.NeoGame.TILE, L=g.level;
      let hit=null;
      for(let y=0;y<L.h&&!hit;y++) for(let x=0;x<L.w;x++) if(L.at(x,y)===4){hit={x,y};break;}
      if(!hit) return {none:true};
      g.player.x=hit.x*T+1; g.player.y=hit.y*T+1; g.tick(1/60);
      return {before, after:g.lives};}""")
    report['hazard']=hazard
    if not hazard.get('none') and hazard['after'] >= hazard['before']:
        issues.append('touching spikes cost nothing')

    # --- reaching the flag with enough coins wins ---
    win = E(page, """()=>{const g=window.NeoGameStudio.game; g.reset();
      const goal=g.entities.find(e=>e.type==='goal');
      g.entities.filter(e=>e.def.collect&&!e.def.key).forEach(e=>{ if(e.alive){e.alive=false;} });
      // score is private, so collect properly by walking onto each coin
      g.reset();
      for(const e of g.entities.filter(e=>e.type==='coin')){ g.player.x=e.x; g.player.y=e.y; g.tick(1/60); }
      const scored=g.score;
      g.player.x=goal.x; g.player.y=goal.y; g.tick(1/60);
      return {scored, state:g.state};}""")
    report['winning']=win
    if win['state']!='won': issues.append(f"reaching the flag with {win['scored']} coins did not win: {win['state']}")

    # --- build mode edits the level ---
    edit = E(page, """()=>{const g=window.NeoGameStudio.game;
      const before=g.level.at(3,5);
      g.setTile(3,5,1); const after=g.level.at(3,5);
      g.setTile(3,5,0); const cleared=g.level.at(3,5);
      const n0=g.entities.length; g.addEntity({type:'coin',x:40,y:40});
      const n1=g.entities.length; g.removeEntityAt(41,41);
      return {before,after,cleared,added:n1-n0,removed:n1-g.entities.length};}""")
    report['building']=edit
    if edit['after']!=1 or edit['cleared']!=0: issues.append(f'painting tiles does not work: {edit}')
    if edit['added']!=1 or edit['removed']!=1: issues.append(f'placing/removing pieces does not work: {edit}')

    # --- the frame is on the hardware palette ---
    page.evaluate("()=>{const S=window.NeoGameStudio; S.game.reset(); S.present();}")
    page.wait_for_timeout(200)
    cols = E(page, """()=>{const c=document.getElementById('g-canvas');
      const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      const s=new Set(); for(let i=0;i<d.length;i+=4) s.add(`${d[i]},${d[i+1]},${d[i+2]}`);
      return [...s];}""")
    stray={tuple(int(n) for n in k.split(','))for k in cols} - GB
    report['palette_colours']=len(cols)
    if stray: issues.append(f'game frame is off-palette: {list(stray)[:4]}')

    # --- a saved game round-trips ---
    rt = E(page, """()=>{const g=window.NeoGameStudio.game;
      g.setTile(9,9,2);
      const snap=g.snapshot();
      const json=JSON.stringify(snap);
      const back=JSON.parse(json);
      return {kb:Math.round(json.length/102.4)/10, tileKept:back.level.tiles[9*back.level.w+9]===2,
              entities:back.entities.length};}""")
    report['snapshot']=rt
    if not rt['tileKept']: issues.append('snapshot lost a painted tile')

    page.evaluate("()=>{document.getElementById('g-edit').checked=false;window.NeoGameStudio.game.reset();window.NeoGameStudio.present();}")
    page.wait_for_timeout(300)
    page.screenshot(path=str(ART/'game.png'))
    page.locator('#g-canvas').screenshot(path=str(ART/'frame.png'))
    report['shots']=[str(ART/'game.png'), str(ART/'frame.png')]
    if err: issues.append(f'errors during play: {err[:2]}')
    b.close()

print(json.dumps({'report':report,'issues':issues}, indent=2))
if issues: print('\nFAILED'); sys.exit(1)
print('\nIt is a game.')
