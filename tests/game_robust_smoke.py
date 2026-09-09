"""Nothing a spec can say should be able to break the engine.

These games come from a generator today and from a model tomorrow, and a
model will send malformed ones - a width of minus four, a tile character that
is not a tile, an entity at NaN, a script that never finishes. The contract is
that `validate` says what is wrong and `create` either builds something or
raises cleanly; what must not happen is a page that dies halfway through and
takes the studio with it.
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
    page.wait_for_function('!!(window.NeoGame && window.NeoScript)', timeout=20000)

    report['awkward'] = page.evaluate("""() => {
      const NL = String.fromCharCode(10);
      const flat = (w, h, ch) => Array.from({length: h}, () => (ch||'0').repeat(w)).join(NL);
      const base = () => ({
        mode: 'platform', seed: 'x', sky0: '#111', sky1: '#222',
        player: { char: 'hero' }, start: { x: 8, y: 8 }, lives: 3,
        level: { w: 20, h: 18, tiles: flat(20, 18) },
        entities: [], props: [], rules: { collect: 0, keys: 0 }, story: [], script: '',
      });
      const cases = {
        'no level':            (s) => { delete s.level; },
        'negative size':       (s) => { s.level.w = -4; s.level.h = -4; },
        'enormous':            (s) => { s.level.w = 4000; s.level.h = 4000; },
        'one tile':            (s) => { s.level = { w: 1, h: 1, tiles: '0' }; },
        'tiles too short':     (s) => { s.level.tiles = '000'; },
        'tiles not text':      (s) => { s.level.tiles = 42; },
        'unknown tile letter': (s) => { s.level.tiles = flat(20, 18, 'z'); },
        'entity at NaN':       (s) => { s.entities = [{ type: 'coin', x: NaN, y: NaN }]; },
        'entity type unknown': (s) => { s.entities = [{ type: 'wyvern', x: 8, y: 8 }]; },
        'entities not a list': (s) => { s.entities = 'lots'; },
        'start off the map':   (s) => { s.start = { x: -9999, y: -9999 }; },
        'start not an object': (s) => { s.start = 'here'; },
        'lives absurd':        (s) => { s.lives = 1e9; },
        'rules contradictory': (s) => { s.rules = { collect: 99, keys: 99 }; },
        'mode unknown':        (s) => { s.mode = 'chess'; },
        'script gibberish':    (s) => { s.script = 'on start' + NL + '  frobnicate 3' + NL + 'end'; },
        'script never ends':   (s) => { s.script = 'on start' + NL + '  while 1' + NL + '    give 0'
                                                  + NL + '  end' + NL + 'end'; },
        'script enormous':     (s) => { s.script = 'on start' + NL
                                                  + ('  give 1' + NL).repeat(4000) + 'end'; },
        'story not a list':    (s) => { s.story = 'once upon a time'; },
        'story beat rubbish':  (s) => { s.story = [{ at: 'soon', text: null }]; },
        'props rubbish':       (s) => { s.props = [{ i: 'x', x: null, y: undefined }]; },
        'levels empty':        (s) => { s.levels = []; },
        'levels not a list':   (s) => { s.levels = 'three'; },
        'deep nonsense':       (s) => { s.player = { char: {} }; s.rules = null; },
      };
      const out = {};
      for (const [name, bend] of Object.entries(cases)) {
        const s = base();
        try { bend(s); } catch (e) { out[name] = { threw: 'while building the case' }; continue; }
        const row = {};
        try {
          const v = window.NeoGame.validate(s);
          row.valid = v.ok;
          row.said = (v.errors || []).length;
        } catch (e) { row.validateThrew = String(e).slice(0, 60); }
        try {
          const cv = document.createElement('canvas'); cv.width = 160; cv.height = 144;
          const g = window.NeoGame.create(cv, JSON.parse(JSON.stringify(s)), { hud: false });
          // a few seconds of it, which is where a bad spec usually bites
          for (let k = 0; k < 60 * 3; k++) g.tick(1/60);
          g.draw();
          row.ran = true;
          row.state = g.state;
          row.fault = g.scriptFault ? 'yes' : '';
        } catch (e) { row.createThrew = String(e).slice(0, 80); }
        out[name] = row;
      }
      return out;
    }""")

    aw = report['awkward']
    for name, row in aw.items():
        if row.get('validateThrew'):
            issues.append(f'{name}: validate threw - {row["validateThrew"]}')
        # Building a game the validator has rejected may fail, but it has to
        # fail cleanly rather than leave a half-built engine running.
        if row.get('createThrew') and row.get('valid'):
            issues.append(f'{name}: validate passed it and create threw - {row["createThrew"]}')
        if row.get('ran') and row.get('valid') is False and row.get('said', 0) == 0:
            issues.append(f'{name}: rejected without saying why')

    # Everything the validator accepts must be playable for three seconds.
    accepted = [n for n, r in aw.items() if r.get('valid')]
    report['accepted'] = accepted
    for n in accepted:
        if not aw[n].get('ran'):
            issues.append(f'{n}: accepted but would not run')

    if err:
        issues.append(f'page errors: {err[:4]}')
    b.close()

print(json.dumps({'report': report, 'issues': issues}, indent=2))
print('\nNothing a spec can say breaks it.' if not issues else f'\n{len(issues)} issue(s).')
sys.exit(1 if issues else 0)
