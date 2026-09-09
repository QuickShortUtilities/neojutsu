"""The script has to be able to describe a game, not just tint one.

Three things separate a language you can write a game in from a list of
switches: time, so one thing can happen after another; named actors, so a
script can aim at something in the level; and routines, so a game is built
out of parts. This covers all three, and that none of them opened a hole in
the sandbox.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json, sys
ROOT = Path('/Users/christophercohen/Documents/GitHub/neojutsu')
report = {}; issues = []

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    page = b.new_context(viewport={"width": 1200, "height": 900}).new_page()
    err = []; page.on('pageerror', lambda e: err.append(str(e)))
    page.goto(ROOT.as_uri() + '/game.html'); page.wait_for_timeout(1700)

    # ---- a sequence takes time ----
    report['wait'] = page.evaluate("""() => {
      const NL = String.fromCharCode(10);
      const src = ['on start', '  set a 1', '  wait 1', '  set a 2', '  wait 1', '  set a 3', 'end'].join(NL);
      const t = JSON.parse(JSON.stringify(window.NeoGameTemplates.platformer));
      t.script = src; t.story = [];
      const cv = document.createElement('canvas'); cv.width = 160; cv.height = 144;
      const g = window.NeoGame.create(cv, t, { hud: false });
      const read = () => { let v = null; try { v = g.scriptState().a; } catch (e) {} return v; };
      const at0 = read();
      g.tick(0.5); const at05 = read();
      g.tick(0.7); const at12 = read();
      g.tick(1.0); const at22 = read();
      return { at0, at05, at12, at22, fault: g.scriptFault };
    }""")
    w = report['wait']
    if w.get('fault'): issues.append(f"waiting script faulted: {w['fault']}")
    if w['at0'] != 1 or w['at05'] != 1:
        issues.append(f"the first line did not run at once ({w['at0']}, {w['at05']})")
    if w['at12'] != 2: issues.append(f"a one second wait did not end after 1.2s (got {w['at12']})")
    if w['at22'] != 3: issues.append(f"the second wait did not end (got {w['at22']})")

    # ---- routines ----
    report['routines'] = page.evaluate("""() => {
      const NL = String.fromCharCode(10);
      const good = ['define bump', '  give 1', 'end', '', 'on start', '  do bump', '  do bump', 'end'].join(NL);
      const missing = ['on start', '  do nowhere', 'end'].join(NL);
      const c1 = window.NeoScript.compile(good), c2 = window.NeoScript.compile(missing);
      const t = JSON.parse(JSON.stringify(window.NeoGameTemplates.platformer));
      t.script = good; t.story = []; t.rules = { collect: 0, keys: 0 };
      const cv = document.createElement('canvas'); cv.width = 160; cv.height = 144;
      const g = window.NeoGame.create(cv, t, { hud: false });
      g.tick(1/60);
      return { ok: c1.errors, names: Object.keys(c1.routines || {}),
               missingCaught: c2.errors.some(e => e.indexOf('nowhere') >= 0), score: g.score };
    }""")
    r = report['routines']
    if r['ok']: issues.append(f"a good routine did not compile: {r['ok']}")
    if r['names'] != ['bump']: issues.append(f"routines not recorded: {r['names']}")
    if not r['missingCaught']: issues.append('calling a routine that does not exist compiled fine')
    if r['score'] != 2: issues.append(f'a routine used twice scored {r["score"]}, expected 2')

    # ---- actors ----
    report['actors'] = page.evaluate("""() => {
      const NL = String.fromCharCode(10);
      const src = ['on start', '  hide "g"', '  wait 0.4', '  show "g"',
                   '  setsprite "g" 324', '  face "g" -1', '  move "g" 4 4',
                   '  wait 0.4', '  shoot "g" 0', 'end'].join(NL);
      const t = JSON.parse(JSON.stringify(window.NeoGameTemplates.platformer));
      t.script = src; t.story = [];
      t.entities = (t.entities || []).map(e => e.type === 'walker' ? { ...e, tag: 'g' } : e);
      const cv = document.createElement('canvas'); cv.width = 160; cv.height = 144;
      const g = window.NeoGame.create(cv, t, { hud: false });
      const gs = () => g.entities.filter(e => e.tag === 'g');
      if (!gs().length) return { none: true };
      const hiddenAtStart = gs().every(e => e.hidden);
      g.tick(0.6);
      const shown = gs().every(e => !e.hidden);
      const sprite = gs()[0].sprite;
      const facing = gs()[0].face;
      const moving = gs().some(e => !!e.goal);
      g.tick(0.5);
      const shots = g.entities.filter(e => e.def.bullet && e.foe).length;
      return { hiddenAtStart, shown, sprite, facing, moving, shots, fault: g.scriptFault };
    }""")
    a = report['actors']
    if a.get('none'): issues.append('no taggable actor in the test level')
    else:
        if not a['hiddenAtStart']: issues.append('hide did not take the actor off stage')
        if not a['shown']: issues.append('show did not bring it back')
        if a['sprite'] != 324: issues.append(f"setsprite left it as {a['sprite']}")
        if a['facing'] != -1: issues.append('face did not turn it')
        if not a['moving']: issues.append('move gave it nowhere to go')
        if a['shots'] < 1: issues.append('shoot fired nothing')
        if a.get('fault'): issues.append(f"actor script faulted: {a['fault']}")

    # a hidden actor is not there: it cannot be walked into
    report['hidden_is_gone'] = page.evaluate("""() => {
      const NL = String.fromCharCode(10);
      const t = JSON.parse(JSON.stringify(window.NeoGameTemplates.platformer));
      t.story = []; t.script = ['on start', '  hide "g"', 'end'].join(NL);
      t.entities = (t.entities || []).map(e => e.type === 'walker' ? { ...e, tag: 'g' } : e);
      const cv = document.createElement('canvas'); cv.width = 160; cv.height = 144;
      const g = window.NeoGame.create(cv, t, { hud: false });
      g.tick(1.6);                       // past the arrival grace
      const foe = g.entities.find(e => e.tag === 'g');
      if (!foe) return { none: true };
      const lives = g.lives;
      g.player.x = foe.x; g.player.y = foe.y;
      g.tick(1/60);
      return { lives, after: g.lives };
    }""")
    h = report['hidden_is_gone']
    if not h.get('none') and h['after'] < h['lives']:
        issues.append('standing inside a hidden actor still cost a life')

    # ---- still sealed ----
    report['sealed'] = page.evaluate("""() => {
      const NL = String.fromCharCode(10);
      const runaway = ['on start', '  while 1', '    wait 0', '  end', 'end'].join(NL);
      const t = JSON.parse(JSON.stringify(window.NeoGameTemplates.platformer));
      t.script = runaway; t.story = [];
      const cv = document.createElement('canvas'); cv.width = 160; cv.height = 144;
      const t0 = performance.now();
      const g = window.NeoGame.create(cv, t, { hud: false });
      for (let i = 0; i < 120; i++) g.tick(1/60);
      const ms = performance.now() - t0;
      // and a tick script that waits must not pile up a thread a frame
      const src2 = ['on tick', '  wait 1', '  give 0', 'end'].join(NL);
      const t2 = JSON.parse(JSON.stringify(window.NeoGameTemplates.platformer));
      t2.script = src2; t2.story = [];
      const cv2 = document.createElement('canvas'); cv2.width = 160; cv2.height = 144;
      const g2 = window.NeoGame.create(cv2, t2, { hud: false });
      for (let i = 0; i < 240; i++) g2.tick(1/60);
      return { ms: Math.round(ms), stillPlaying: g.state, threads: g2.scriptThreads,
               reach: (() => { try { return window.NeoScript.compile(
                 ['on start', '  message window', 'end'].join(NL)).errors.length > 0; } catch (e) { return 'threw'; } })() };
    }""")
    sd = report['sealed']
    if sd['ms'] > 3000: issues.append(f"a runaway script took {sd['ms']}ms of wall clock")
    if sd['threads'] is not None and sd['threads'] > 2:
        issues.append(f"a waiting tick script piled up {sd['threads']} threads")

    if err: issues.append(f'page errors: {err[:3]}')
    b.close()

print(json.dumps({'report': report, 'issues': issues}, indent=2))
print('\nThe script can describe a game.' if not issues else f'\n{len(issues)} issue(s).')
sys.exit(1 if issues else 0)
