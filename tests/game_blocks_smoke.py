"""A game with nobody in it.

Every other mode here is a body moving through a level. A falling-block game
is the other way about: the thing you steer becomes the level when it lands,
and it ends when there is no room to put the next one. It takes the tilemap,
the renderer, the palette, the HUD and the packaging as they are - what it
brings is its own idea of a frame, and that is what this checks.
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

with sync_playwright() as pw:
    b = pw.chromium.launch()
    page = b.new_page()
    err = []
    page.on('pageerror', lambda e: err.append(str(e)))
    page.goto(f'http://127.0.0.1:{port}/game.html')
    page.wait_for_function('!!(window.NeoGameGen && window.NeoSprites && window.NeoSprites.loaded)',
                           timeout=30000)

    report['built'] = page.evaluate("""() => {
      const g0 = NeoGameGen.generate('a tetris style falling blocks game', 'tb');
      const s = g0.spec, v = NeoGame.validate(s);
      const rows = s.level.tiles.split(String.fromCharCode(10));
      // the well: the open run across the top, taken outwards from the middle
      const W = s.level.w;
      let l = Math.floor(W/2), r = l;
      while (l > 0 && rows[0][l-1] === '0') l--;
      while (r < W-1 && rows[0][r+1] === '0') r++;
      return { mode: s.mode, valid: v.ok, errors: v.errors.slice(0,2),
               rules: s.rules, well: [l, r], size: [s.level.w, s.level.h],
               cast: (s.entities||[]).length, props: (s.props||[]).length };
    }""")
    bt = report['built']
    if bt['mode'] != 'blocks': issues.append(f"asked for falling blocks, got {bt['mode']}")
    if not bt['valid']: issues.append(f"a block game does not validate: {bt['errors']}")
    if not (bt['rules'] or {}).get('lines'): issues.append('no line target, so it cannot be won')
    if bt['well'][1] - bt['well'][0] < 6:
        issues.append(f"the well is {bt['well']} - too narrow to play in")
    if bt['cast'] or bt['props']:
        issues.append(f"a well has no cast and no scenery ({bt['cast']}, {bt['props']})")

    # ---- the piece: it falls, it steers, it turns, it locks ----
    report['piece'] = page.evaluate("""() => {
      const s = NeoGameGen.generate('a tetris style falling blocks game', 'tb').spec;
      const g = NeoGame.create(document.createElement('canvas'),
                               JSON.parse(JSON.stringify(s)), { hud: false });
      const filled = () => { let n=0;
        for (let y=0;y<s.level.h;y++) for (let x=0;x<s.level.w;x++) if (g.level.at(x,y)) n++;
        return n; };
      g.tick(1/60);
      const p0 = g.piece ? { x: g.piece.x, y: g.piece.y, turn: g.piece.turn } : null;
      const before = filled();
      // steering
      g.input.left = true; g.tick(0.5); g.input.left = false;
      const movedLeft = g.piece && g.piece.x < p0.x;
      const t0 = g.piece ? g.piece.turn : null;
      g.input.a = true; g.tick(1/60); g.input.a = false;
      const turned = g.piece && g.piece.turn !== t0;
      // a soft drop has to bite at once, not when the slow interval runs out
      const y0 = g.piece ? g.piece.y : null;
      g.input.down = true; g.tick(0.4); g.input.down = false;
      const dropped = g.piece ? g.piece.y - y0 : 0;
      /* And something must eventually land. Watched frame by frame rather
         than by comparing the two ends: a piece that lands and completes a
         row at the same moment leaves the count exactly where it was. */
      g.input.down = true;
      let landed = false;
      let prev = filled();
      for (let k = 0; k < 60*20 && !landed && g.state === 'play'; k++) {
        g.tick(1/60);
        const now = filled();
        if (now !== prev || g.lines > 0) landed = true;
        prev = now;
      }
      return { movedLeft, turned, dropped, locked: landed, state: g.state };
    }""")
    pc = report['piece']
    if not pc['movedLeft']: issues.append('the piece does not steer')
    if not pc['turned']: issues.append('the piece does not turn')
    if pc['dropped'] < 3: issues.append(f"a soft drop moved it {pc['dropped']} rows in 0.4s")
    if not pc['locked']: issues.append('nothing ever lands')

    # ---- a full row comes out, and everything above it comes down ----
    report['clear'] = page.evaluate("""() => {
      const s = NeoGameGen.generate('a tetris style falling blocks game', 'tb').spec;
      const W = s.level.w, H = s.level.h;
      const rows = s.level.tiles.split(String.fromCharCode(10));
      let l = Math.floor(W/2), r = l;
      while (l > 0 && rows[0][l-1] === '0') l--;
      while (r < W-1 && rows[0][r+1] === '0') r++;
      // a clean well, so this is about clearing and nothing else
      const clean = [];
      for (let y = 0; y < H; y++) { let line = '';
        for (let x = 0; x < W; x++)
          line += (x === l-1 || x === r+1) ? '2' : (y === H-1 && x >= l && x <= r) ? '2' : '0';
        clean.push(line); }
      s.level.tiles = clean.join(String.fromCharCode(10));
      s.rules = { collect: 0, keys: 0, lines: 2 };
      const g = NeoGame.create(document.createElement('canvas'),
                               JSON.parse(JSON.stringify(s)), { hud: false });
      g.tick(1/60);
      // fill the row above the floor, and put a marker one row higher
      for (let x = l; x <= r; x++) g.setTile(x, H-2, 1);
      g.setTile(l, H-3, 7);
      const count = y => { let n=0; for (let x=l;x<=r;x++) if (g.level.at(x,y)) n++; return n; };
      const before = { row: count(H-2), marker: g.level.at(l, H-3), lines: g.lines };
      g.input.down = true;
      for (let k = 0; k < 60*10 && g.lines === 0 && g.state === 'play'; k++) g.tick(1/60);
      return { before, lines: g.lines, score: g.score,
               // the marker should have fallen into the row that came out
               markerNowAt: g.level.at(l, H-2), rowNow: count(H-2) };
    }""")
    cl = report['clear']
    if cl['before']['row'] != (bt['well'][1] - bt['well'][0] + 1) and cl['before']['row'] < 8:
        issues.append(f"could not fill a row by hand ({cl['before']['row']})")
    if not cl['lines']: issues.append('a full row did not come out')
    if cl['lines'] and not cl['score']: issues.append('clearing a row scored nothing')

    # ---- and it ends when there is no room ----
    report['stackOut'] = page.evaluate("""() => {
      const s = NeoGameGen.generate('a tetris style falling blocks game', 'tb').spec;
      const g = NeoGame.create(document.createElement('canvas'),
                               JSON.parse(JSON.stringify(s)), { hud: false });
      // pile everything in one column and it must stop, not run for ever
      for (let k = 0; k < 60*180 && g.state === 'play'; k++) {
        g.input.down = true; g.input.left = true;
        g.tick(1/60);
      }
      return { state: g.state, message: g.message };
    }""")
    if report['stackOut']['state'] != 'over':
        issues.append('piling into one column never ends the game')

    if err: issues.append(f'page errors: {err[:3]}')
    b.close()

print(json.dumps({'report': report, 'issues': issues}, indent=2))
print('\nA game with nobody in it still plays.' if not issues else f'\n{len(issues)} issue(s).')
sys.exit(1 if issues else 0)
