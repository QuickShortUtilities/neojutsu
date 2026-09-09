"""Two shapes each, for the two modes that had one.

A racing level was always the same wandering road and a vertical shooter was
always the same open lane, so "generate another one" gave you the same game
with different bumps in it - which is the one-game complaint again, a level
down. A road that splits round an island and a climb up the inside of a
fortress are different problems, not different scenery.

What this guards is the part that is easy to get wrong: a scrolling level
carries you into whatever is in front of you, so every row has to be
passable, and nothing may be sealed inside the wall.
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

    rows = page.evaluate("""() => {
      const out = [];
      const P = [['racer','a rally stage'], ['racer','a car race'], ['racer','a driving level'],
                 ['shmup','a space shooter'], ['shmup','a starfighter run'],
                 ['shmup','a dogfight in space']];
      for (const [mode, p] of P)
        for (let i = 0; i < 14; i++) {
          const g0 = NeoGameGen.generate(p, 's' + i);
          const s = g0.spec;
          if (s.mode !== mode) { out.push({ mode, p, wrong: s.mode }); continue; }
          const grid = s.level.tiles.split(String.fromCharCode(10));
          const T = NeoGame.TILES;
          const at = (x, y) => T[parseInt(grid[y][x], 36) || 0] || {};
          const solid = (x, y) => at(x, y).solid === true;
          // A brick you can shoot is a way through, not a wall - but only in
          // the mode that has a gun pointed at it.
          const blocks = (x, y) => solid(x, y)
            && !(mode === 'shmup' && at(x, y).breakable);

          /* Every row has somewhere to be. On a split road that means the
             widest single run, not the total: two two-tile channels are not
             a four-tile road. */
          let narrowest = 99, split = 0;
          for (let y = 3; y < s.level.h - 4; y++) {
            let best = 0, run = 0, runs = 0;
            for (let x = 0; x < s.level.w; x++) {
              if (blocks(x, y)) { if (run) runs++; run = 0; }
              else { run++; best = Math.max(best, run); }
            }
            if (run) runs++;
            narrowest = Math.min(narrowest, best);
            if (runs > 1) split++;
          }

          // Nothing alive inside the rock.
          const buried = (s.entities || []).filter(e =>
            solid(Math.min(s.level.w - 1, Math.floor(e.x / 8)),
                  Math.min(s.level.h - 1, Math.floor(e.y / 8)))).length;

          // And it moves: the same bar the corpus grades on.
          const g = NeoGame.create(document.createElement('canvas'),
                                   JSON.parse(JSON.stringify(s)), { hud: false });
          const info = (tx, ty) => NeoGame.TILES[g.level.at(tx, ty)] || {};
          const y0 = g.view.y;
          let far = 0;
          for (let k = 0; k < 60 * 14 && g.state === 'play'; k++) {
            const pl = g.player;
            const row = Math.max(0, Math.floor((pl.y + pl.h / 2) / 8) - 3);
            const here = Math.floor((pl.x + pl.w / 2) / 8);
            let L = here, R = here;
            while (L > 0 && info(L - 1, row).solid !== true && here - L < 12) L--;
            while (R < s.level.w - 1 && info(R + 1, row).solid !== true && R - here < 12) R++;
            const want = ((L + R) / 2) * 8 + 4;
            g.input.left = want < pl.x + pl.w / 2 - 3;
            g.input.right = want > pl.x + pl.w / 2 + 3;
            g.input.b = true;
            g.tick(1 / 60);
            far = Math.max(far, Math.abs(g.view.y - y0));
          }
          out.push({ mode, p, seed: 's' + i, shape: g0.understood.shape,
                     valid: NeoGame.validate(s).ok,
                     err: NeoGame.validate(s).errors.slice(0, 1),
                     narrowest, split, buried, far: Math.round(far),
                     ents: (s.entities || []).length });
        }
      return out;
    }""")

    seen = {}
    for r in rows:
        if r.get('wrong'):
            issues.append(f"{r['p']!r} made a {r['wrong']}")
            continue
        seen.setdefault(r['mode'], set()).add(r['shape'])
        tag = f"{r['shape']}/{r['seed']}"
        if not r['valid']: issues.append(f"{tag}: does not validate: {r['err']}")
        # Two tiles is sixteen pixels for a six-pixel body: tight, and
        # passable. One is not.
        if r['narrowest'] < 2:
            issues.append(f"{tag}: a row with only {r['narrowest']} tiles to pass through")
        if r['buried']: issues.append(f"{tag}: {r['buried']} pieces sealed inside the wall")
        if r['far'] < 24: issues.append(f"{tag}: a bot got {r['far']}px into it")

    report['shapes'] = {k: sorted(v) for k, v in seen.items()}
    for mode, want in (('racer', {'roadway', 'circuit'}), ('shmup', {'starlane', 'starkeep'})):
        got = seen.get(mode, set())
        if got != want:
            issues.append(f'{mode} only ever builds {sorted(got)}, not {sorted(want)}')

    # The new road really does split, and the old one really does not.
    splits = {}
    for r in rows:
        if r.get('wrong'): continue
        splits.setdefault(r['shape'], []).append(r['split'])
    report['splitRows'] = {k: sorted(v)[len(v) // 2] for k, v in splits.items()}
    # A plain road has obstacles in it too, so the test is not "does it ever
    # split" but "does the one built to split do it a good deal more".
    if report['splitRows'].get('circuit', 0) <= report['splitRows'].get('roadway', 99):
        issues.append(f"a circuit splits no more than a plain road: {report['splitRows']}")

    report['rows'] = rows[:4]
    if err: issues.append(f'page errors: {err[:3]}')
    b.close()

print(json.dumps({'report': report, 'issues': issues}, indent=2))
print('\nTwo shapes each, and both of them drivable.' if not issues else f'\n{len(issues)} issue(s).')
sys.exit(1 if issues else 0)
