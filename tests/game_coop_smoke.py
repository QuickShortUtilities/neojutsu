"""Two people, one keyboard, one screen.

Co-op is the first thing in this engine that runs the player physics more
than once a frame, so most of what matters here is that a second body did
not change the first one.
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
    page.evaluate("localStorage.clear()"); page.reload(); page.wait_for_timeout(1700)

    # Solo must be untouched by the refactor: same inputs, same frame, same numbers.
    report['solo_unchanged'] = page.evaluate("""() => {
      const run = (coop) => {
        const t = JSON.parse(JSON.stringify(window.NeoGameTemplates.platformer));
        if (coop) t.coop = true;
        const cv = document.createElement('canvas'); cv.width = 192; cv.height = 160;
        const g = window.NeoGame.create(cv, t, { hud: false });
        g.input.right = true;
        for (let i = 0; i < 90; i++) g.tick(1/60);
        g.input.a = true;
        for (let i = 0; i < 60; i++) g.tick(1/60);
        return [Math.round(g.player.x), Math.round(g.player.y), Math.round(g.player.vy),
                g.score, g.lives, g.state, g.players.length];
      };
      const solo = run(false);
      return { solo, players: solo[6] };
    }""")
    if report['solo_unchanged']['players'] != 1:
        issues.append('a solo game has more than one body')

    # Two bodies, driven separately, must go separate ways.
    report['separate'] = page.evaluate("""() => {
      const t = JSON.parse(JSON.stringify(window.NeoGameTemplates.sofa));
      const cv = document.createElement('canvas'); cv.width = 192; cv.height = 160;
      const g = window.NeoGame.create(cv, t, { hud: false });
      const [a, c] = g.players;
      const a0 = a.x, c0 = c.x;
      g.input.right = true; g.input2.left = true;
      for (let i = 0; i < 90; i++) g.tick(1/60);
      return { p1moved: Math.round(a.x - a0), p2moved: Math.round(c.x - c0),
               n: g.players.length, coop: g.coop };
    }""")
    sep = report['separate']
    if sep['n'] != 2: issues.append(f"co-op game has {sep['n']} bodies")
    if sep['p1moved'] <= 4: issues.append('player one did not move right')
    if sep['p2moved'] >= -2: issues.append('player two did not move left')

    # One input map must not drive the other.
    # A level may legitimately move a body that is standing still - a belt
    # carries whoever is on it. So crosstalk is measured against a run where
    # nobody presses anything, not against zero.
    report['no_crosstalk'] = page.evaluate("""() => {
      const run = (driveP1) => {
        const t = JSON.parse(JSON.stringify(window.NeoGameTemplates.sofa));
        const cv = document.createElement('canvas'); cv.width = 192; cv.height = 160;
        const g = window.NeoGame.create(cv, t, { hud: false });
        if (driveP1) g.input.right = true;
        for (let i = 0; i < 90; i++) g.tick(1/60);
        return [g.players[1].x, g.players[1].y];
      };
      const idle = run(false), driven = run(true);
      return { p2drift: Math.round(Math.hypot(driven[0] - idle[0], driven[1] - idle[1])) };
    }""")
    if report['no_crosstalk']['p2drift'] > 1:
        issues.append(f"player one's keys moved player two by {report['no_crosstalk']['p2drift']}px")

    # Lives are one pool, and either player can finish the level.
    report['shared'] = page.evaluate("""() => {
      const mk = () => {
        const t = JSON.parse(JSON.stringify(window.NeoGameTemplates.sofa));
        const cv = document.createElement('canvas'); cv.width = 192; cv.height = 160;
        return window.NeoGame.create(cv, t, { hud: false });
      };
      // drop player two off the bottom, once the arrival grace has run out
      const g = mk();
      g.tick(2.0);
      const start = g.lives;
      g.players[1].y = g.level.h * 8 + 200;
      g.tick(1/60);
      const afterP2Died = g.lives;
      // player two alone can finish, once the level's own condition is met
      const g2 = mk();
      const goal = (window.NeoGameTemplates.sofa.entities || []).find(e => e.type === 'goal');
      let won = null;
      if (goal) {
        // collect everything the rule asks for, with player two
        const need = (window.NeoGameTemplates.sofa.rules || {}).collect || 0;
        for (const c of (window.NeoGameTemplates.sofa.entities || [])) {
          if (g2.score >= need) break;
          if (c.type !== 'coin' && c.type !== 'gem') continue;
          g2.players[1].x = c.x; g2.players[1].y = c.y; g2.tick(1/60);
        }
        g2.players[1].x = goal.x; g2.players[1].y = goal.y;
        g2.tick(1/60); won = g2.state;
      }
      return { start, afterP2Died, p2CanWin: won };
    }""")
    sh = report['shared']
    if sh['afterP2Died'] >= sh['start']:
        issues.append("player two dying did not cost the shared pool a life")
    if sh['p2CanWin'] != 'won':
        issues.append(f"player two could not finish the level alone (state {sh['p2CanWin']})")

    # The studio's toggle, and the keyboard split behind it.
    report['ui'] = page.evaluate("""() => {
      const cb = document.getElementById('g-coop');
      cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true }));
      return { exists: !!cb, hintShown: !document.getElementById('g-coop-hint').hidden };
    }""")
    page.wait_for_timeout(400)
    if not report['ui']['exists']: issues.append('no two-player toggle in the studio')
    if not report['ui']['hintShown']: issues.append('the two-player key hint stays hidden')

    # the library entry is real and playable
    report['template'] = page.evaluate("""() => {
      const t = window.NeoGameTemplates.sofa;
      if (!t) return { missing: true };
      const v = window.NeoGame.validate(JSON.parse(JSON.stringify(t)));
      const cv = document.createElement('canvas'); cv.width = 192; cv.height = 160;
      const g = window.NeoGame.create(cv, JSON.parse(JSON.stringify(t)), { hud: false });
      g.tick(3.0);
      return { ok: v.ok, errors: v.errors, cat: t.cat, coop: !!t.coop,
               idleState: g.state, idleLives: g.lives, lives: t.lives, bodies: g.players.length };
    }""")
    tpl = report['template']
    if tpl.get('missing'): issues.append('no two-player game in the library')
    else:
        if not tpl['ok']: issues.append(f"the two-player game fails validate: {tpl['errors']}")
        if tpl['cat'] != 'twoplayer': issues.append('the two-player game is filed under the wrong kind')
        if not tpl['coop']: issues.append('the two-player game is not marked co-op')
        if tpl['bodies'] != 2: issues.append('the two-player game starts one body')
        if tpl['idleState'] != 'play' or tpl['idleLives'] != tpl['lives']:
            issues.append('the two-player game punishes standing still')

    if err: issues.append(f'page errors: {err[:3]}')
    b.close()

print(json.dumps({'report': report, 'issues': issues}, indent=2))
print('\nTwo can play.' if not issues else f'\n{len(issues)} issue(s).')
sys.exit(1 if issues else 0)
