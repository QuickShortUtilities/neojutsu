"""A cave that comes at you.

The studio had science fiction as a paint job: an outpost that was a
platformer and a void run that was a vertical climb. This is the shape that
is only ever science fiction - a ship, a corridor and a gun - and it is a
different frame, not a different tileset: the world travels along x, the
gun points the way you are going, and the rock is the difficulty.

The thing worth guarding is fairness. A screen that carries you into a wall
you had no way to avoid is not hard, it is broken, so most of this measures
the corridor rather than the code.
"""
import json, sys, http.server, threading, functools, socketserver
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path('/Users/christophercohen/Documents/GitHub/neojutsu')
PROMPT = 'a gradius style side scrolling shooter through a cave'
issues, report = [], {}

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
srv = socketserver.TCPServer(('127.0.0.1', 0), handler)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

with sync_playwright() as pw:
    b = pw.chromium.launch()
    page = b.new_page()
    err = []
    page.on('pageerror', lambda e: err.append(str(e)))
    page.goto(f'http://127.0.0.1:{port}/game.html')
    page.wait_for_function('!!(window.NeoGameGen && window.NeoSprites && window.NeoSprites.loaded)',
                           timeout=30000)

    # ---- the words reach the mode, and only these words ----
    report['reading'] = page.evaluate("""() => {
      const said = {};
      for (const p of ['a gradius style side scrolling shooter through a cave',
                       'an r-type style horizontal shooter',
                       'a side-on shooter in a cave',
                       'a space shooter',            // still the vertical one
                       'a fixed shooter with waves of aliens'])
        said[p] = NeoGameGen.generate(p, 'k').spec.mode;
      return said;
    }""")
    r = report['reading']
    for p, m in r.items():
        want = 'scramble' if ('gradius' in p or 'r-type' in p or 'side-on' in p) else None
        if want and m != want: issues.append(f'{p!r} made a {m}')
    if r['a space shooter'] != 'shmup':
        issues.append(f"the plain space shooter stopped being a shmup: {r['a space shooter']}")
    if r['a fixed shooter with waves of aliens'] != 'invaders':
        issues.append('the fixed shooter stopped being invaders')

    # ---- the corridor is always flyable ----
    report['caves'] = page.evaluate("""() => {
      const out = [];
      for (const seed of ['a','b','c','d','e','f','g','h']) {
        const s = NeoGameGen.generate('a gradius style side scrolling shooter through a cave', seed).spec;
        const g = s.level.tiles.split(String.fromCharCode(10));
        // Open means you can fly through it, which the finish strip also is.
        const air = c => c === '0' || c === 'i';
        let least = 99, step = 0, closed = 0, pr = null, pf = null;
        // Up to the finish, which is deliberately open from roof to floor and
        // would otherwise read as the biggest cliff in the cave.
        for (let x = 0; x < s.level.w - 2; x++) {
          let top = 0; while (top < s.level.h && !air(g[top][x])) top++;
          let bot = s.level.h - 1; while (bot >= 0 && !air(g[bot][x])) bot--;
          if (top > bot) { closed++; continue; }
          least = Math.min(least, bot - top + 1);
          if (pr !== null) step = Math.max(step, Math.abs(top - pr), Math.abs(bot - pf));
          pr = top; pf = bot;
        }
        out.push({ seed, valid: NeoGame.validate(s).ok, w: s.level.w, h: s.level.h,
                   least, step, closed, cat: s.cat,
                   collect: (s.rules||{}).collect, shoots: !!(s.player||{}).attack,
                   props: (s.props||[]).length,
                   hasFinish: /i/.test(s.level.tiles),
                   onTrack: (s.props||[]).filter(p => p.b !== 1).length,
                   story: (s.story||[]).length });
      }
      return out;
    }""")
    for c in report['caves']:
        if not c['valid']: issues.append(f"{c['seed']}: does not validate")
        if c['closed']: issues.append(f"{c['seed']}: {c['closed']} columns with no way through")
        if c['least'] < 4: issues.append(f"{c['seed']}: corridor down to {c['least']} tiles")
        if c['step'] > 2: issues.append(f"{c['seed']}: the wall steps {c['step']} tiles in one column")
        if c['h'] != 18: issues.append(f"{c['seed']}: {c['h']} tiles tall, so it does not fit the screen")
        if c['w'] < 80: issues.append(f"{c['seed']}: only {c['w']} tiles of cave")
        if c['collect']: issues.append(f"{c['seed']}: asks for {c['collect']} pickups you fly past once")
        if not c['shoots']: issues.append(f"{c['seed']}: a ship with no gun")
        if c['onTrack']: issues.append(f"{c['seed']}: {c['onTrack']} pieces of scenery in the corridor")
        if c['story']: issues.append(f"{c['seed']}: speech bubbles at speed")
        if not c['hasFinish']: issues.append(f"{c['seed']}: no finish you can see coming")
        if c['cat'] != 'scifi': issues.append(f"{c['seed']}: filed under {c['cat']}")

    # ---- and it flies: the world travels, the gun points forward, it ends ----
    report['flying'] = page.evaluate("""() => {
      const s = NeoGameGen.generate('a gradius style side scrolling shooter through a cave', 'e').spec;
      const g = NeoGame.create(document.createElement('canvas'),
                               JSON.parse(JSON.stringify(s)), { hud: false });
      const x0 = g.view.x;
      g.tick(1/60); g.tick(1/60);
      const travelled = g.view.x > x0;
      // the gun points along the corridor, not up it
      g.input.b = true;
      for (let k = 0; k < 6; k++) g.tick(1/60);
      const shots = g.entities.filter(e => e.alive && e.def.bullet);
      const forward = shots.length ? shots.every(e => e.vx > 0 && e.vy === 0) : false;
      // a shot has to outrun the screen or it never leaves the ship
      const outruns = shots.length ? shots.every(e => e.vx > 90) : false;

      // fly it to the end
      const solid = (tx,ty) => (NeoGame.TILES[g.level.at(tx,ty)]||{}).solid === true;
      let t = 0;
      for (let k = 0; k < 60*150 && g.state === 'play'; k++) {
        const p = g.player;
        const col = Math.min(s.level.w-1, Math.floor((p.x+p.w+10)/8));
        const hy = Math.floor((p.y+p.h/2)/8);
        let u = hy, d = hy;
        while (u > 0 && !solid(col,u-1) && hy-u < 12) u--;
        while (d < s.level.h-1 && !solid(col,d+1) && d-hy < 12) d++;
        const want = ((u+d)/2)*8+4;
        g.input.up = want < p.y+p.h/2-3; g.input.down = want > p.y+p.h/2+3;
        g.input.b = true;
        g.tick(1/60); t += 1/60;
      }
      return { travelled, forward, outruns, shots: shots.length,
               state: g.state, secs: +t.toFixed(1) };
    }""")
    f = report['flying']
    if not f['travelled']: issues.append('the cave does not come to you')
    if not f['shots']: issues.append('holding the trigger fired nothing')
    if not f['forward']: issues.append('the gun does not point along the corridor')
    if not f['outruns']: issues.append('a shot cannot outrun the screen it is fired on')
    if f['state'] != 'won': issues.append(f"flying it properly ended {f['state']}")
    if not (6 < f['secs'] < 40): issues.append(f"a run lasts {f['secs']}s")

    # ---- rock kills; that is the whole of the difficulty ----
    report['rock'] = page.evaluate("""() => {
      const s = NeoGameGen.generate('a gradius style side scrolling shooter through a cave', 'e').spec;
      const g = NeoGame.create(document.createElement('canvas'),
                               JSON.parse(JSON.stringify(s)), { hud: false });
      const lives = g.lives;
      for (let k = 0; k < 60*4 && g.state === 'play'; k++) { g.input.up = true; g.tick(1/60); }
      return { lives, after: g.lives, state: g.state };
    }""")
    if report['rock']['after'] >= report['rock']['lives']:
        issues.append('flying into the roof costs nothing')

    # ---- reaching the end short of a pickup count ends, rather than hanging ----
    report['short'] = page.evaluate("""() => {
      const s = NeoGameGen.generate('a gradius style side scrolling shooter through a cave', 'e').spec;
      s.rules = { collect: 99, keys: 0 };          // impossible on purpose
      const g = NeoGame.create(document.createElement('canvas'), s, { hud: false });
      const solid = (tx,ty) => (NeoGame.TILES[g.level.at(tx,ty)]||{}).solid === true;
      for (let k = 0; k < 60*150 && g.state === 'play'; k++) {
        const p = g.player;
        const col = Math.min(s.level.w-1, Math.floor((p.x+p.w+10)/8));
        const hy = Math.floor((p.y+p.h/2)/8);
        let u = hy, d = hy;
        while (u > 0 && !solid(col,u-1) && hy-u < 12) u--;
        while (d < s.level.h-1 && !solid(col,d+1) && d-hy < 12) d++;
        const want = ((u+d)/2)*8+4;
        g.input.up = want < p.y+p.h/2-3; g.input.down = want > p.y+p.h/2+3;
        g.tick(1/60);
      }
      return { state: g.state, message: g.message };
    }""")
    if report['short']['state'] == 'play':
        issues.append('arriving short of the count never ends: the run hangs at the last frame')

    if err: issues.append(f'page errors: {err[:3]}')
    b.close()

print(json.dumps({'report': report, 'issues': issues}, indent=2))
print('\nA ship, a corridor and a gun.' if not issues else f'\n{len(issues)} issue(s).')
sys.exit(1 if issues else 0)
