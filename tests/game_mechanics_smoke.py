"""Each mechanic is checked on a purpose-built level rather than by hunting for
a situation in the shipped one, so a failure names the mechanic that broke."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json, sys
ROOT=Path('/Users/christophercohen/Documents/GitHub/neojutsu')
report={}; issues=[]

# A tiny arena: floor along the bottom, and whatever the test paints into it.
HARNESS = """(args)=>{
  const {tiles, player, entities, rules, triggers, mode} = args;
  const W=20,H=12;
  const rows=[];
  for(let y=0;y<H;y++){ let r=''; for(let x=0;x<W;x++) r += (y>=10?'1':'0'); rows.push(r); }
  const grid=rows.map(r=>r.split(''));
  for(const [x,y,id] of (tiles||[])) grid[y][x]=id.toString(36);
  const spec={ mode: mode||'platform', seed:'t', start:{x:16,y:64}, lives:3,
    player: Object.assign({char:'hero'}, player||{}),
    level:{w:W,h:H,tiles:grid.map(r=>r.join('')).join('\\n')},
    entities: entities||[], rules: rules||{}, triggers: triggers||[] };
  const cv=document.createElement('canvas'); cv.width=160; cv.height=96;
  return window.NeoGame.create(cv, spec, {hud:false});
}"""

with sync_playwright() as p:
    b=p.chromium.launch(headless=True)
    page=b.new_context().new_page()
    err=[]; page.on('pageerror',lambda e:err.append(str(e)))
    page.goto(ROOT.as_uri()+'/game.html'); page.wait_for_timeout(900)
    page.evaluate("() => { window.__mk = " + HARNESS + "; }")

    def run(js, args):
        return page.evaluate("([a,fn])=>{const g=window.__mk(a); return (new Function('g','return ('+fn+')(g)'))(g);}",
                             [args, js])

    # --- spring launches higher than a jump ---
    spring = run("""(g)=>{ g.tick(0.6); const y0=g.player.y; let peak=y0;
      for(let i=0;i<90;i++){ g.tick(1/60); peak=Math.min(peak,g.player.y); }
      return Math.round(y0-peak); }""",
      {'tiles': [[2,9,11]], 'player': {}})
    # drop the player onto the spring
    spring = run("""(g)=>{ g.player.x=16; g.player.y=40; let peak=999;
      for(let i=0;i<120;i++){ g.tick(1/60); peak=Math.min(peak,g.player.y); }
      return Math.round(80-peak); }""",
      {'tiles': [[2,9,11]], 'player': {}})
    report['spring_launch']=spring
    if spring < 40: issues.append(f'spring only launched {spring}px, no better than a jump')

    # --- ice is slippery: the player keeps sliding after letting go ---
    ice = run("""(g)=>{ g.player.x=16; g.tick(0.6); g.input.right=true; g.tick(0.8); g.input.right=false;
      const x0=g.player.x; g.tick(0.5); return Math.round(g.player.x-x0); }""",
      {'tiles': [[x,10,8] for x in range(1,19)], 'player': {}})
    normal = run("""(g)=>{ g.player.x=16; g.tick(0.6); g.input.right=true; g.tick(0.8); g.input.right=false;
      const x0=g.player.x; g.tick(0.5); return Math.round(g.player.x-x0); }""",
      {'tiles': [], 'player': {}})
    report['slide_on_ice_vs_ground']=[ice, normal]
    if ice <= normal + 2: issues.append(f'ice is not slippery (slid {ice}px vs {normal}px on ground)')

    # --- conveyor carries a standing body ---
    belt = run("""(g)=>{ g.player.x=16; g.tick(0.6); const x0=g.player.x; g.tick(1.0);
      return Math.round(g.player.x-x0); }""",
      {'tiles': [[x,10,9] for x in range(1,19)], 'player': {}})
    report['belt_carry']=belt
    if belt < 20: issues.append(f'conveyor barely moved a standing player ({belt}px)')

    # --- a door blocks until the key is taken ---
    door = run("""(g)=>{ g.tick(0.6);
      g.input.right=true; for(let i=0;i<140;i++) g.tick(1/60); g.input.right=false;
      const blocked=Math.round(g.player.x);
      // walk back for the key rather than teleporting into the scenery
      g.input.left=true; for(let i=0;i<150;i++) g.tick(1/60); g.input.left=false;
      const keyTaken=!g.entities.some(e=>e.type==='key'&&e.alive);
      g.input.right=true; for(let i=0;i<200;i++) g.tick(1/60); g.input.right=false;
      return {blocked, keyTaken, after:Math.round(g.player.x), state:g.state, lives:g.lives}; }""",
      {'tiles': [[10,9,12],[10,8,12]], 'entities': [{'type':'key','x':4,'y':66}],
       'rules': {'keys': 1}, 'player': {}})
    report['door']=door
    if door['blocked'] > 80: issues.append(f"door did not block the player ({door['blocked']}px)")
    if not door['keyTaken']: issues.append('the key was not collected')
    if door['after'] <= 100: issues.append(f'door did not open with the key: {door}')

    # --- checkpoint changes where death sends you ---
    cp = run("""(g)=>{ g.player.x=16; g.tick(0.5);
      g.player.x=80; g.player.y=72; g.tick(1/60); g.tick(1/60);
      const before=Math.round(g.player.x);
      g.player.x=140; g.player.y=72; g.tick(1/60);
      g.player.y = 2000; g.tick(1/60);
      return {checkpointAt:before, respawn:Math.round(g.player.x)}; }""",
      {'tiles': [[10,9,13]], 'player': {}})
    report['checkpoint']=cp
    if cp['respawn'] < 60: issues.append(f'death ignored the checkpoint: {cp}')

    # --- double jump and dash are abilities, off by default ---
    single = run("""(g)=>{ g.tick(0.6); const y0=g.player.y; let peak=y0;
      g.input.a=true; for(let i=0;i<60;i++){ g.tick(1/60); peak=Math.min(peak,g.player.y); }
      return Math.round(y0-peak); }""", {'tiles': [], 'player': {}})
    double = run("""(g)=>{ g.tick(0.6); const y0=g.player.y; let peak=y0;
      g.input.a=true; for(let i=0;i<20;i++){ g.tick(1/60); peak=Math.min(peak,g.player.y); }
      g.input.a=false; g.tick(2/60); g.input.a=true;
      for(let i=0;i<60;i++){ g.tick(1/60); peak=Math.min(peak,g.player.y); }
      return Math.round(y0-peak); }""", {'tiles': [], 'player': {'doubleJump': True}})
    report['jump_vs_double']=[single, double]
    if double <= single + 8: issues.append(f'double jump added nothing ({single} -> {double})')

    dash = run("""(g)=>{ g.tick(0.6); const x0=g.player.x;
      g.input.b=true; g.tick(1/60); g.input.b=false;
      for(let i=0;i<12;i++) g.tick(1/60);
      return Math.round(g.player.x-x0); }""", {'tiles': [], 'player': {'dash': True, 'attack': False}})
    report['dash']=dash
    if abs(dash) < 12: issues.append(f'dash barely moved the player ({dash}px)')

    # --- shooting kills an enemy ---
    shoot = run("""(g)=>{ g.tick(0.5); g.player.x=16; g.player.face=1;
      const foe=g.entities.find(e=>e.type==='walker');
      foe.vx=0; foe.x=70; foe.y=72;
      g.input.b=true; g.tick(1/60); g.input.b=false;
      for(let i=0;i<70;i++) g.tick(1/60);
      return {alive:foe.alive}; }""",
      {'tiles': [], 'entities': [{'type':'walker','x':70,'y':72}], 'player': {'attack': True}})
    report['shooting']=shoot
    if shoot['alive']: issues.append('a shot did not kill the walker')

    # --- headbutting a brick breaks it ---
    brk = run("""(g)=>{ g.player.x=16; g.tick(0.5);
      const before=g.level.at(2,7);
      g.player.x=16; g.player.y=70; g.input.a=true;
      for(let i=0;i<40;i++) g.tick(1/60);
      g.input.a=false;
      return {before, after:g.level.at(2,7)}; }""",
      {'tiles': [[2,7,7]], 'player': {}})
    report['breakable']=brk
    if brk['before']!=7 or brk['after']!=0: issues.append(f'headbutting a brick did not break it: {brk}')

    # --- a trigger fires and does what it says ---
    trig = run("""(g)=>{ g.tick(0.5);
      const coin=g.entities.find(e=>e.type==='coin');
      g.player.x=coin.x; g.player.y=coin.y; g.tick(1/60); g.tick(1/60);
      return {score:g.score, state:g.state}; }""",
      {'tiles': [], 'entities': [{'type':'coin','x':40,'y':70}],
       'triggers': [{'when': {'score': 1}, 'do': {'win': True}}]})
    report['trigger']=trig
    if trig['state']!='won': issues.append(f'trigger did not fire: {trig}')

    if err: issues.append(f'errors: {err[:3]}')
    b.close()

print(json.dumps({'report':report,'issues':issues}, indent=2))
if issues: print('\nFAILED'); sys.exit(1)
print('\nEvery mechanic behaves.')
