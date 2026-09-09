"""Generating a game from a description.

Two things have to hold: what comes out must be playable, and it must actually
reflect what was asked for. A generator that ignores the prompt but always
returns something valid is worse than useless - it looks like it works.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json, sys
ROOT=Path('/Users/christophercohen/Documents/GitHub/neojutsu')
report={}; issues=[]

CASES = [
  ('a hard ice cave with slippery ledges and a double jump',
   {'theme':'ice','mech':'ice','difficulty':2,'abilities':['doubleJump']}),
  ('an easy short factory level with conveyor belts where the robot can shoot',
   {'theme':'factory','mech':'belts','difficulty':0,'size':'small','abilities':['attack'],'char':'robot'}),
  ('a top-down dungeon maze with a locked door and a key',
   {'mode':'topdown','mech':'doors'}),
  ('a long sky level on floating islands with a dash and 12 coins',
   {'theme':'sky','size':'wide','abilities':['dash'],'collect':12}),
  ('a volcano boss arena, 2 lives', {'theme':'volcano','boss':True,'lives':2}),
  ('a timed run through ruins against the clock', {'theme':'ruins','timed':True}),
  ('an underwater temple where you swim', {'theme':'temple','mech':'water'}),
  ('a tall tower to climb with wall jumping', {'size':'tall','abilities':['wallJump']}),
]

PLAY = """(spec)=>{
  const v = window.NeoGame.validate(spec);
  if (!v.ok) return {ok:false, why:v.errors.slice(0,2)};
  const cv=document.createElement('canvas'); cv.width=160; cv.height=144;
  const g=window.NeoGame.create(cv, JSON.parse(JSON.stringify(spec)), {hud:false});
  g.tick(1.5);
  if (g.state!=='play') return {ok:false, why:['ends immediately']};
  const lvl = spec.level || (spec.levels && spec.levels[0].level) || {h:18};
  if (g.player.y > lvl.h*8+40) return {ok:false, why:['falls out of the world']};
  g.input.right=true; for(let i=0;i<240;i++) g.tick(1/60); g.input.right=false;
  return {ok:!g.scriptFault, why:g.scriptFault?[g.scriptFault]:[], warnings:v.warnings};
}"""

with sync_playwright() as p:
    b=p.chromium.launch(headless=True)
    page=b.new_context().new_page()
    err=[]; page.on('pageerror',lambda e:err.append(str(e)))
    page.goto(ROOT.as_uri()+'/game.html'); page.wait_for_timeout(1000)

    for prompt, want in CASES:
        read = page.evaluate("(p)=>window.NeoGameGen.read(p)", prompt)
        out  = page.evaluate("(p)=>window.NeoGameGen.generateValid(p)", prompt)
        spec = out['spec']
        key = prompt[:34]
        report[key] = {'read': {k: v for k, v in read.items() if v not in (None, [], {})},
                       'size': [spec['level']['w'], spec['level']['h']],
                       'pieces': len(spec['entities']),
                       'bytes': len(json.dumps(spec))}
        # it read what was asked
        for k, v in want.items():
            if k == 'abilities':
                for a in v:
                    if a not in read.get('abilities', []): issues.append(f'{key}: missed ability {a}')
            elif read.get(k) != v:
                issues.append(f'{key}: read {k}={read.get(k)!r}, wanted {v!r}')
        # and the spec honours it
        if 'abilities' in want:
            for a in want['abilities']:
                if not spec['player'].get(a): issues.append(f'{key}: {a} not set on the player')
        if 'mode' in want and spec['mode'] != want['mode']:
            issues.append(f"{key}: mode is {spec['mode']}, wanted {want['mode']}")
        if 'collect' in want and spec['rules']['collect'] != want['collect']:
            issues.append(f"{key}: collect is {spec['rules']['collect']}, wanted {want['collect']}")
        if 'lives' in want and spec['lives'] != want['lives']:
            issues.append(f"{key}: lives is {spec['lives']}, wanted {want['lives']}")
        if 'char' in want and spec['player']['char'] != want['char']:
            issues.append(f"{key}: hero is {spec['player']['char']}, wanted {want['char']}")
        # and it plays
        r = page.evaluate(PLAY, spec)
        if not r['ok']: issues.append(f"{key}: not playable - {r['why']}")

    # nonsense still has to produce something playable rather than nothing
    for junk in ['', 'asdfgh qwerty', 'please make me a sandwich', '🎮🎮🎮']:
        out = page.evaluate("(p)=>window.NeoGameGen.generateValid(p)", junk)
        if not out['validation']['ok']:
            issues.append(f'nonsense prompt {junk!r} produced an invalid game')
        r = page.evaluate(PLAY, out['spec'])
        if not r['ok']: issues.append(f"nonsense prompt {junk!r}: {r['why']}")
    report['nonsense_handled']=True

    # the same prompt and seed must give the same game
    same = page.evaluate("""()=>{
      const a=window.NeoGameGen.generate('an icy cave','seed1');
      const b=window.NeoGameGen.generate('an icy cave','seed1');
      const c=window.NeoGameGen.generate('an icy cave','seed2');
      return {same: JSON.stringify(a.spec)===JSON.stringify(b.spec),
              differs: JSON.stringify(a.spec)!==JSON.stringify(c.spec)};}""")
    report['seeded']=same
    if not same['same']: issues.append('the same prompt and seed gave different games')
    if not same['differs']: issues.append('a different seed gave the same game')

    # variety: twenty runs of one prompt should not be one game twenty times
    uniq = page.evaluate("""()=>{const s=new Set();
      for(let i=0;i<20;i++){ const sp=window.NeoGameGen.generateValid('a cave level', 8, 1).spec;
        s.add((sp.level || sp.levels[0].level).tiles); }
      return s.size;}""")
    report['variety_over_20']=uniq
    if uniq < 15: issues.append(f'only {uniq} distinct levels from 20 runs')

    if err: issues.append(f'errors: {err[:3]}')
    b.close()

print(json.dumps({'report':report,'issues':issues}, indent=2)[:3000])
if issues: print('\nFAILED'); sys.exit(1)
print('\nIt generates games that match what was asked.')
