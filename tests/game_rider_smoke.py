"""A bike over hills, where the question is what angle you land at.

Every other side-on game here asks whether you can reach the ledge. This one
never asks that - the throttle is always on - and asks instead what attitude
you are in when the ground comes back. So: it moves without being told to,
it can be tilted in the air, a bad landing costs something, and a course can
be finished by somebody riding it properly.
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

PROMPT = 'a motocross rider over hills'

with sync_playwright() as pw:
    b = pw.chromium.launch()
    page = b.new_page()
    err = []
    page.on('pageerror', lambda e: err.append(str(e)))
    page.goto(f'http://127.0.0.1:{port}/game.html')
    page.wait_for_function('!!(window.NeoGameGen && window.NeoSprites && window.NeoSprites.loaded)',
                           timeout=30000)

    report['built'] = page.evaluate("""(prompt) => {
      const g0 = NeoGameGen.generate(prompt, 'rd');
      const s = g0.spec, v = NeoGame.validate(s);
      return { mode: s.mode, valid: v.ok, errors: v.errors.slice(0,2),
               size: [s.level.w, s.level.h], props: (s.props||[]).length,
               // scenery is allowed behind the course, never on the riding line
               onTrack: (s.props||[]).filter(p => p.b !== 1).length,
               // a course ends at a strip you ride into, not at a flag
               hasFinish: /i/.test(s.level.tiles) };
    }""", PROMPT)
    bt = report['built']
    if bt['mode'] != 'rider': issues.append(f"asked for a rider, got {bt['mode']}")
    if not bt['valid']: issues.append(f"a course does not validate: {bt['errors']}")
    if not bt['hasFinish']: issues.append('a course with no finish on it')
    if bt['size'][0] < 40: issues.append(f"a course only {bt['size'][0]} tiles long")
    if bt['onTrack']:
        issues.append(f"{bt['onTrack']} pieces of scenery standing on the track")
    if not bt['props']:
        issues.append('a course with nothing at all behind it')

    report['riding'] = page.evaluate("""(prompt) => {
      const s = NeoGameGen.generate(prompt, 'rd').spec;
      const g = NeoGame.create(document.createElement('canvas'),
                               JSON.parse(JSON.stringify(s)), { hud: false });
      // the throttle is always on: it goes without being asked
      const x0 = g.player.x;
      g.tick(1.5);
      const rolled = g.player.x - x0;
      // and it can be tilted in the air
      g.input.a = true; g.tick(1/60); g.input.a = false; g.tick(0.15);
      const p0 = g.player.pitch;
      g.input.up = true; g.tick(0.3); g.input.up = false;
      const tilted = Math.abs(g.player.pitch - p0);
      return { rolled: Math.round(rolled), tilted: Math.round(tilted * 100) / 100,
               airborne: !g.player.grounded };
    }""", PROMPT)
    rd = report['riding']
    if rd['rolled'] < 40:
        issues.append(f"the throttle moved it {rd['rolled']}px in a second and a half")
    if rd['tilted'] < 0.3:
        issues.append(f"holding up tilted it by {rd['tilted']} radians")

    # ---- a bad landing costs something, a good one does not ----
    report['landing'] = page.evaluate("""(prompt) => {
      const ride = (correct) => {
        const s = NeoGameGen.generate(prompt, 'rd').spec;
        const g = NeoGame.create(document.createElement('canvas'),
                                 JSON.parse(JSON.stringify(s)), { hud: false });
        let crashes = 0, was = false;
        for (let k = 0; k < 60*45 && g.state === 'play'; k++) {
          if (correct) {
            g.input.up = g.player.pitch > 0.06;
            g.input.down = g.player.pitch < -0.06;
          } else {
            g.input.up = !g.player.grounded;      // hang it right back
            g.input.down = false;
          }
          g.input.a = g.player.grounded && (k % 45) === 0;
          g.tick(1/60);
          if (g.player.crash > 0 && !was) { crashes++; was = true; }
          if (g.player.crash <= 0) was = false;
        }
        return { crashes, reached: Math.round(g.player.x/8), state: g.state };
      };
      return { level: ride(true), sloppy: ride(false) };
    }""", PROMPT)
    ld = report['landing']
    # The claim is not a number of spills - a short course gives few landings -
    # it is that the angle you land at is what decides them.
    if ld['sloppy']['crashes'] < 1:
        issues.append('landing at any angle never cost anything')
    if ld['level']['crashes'] >= ld['sloppy']['crashes']:
        issues.append(f"riding level ({ld['level']['crashes']}) came off no better "
                      f"than riding badly ({ld['sloppy']['crashes']})")

    # ---- and a course can be finished ----
    report['finishing'] = page.evaluate("""(prompt) => {
      let won = 0, ran = 0;
      for (let i = 0; i < 8; i++) {
        const s = NeoGameGen.generate(prompt, 'ride' + i).spec;
        if (s.mode !== 'rider') continue;
        ran++;
        const g = NeoGame.create(document.createElement('canvas'),
                                 JSON.parse(JSON.stringify(s)), { hud: false });
        for (let k = 0; k < 60*90 && g.state === 'play'; k++) {
          g.input.up = g.player.pitch > 0.06;
          g.input.down = g.player.pitch < -0.06;
          g.input.a = g.player.grounded && (k % 45) === 0;
          g.tick(1/60);
        }
        if (g.state === 'won') won++;
      }
      return { ran, won };
    }""", PROMPT)
    fn = report['finishing']
    if fn['won'] < 2:
        issues.append(f"only {fn['won']} of {fn['ran']} courses could be finished")

    if err: issues.append(f'page errors: {err[:3]}')
    b.close()

print(json.dumps({'report': report, 'issues': issues}, indent=2))
print('\nThe throttle is on and the landing matters.' if not issues
      else f'\n{len(issues)} issue(s).')
sys.exit(1 if issues else 0)
