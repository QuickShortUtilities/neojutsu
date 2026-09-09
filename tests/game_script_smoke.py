"""NeoScript has to be safe to run from a stranger.

A shared game carries its script, so the script is untrusted input. These are
attacks, not features: reaching the page, the network, storage, the engine's
internals, or simply hanging the tab. The language has no eval and no way to
name a host object, and every run is bounded - this proves both.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json, sys
ROOT=Path('/Users/christophercohen/Documents/GitHub/neojutsu')
report={}; issues=[]

RUN = """([src, ticks])=>{
  const cv=document.createElement('canvas'); cv.width=160; cv.height=96;
  const rows=[]; for(let y=0;y<12;y++){let r='';for(let x=0;x<20;x++) r+= (y>=10?'1':'0'); rows.push(r);}
  window.__hacked = false;
  const started = performance.now();
  const g = window.NeoGame.create(cv, {mode:'platform',seed:'s',start:{x:16,y:64},lives:3,
    level:{w:20,h:12,tiles:rows.join('\\n')},
    entities:[{type:'coin',x:40,y:70}], script:src}, {hud:false});
  for (let i=0;i<(ticks||10);i++) g.tick(1/60);
  return {ms: Math.round(performance.now()-started), state:g.state, score:g.score,
          entities:g.entities.length, fault:g.scriptFault, log:g.scriptLog,
          hacked: !!window.__hacked, tile00: g.level.at(0,0)};
}"""

with sync_playwright() as p:
    b=p.chromium.launch(headless=True)
    page=b.new_context().new_page()
    err=[]; page.on('pageerror',lambda e:err.append(str(e)))
    page.goto(ROOT.as_uri()+'/game.html'); page.wait_for_timeout(900)
    run=lambda src, ticks=10: page.evaluate(RUN, [src, ticks])
    lint=lambda src: page.evaluate("(s)=>window.NeoScript.compile(s).errors", src)

    # --- the language simply has no way to name a host object ---
    hostile = [
      ('window',        'on start\n  set a window\nend'),
      ('document',      'on start\n  set a document\nend'),
      ('fetch',         'on start\n  fetch "https://evil.example"\nend'),
      ('localStorage',  'on start\n  set a localStorage\nend'),
      ('eval',          'on start\n  eval "window.__hacked=true"\nend'),
      ('constructor',   'on start\n  set a constructor\nend'),
      ('proto',         'on start\n  set __proto__ 1\nend'),
      ('import',        'on start\n  import "x"\nend'),
    ]
    hostile_out={}
    for name, src in hostile:
        r = run(src)
        hostile_out[name] = {'hacked': r['hacked'], 'fault': r['fault'][:40]}
        if r['hacked']: issues.append(f'{name}: script reached the host')
    report['hostile_scripts']=hostile_out
    # unknown identifiers are values worth zero, unknown commands are refused at compile time
    if not lint('on start\n  fetch "x"\nend'): issues.append('unknown command was accepted')
    if lint('on start\n  set a window\nend'): issues.append('reading an unknown name should be harmless, not fatal')
    report['unknown_command_rejected']=True

    # --- a runaway loop must not hang the tab ---
    r = run('on start\n  set i 0\n  while 1\n    set i i + 1\n  end\nend')
    report['infinite_loop']={'ms': r['ms'], 'fault': r['fault']}
    if r['ms'] > 3000: issues.append(f"infinite loop ran for {r['ms']}ms")
    if not r['fault']: issues.append('a runaway loop reported no fault')

    # --- and neither must a runaway spawn ---
    r = run('on tick\n  set i 0\n  while i < 400\n    spawn "coin" 2 2\n    set i i + 1\n  end\nend', 40)
    report['spawn_flood']={'entities': r['entities'], 'ms': r['ms']}
    if r['entities'] > 500: issues.append(f"spawn flood created {r['entities']} entities")
    if r['ms'] > 5000: issues.append(f"spawn flood took {r['ms']}ms")

    # --- writes outside the level are ignored, not crashes ---
    r = run('on start\n  tile 0 - 999 1\n  tile 9999 9999 1\n  tile 0 0 99\nend')
    report['out_of_range_tile']={'tile00': r['tile00'], 'fault': r['fault']}
    if r['fault']: issues.append(f"a harmless out-of-range write faulted: {r['fault']}")

    # --- a faulty script leaves the game playable ---
    r = run('on tick\n  set i 0\n  while 1\n    set i i + 1\n  end\nend', 30)
    report['game_survives_fault']={'state': r['state']}
    if r['state'] != 'play': issues.append('a broken script broke the game')

    # --- and a good script still works ---
    r = run('on start\n  message "HI"\n  print "started"\nend\non tick\n  every 0.05\n    give 1\n  end\nend', 30)
    report['working_script']={'score': r['score'], 'log': r['log']}
    if r['score'] < 1: issues.append('a valid script did nothing')
    if 'started' not in (r['log'] or []): issues.append('print did not reach the log')

    # --- log and message lengths are bounded ---
    r = run('on tick\n  print "' + 'x'*500 + '"\nend', 120)
    longest = max((len(l) for l in (r['log'] or [])), default=0)
    report['log_bounds']={'lines': len(r['log'] or []), 'longest': longest}
    if len(r['log'] or []) > 60: issues.append('log is unbounded')
    if longest > 100: issues.append('log lines are unbounded')

    if err: issues.append(f'page errors: {err[:3]}')
    b.close()

print(json.dumps({'report':report,'issues':issues}, indent=2))
if issues: print('\nFAILED'); sys.exit(1)
print('\nScripts cannot reach out, and cannot hang the tab.')
