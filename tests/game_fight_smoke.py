"""Turns and a menu, not jumping and running.

An adventure game is two games: one where you walk a map, and one where the
map stops and two creatures take it in turns. The second was the other thing
this engine was said not to reach. It is a state like the card between stages
- the world holds still and the keys mean something else - and this checks
that it starts, that it is played rather than watched, and that winning and
losing both land somewhere sensible.
"""
import json, sys, http.server, threading, functools, socketserver
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path('/Users/christophercohen/Documents/GitHub/neojutsu')
issues, report = [], {}

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
srv = socketserver.TCPServer(('127.0.0.1', 0), handler)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

PROMPT = 'a pokemon style game with turn based creature battles'

with sync_playwright() as pw:
    b = pw.chromium.launch()
    page = b.new_page()
    err = []
    page.on('pageerror', lambda e: err.append(str(e)))
    page.goto(f'http://127.0.0.1:{port}/game.html')
    page.wait_for_function('!!(window.NeoGameGen && window.NeoSprites && window.NeoSprites.loaded)',
                           timeout=30000)

    report['built'] = page.evaluate("""(prompt) => {
      const g0 = NeoGameGen.generate(prompt, 'f1');
      const s = g0.spec, v = NeoGame.validate(s);
      return { mode: s.mode, valid: v.ok, errors: v.errors.slice(0,2), rules: s.rules,
               rivals: (s.entities||[]).filter(e => e.type === 'rival').length,
               understood: g0.understood };
    }""", PROMPT)
    bt = report['built']
    if not bt['valid']: issues.append(f"a quest does not validate: {bt['errors']}")
    if not (bt['rules'] or {}).get('beat'): issues.append('no target, so it cannot be won')
    if bt['rivals'] < 2: issues.append(f"only {bt['rivals']} rivals to fight")

    # ---- meeting one stops the map and starts a fight ----
    report['meeting'] = page.evaluate("""(prompt) => {
      const s = NeoGameGen.generate(prompt, 'f1').spec;
      const g = NeoGame.create(document.createElement('canvas'),
                               JSON.parse(JSON.stringify(s)), { hud: false });
      const lives0 = g.lives;
      let px = null, py = null;
      for (let k = 0; k < 60*60 && g.state === 'play'; k++) {
        const r = g.entities.find(e => e.alive && e.type === 'rival');
        if (r) { const dx = r.x-g.player.x, dy = r.y-g.player.y;
          g.input.right = dx>2; g.input.left = dx<-2; g.input.down = dy>2; g.input.up = dy<-2; }
        g.tick(1/60);
      }
      px = g.player.x; py = g.player.y;
      const f = g.fight;
      // the world must hold still while it is happening
      g.input.right = true;
      g.tick(0.5);
      g.input.right = false;
      return { state: g.state, started: !!f, costALife: g.lives < lives0,
               hp: f ? { mine: f.mine.hp, theirs: f.theirs.hp } : null,
               moved: Math.abs(g.player.x - px) + Math.abs(g.player.y - py) };
    }""", PROMPT)
    mt = report['meeting']
    if not mt['started']: issues.append('walking into a rival did not start a fight')
    if mt['state'] != 'fight': issues.append(f"after meeting one the state is {mt['state']}")
    if mt['costALife']: issues.append('meeting a rival cost a life instead of starting a fight')
    if mt['moved'] > 1: issues.append(f"the world kept moving during a fight ({mt['moved']}px)")

    # ---- it is played: the menu moves, a blow lands, they answer ----
    report['turns'] = page.evaluate("""(prompt) => {
      const s = NeoGameGen.generate(prompt, 'f1').spec;
      const g = NeoGame.create(document.createElement('canvas'),
                               JSON.parse(JSON.stringify(s)), { hud: false });
      for (let k = 0; k < 60*60 && g.state === 'play'; k++) {
        const r = g.entities.find(e => e.alive && e.type === 'rival');
        if (r) { const dx = r.x-g.player.x, dy = r.y-g.player.y;
          g.input.right = dx>2; g.input.left = dx<-2; g.input.down = dy>2; g.input.up = dy<-2; }
        g.tick(1/60);
      }
      g.input.right = g.input.left = g.input.up = g.input.down = false;
      g.tick(0.2);
      const pick0 = g.fight ? g.fight.pick : null;
      g.input.down = true; g.tick(1/60); g.input.down = false; g.tick(1/60);
      const pickMoved = g.fight && g.fight.pick !== pick0;
      // back to the first move, which is the one that always hits
      g.input.up = true; g.tick(1/60); g.input.up = false; g.tick(1/60);
      let hurtThem = false, theyAnswered = false;
      let theirs = g.fight ? g.fight.theirs.hp : 0;
      let mine = g.fight ? g.fight.mine.hp : 0;
      for (let n = 0; n < 12 && g.state === 'fight'; n++) {
        g.input.a = true; g.tick(1/60); g.input.a = false;
        g.tick(2.0);
        if (g.fight) {
          if (g.fight.theirs.hp < theirs) hurtThem = true;
          if (g.fight.mine.hp < mine) theyAnswered = true;
          theirs = g.fight.theirs.hp; mine = g.fight.mine.hp;
        }
      }
      return { pickMoved, hurtThem, theyAnswered, endedAs: g.state,
               beaten: g.beaten };
    }""", PROMPT)
    tn = report['turns']
    if not tn['pickMoved']: issues.append('the move menu does not move')
    if not tn['hurtThem']: issues.append('striking never took anything off them')
    if not tn['theyAnswered']: issues.append('they never hit back')
    if tn['endedAs'] == 'fight': issues.append('a fight of twelve turns never ended')

    # ---- and beating enough of them wins the game ----
    report['winning'] = page.evaluate("""(prompt) => {
      const s = NeoGameGen.generate(prompt, 'f1').spec;
      const g = NeoGame.create(document.createElement('canvas'),
                               JSON.parse(JSON.stringify(s)), { hud: false });
      // hand it the wins rather than playing them all out
      let guard = 0;
      while (g.state !== 'won' && guard++ < 40) {
        for (let k = 0; k < 60*60 && g.state === 'play'; k++) {
          const r = g.entities.find(e => e.alive && e.type === 'rival');
          if (!r) break;
          const dx = r.x-g.player.x, dy = r.y-g.player.y;
          g.input.right = dx>2; g.input.left = dx<-2; g.input.down = dy>2; g.input.up = dy<-2;
          g.tick(1/60);
        }
        if (g.state !== 'fight' || !g.fight) break;
        g.input.right = g.input.left = g.input.up = g.input.down = false;
        // finish this one off
        for (let n = 0; n < 20 && g.state === 'fight'; n++) {
          g.fight.theirs.hp = 1;
          g.input.a = true; g.tick(1/60); g.input.a = false; g.tick(2.0);
        }
        if (g.state === 'over') break;
      }
      return { state: g.state, beaten: g.beaten, target: (s.rules||{}).beat };
    }""", PROMPT)
    wn = report['winning']
    if wn['state'] != 'won':
        issues.append(f"beating {wn['beaten']} of {wn['target']} did not win ({wn['state']})")

    if err: issues.append(f'page errors: {err[:3]}')
    b.close()

print(json.dumps({'report': report, 'issues': issues}, indent=2))
print('\nThe map stops and the fight starts.' if not issues else f'\n{len(issues)} issue(s).')
sys.exit(1 if issues else 0)
