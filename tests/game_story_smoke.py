"""A game is a world, a body, a goal - and a reason to care.

This covers the last part: who the player is, and who says what. Speech and
story are data on the spec, so they have to survive the same round trip the
level does, and they must never be able to change how the game plays.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json, sys
ROOT = Path('/Users/christophercohen/Documents/GitHub/neojutsu')
report = {}; issues = []

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    page = b.new_context(viewport={"width": 1512, "height": 1100}).new_page()
    err = []; page.on('pageerror', lambda e: err.append(str(e)))
    page.goto(ROOT.as_uri() + '/game.html'); page.wait_for_timeout(400)
    page.evaluate("localStorage.clear()"); page.reload(); page.wait_for_timeout(1800)

    # ---- the avatar matches the game ----
    report['avatars'] = page.evaluate("""() => {
      const S = window.NeoSprites, out = {};
      for (const [k, t] of Object.entries(window.NeoGameTemplates)) {
        const cv = document.createElement('canvas'); cv.width = 160; cv.height = 144;
        const g = window.NeoGame.create(cv, JSON.parse(JSON.stringify(t)), { hud: false });
        out[k] = { mode: t.mode, cat: t.cat, sprite: g.players[0].sprite,
                   vehicle: S.VEHICLES.has(g.players[0].sprite) };
      }
      return out;
    }""")
    for k, a in report['avatars'].items():
        if a['mode'] == 'racer' and not a['vehicle']:
            issues.append(f'{k}: a racing game whose player is not a vehicle')
        if a['mode'] == 'shmup' and not a['vehicle']:
            issues.append(f'{k}: a shooter in space whose player is not a craft')
        if a['mode'] in ('platform', 'topdown') and a['vehicle']:
            issues.append(f'{k}: a {a["mode"]} game whose player is a vehicle')

    # ---- beats fire on their cue, once each ----
    report['beats'] = page.evaluate("""() => {
      const t = JSON.parse(JSON.stringify(window.NeoGameTemplates.platformer));
      t.story = [
        { at: 0.5, text: 'one' },
        { score: 1, text: 'two' },
        { on: 'hurt', text: 'three' },
      ];
      const cv = document.createElement('canvas'); cv.width = 160; cv.height = 144;
      const g = window.NeoGame.create(cv, t, { hud: false });
      const seen = [];
      const note = () => { for (const bu of g.bubbles) if (!seen.includes(bu.text)) seen.push(bu.text); };
      g.tick(0.6); note();
      const afterTime = seen.slice();
      g.speak('', 'player');                       // empty lines are ignored
      const emptyIgnored = g.bubbles.length <= 1;
      // let the first bubble expire
      g.tick(4.0); note();
      const expired = g.bubbles.length === 0;
      return { seen, afterTime, expired, emptyIgnored };
    }""")
    bt = report['beats']
    if 'one' not in bt['afterTime']: issues.append('a beat cued by time did not fire')
    if not bt['expired']: issues.append('a bubble never expires')
    if not bt['emptyIgnored']: issues.append('an empty line becomes a bubble')

    # a beat must not fire twice
    report['once'] = page.evaluate("""() => {
      const t = JSON.parse(JSON.stringify(window.NeoGameTemplates.platformer));
      t.story = [{ at: 0.2, text: 'only once' }];
      const cv = document.createElement('canvas'); cv.width = 160; cv.height = 144;
      const g = window.NeoGame.create(cv, t, { hud: false });
      let times = 0, had = false;
      for (let i = 0; i < 600; i++) {
        g.tick(1/60);
        const on = g.bubbles.some(x => x.text === 'only once');
        if (on && !had) times++;
        had = on;
      }
      return { times };
    }""")
    if report['once']['times'] != 1:
        issues.append(f"a beat fired {report['once']['times']} times, not once")

    # restarting the game tells the story again from the top
    report['restart'] = page.evaluate("""() => {
      const t = JSON.parse(JSON.stringify(window.NeoGameTemplates.platformer));
      t.story = [{ at: 0.2, text: 'again' }];
      const cv = document.createElement('canvas'); cv.width = 160; cv.height = 144;
      const g = window.NeoGame.create(cv, t, { hud: false });
      g.tick(0.4);
      const first = g.bubbles.some(x => x.text === 'again');
      g.tick(5); g.reset(); g.tick(0.4);
      return { first, afterReset: g.bubbles.some(x => x.text === 'again') };
    }""")
    if not report['restart']['first'] or not report['restart']['afterReset']:
        issues.append('the story does not start again when the game does')

    # ---- talking from a script, still sealed ----
    report['script'] = page.evaluate("""() => {
      const ok = window.NeoScript.compile('on start\\n  talk "hello"\\nend');
      const two = window.NeoScript.compile('on start\\n  talk "guard" "halt"\\nend');
      const bad = window.NeoScript.compile('on start\\n  talk\\nend');
      const t = JSON.parse(JSON.stringify(window.NeoGameTemplates.platformer));
      t.script = 'on start\\n  talk "hello"\\nend';
      const cv = document.createElement('canvas'); cv.width = 160; cv.height = 144;
      const g = window.NeoGame.create(cv, t, { hud: false });
      g.tick(1/60);
      return { oneArg: ok.errors, twoArgs: two.errors, noArgs: bad.errors,
               said: g.bubbles.map(x => x.text) };
    }""")
    sc = report['script']
    if sc['oneArg']: issues.append(f"talk with one value did not compile: {sc['oneArg']}")
    if sc['twoArgs']: issues.append(f"talk with a speaker did not compile: {sc['twoArgs']}")
    if not sc['noArgs']: issues.append('talk with no value compiled anyway')
    if 'hello' not in sc['said']: issues.append('a script that talks said nothing')

    # ---- speech cannot change the game ----
    report['inert'] = page.evaluate("""() => {
      const run = (story) => {
        const t = JSON.parse(JSON.stringify(window.NeoGameTemplates.platformer));
        if (story) t.story = story;
        const cv = document.createElement('canvas'); cv.width = 160; cv.height = 144;
        const g = window.NeoGame.create(cv, t, { hud: false });
        g.input.right = true;
        for (let i = 0; i < 300; i++) g.tick(1/60);
        return [Math.round(g.player.x), Math.round(g.player.y), g.score, g.lives, g.state];
      };
      const bare = run(null);
      const chatty = run(Array.from({ length: 40 }, (_, i) => ({ at: i * 0.1, text: 'line ' + i })));
      return { bare, chatty, same: JSON.stringify(bare) === JSON.stringify(chatty) };
    }""")
    if not report['inert']['same']:
        issues.append(f"a story changed the game: {report['inert']['bare']} vs {report['inert']['chatty']}")

    # ---- a shared spec with a broken story is refused ----
    report['validate'] = page.evaluate("""() => {
      const base = () => JSON.parse(JSON.stringify(window.NeoGameTemplates.platformer));
      const c = {};
      let s = base(); s.story = 'nope'; c.notList = window.NeoGame.validate(s).ok;
      s = base(); s.story = [{ at: 1 }]; c.noText = window.NeoGame.validate(s).ok;
      s = base(); s.story = [{ text: 'hi' }]; c.noCue = window.NeoGame.validate(s).ok;
      s = base(); s.story = [{ at: 1, score: 2, text: 'hi' }]; c.twoCues = window.NeoGame.validate(s).ok;
      s = base(); s.story = [{ on: 'explode', text: 'hi' }]; c.badEvent = window.NeoGame.validate(s).ok;
      s = base(); s.story = Array.from({length: 80}, () => ({ at: 1, text: 'x' })); c.tooMany = window.NeoGame.validate(s).ok;
      s = base(); s.story = [{ at: 2, who: 'p2', text: 'fine' }]; c.goodOk = window.NeoGame.validate(s).ok;
      return c;
    }""")
    v = report['validate']
    for k in ('notList', 'noText', 'noCue', 'twoCues', 'badEvent', 'tooMany'):
        if v[k]: issues.append(f'validate accepted {k}')
    if not v['goodOk']: issues.append('validate rejected a good story')

    # ---- the hero, and the story, survive the editor ----
    page.evaluate("document.getElementById('g-hero-open').click()"); page.wait_for_timeout(500)
    page.evaluate("document.querySelectorAll('#g-decor-grid .decor-tile')[2].click()"); page.wait_for_timeout(500)
    page.evaluate("document.querySelectorAll('#g-hero-tints .tint')[2].click()"); page.wait_for_timeout(500)
    page.evaluate("document.getElementById('g-story-add').click()"); page.wait_for_timeout(400)
    saved = page.evaluate("(JSON.parse(localStorage.getItem('neojutsu.game.v1')||'{}').spec||{})")
    report['editor'] = {'sprite': (saved.get('player') or {}).get('sprite'),
                        'tint': (saved.get('player') or {}).get('tint'),
                        'beats': len(saved.get('story') or [])}
    if not isinstance(report['editor']['sprite'], int): issues.append('the hero designer saved no sprite')
    if not report['editor']['tint']: issues.append('the hero designer saved no colour')
    if report['editor']['beats'] < 1: issues.append('adding a beat saved nothing')
    page.evaluate("document.getElementById('g-undo').click()"); page.wait_for_timeout(500)
    after = page.evaluate("(JSON.parse(localStorage.getItem('neojutsu.game.v1')||'{}').spec||{})")
    report['editor']['beatsAfterUndo'] = len(after.get('story') or [])
    if report['editor']['beatsAfterUndo'] >= report['editor']['beats']:
        issues.append('undo did not take the beat back')

    if err: issues.append(f'page errors: {err[:3]}')
    b.close()

print(json.dumps({'report': report, 'issues': issues}, indent=2))
print('\nCharacters look right, and they can talk.' if not issues else f'\n{len(issues)} issue(s).')
sys.exit(1 if issues else 0)
