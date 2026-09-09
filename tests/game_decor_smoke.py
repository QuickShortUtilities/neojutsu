"""Decor is scenery and only scenery.

The atlas carries 1078 drawings. Any of them can be dropped into a level, so
what matters here is that they survive the round trip (save, undo, package)
and that none of them can change how the game plays.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json, sys, tempfile
ROOT = Path('/Users/christophercohen/Documents/GitHub/neojutsu')
report = {}; issues = []

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    page = b.new_context(viewport={"width": 1512, "height": 1100}).new_page()
    err = []; page.on('pageerror', lambda e: err.append(str(e)))
    page.goto(ROOT.as_uri() + '/game.html'); page.wait_for_timeout(400)
    page.evaluate("localStorage.clear()"); page.reload(); page.wait_for_timeout(1600)
    if err: issues.append(f'load errors: {err[:2]}')

    # the atlas is up and every band is browsable
    report['atlas'] = page.evaluate("""() => {
      const S = window.NeoSprites;
      const bands = {};
      for (const [k] of S.BANDS) bands[k] = S.group(k).length;
      return { loaded: S.loaded, count: S.COUNT, bands,
               inkOnly: S.group('all').every(i => !!S.box(i)) };
    }""")
    a = report['atlas']
    if not a['loaded']: issues.append('atlas did not load')
    if a['bands']['all'] < 900: issues.append(f"only {a['bands']['all']} sprites browsable")
    if not a['inkOnly']: issues.append('a blank cell is offered as decor')
    for k, n in a['bands'].items():
        if n == 0: issues.append(f'band {k} is empty')

    # the strip fills and the picker opens
    report['ui'] = page.evaluate("""() => {
      const strip = document.querySelectorAll('#g-props .tilebtn').length;
      document.getElementById('g-decor-open').click();
      const open = !document.getElementById('g-decor').hidden;
      const tiles = document.querySelectorAll('#g-decor-grid .decor-tile').length;
      const cats = document.querySelectorAll('#g-decor-cats .picker-cat').length;
      document.getElementById('g-decor-close').click();
      return { strip, open, tiles, cats, tints: document.querySelectorAll('.tint').length };
    }""")
    u = report['ui']
    if u['strip'] < 10: issues.append(f"decor strip has only {u['strip']} sprites")
    if not u['open']: issues.append('decor picker did not open')
    if u['tiles'] < 10: issues.append(f"decor picker showed {u['tiles']} sprites")
    if u['cats'] < 5: issues.append('decor bands missing')

    # the click path, not just the engine call: pick a sprite, drop it on the
    # canvas, and check undo takes it away again
    page.evaluate("document.getElementById('g-edit').checked = true;"
                  "document.getElementById('g-edit').dispatchEvent(new Event('change', {bubbles:true}))")
    page.wait_for_timeout(200)
    page.evaluate("document.querySelector('#g-props .tilebtn').click()")
    box = page.locator('#g-canvas').bounding_box()
    page.mouse.click(box['x'] + box['width'] * 0.4, box['y'] + box['height'] * 0.55)
    page.wait_for_timeout(250)
    placed = page.evaluate("JSON.parse(localStorage.getItem('neojutsu.game.v1')||'{}')")
    report['click'] = {'saved_props': len((placed.get('spec') or {}).get('props') or [])}
    page.evaluate("document.getElementById('g-undo').click()"); page.wait_for_timeout(250)
    after_undo = page.evaluate("JSON.parse(localStorage.getItem('neojutsu.game.v1')||'{}')")
    report['click']['after_undo'] = len((after_undo.get('spec') or {}).get('props') or [])
    if report['click']['saved_props'] < 1:
        issues.append('clicking the canvas with a decor brush placed nothing')
    if report['click']['after_undo'] >= report['click']['saved_props'] and report['click']['saved_props']:
        issues.append('undo did not remove the decor')
    report['round_trip'] = page.evaluate("""() => {
      const t = JSON.parse(JSON.stringify(window.NeoGameTemplates.platformer));
      t.props = [{ i: 49, x: 40, y: 96, t: '#3fbf4a' }, { i: 102, x: 80, y: 96, b: 1 }];
      const cv = document.createElement('canvas'); cv.width = 256; cv.height = 176;
      const g = window.NeoGame.create(cv, t);
      const before = g.snapshot().props.length;
      g.addProp({ i: 620, x: 120, y: 96, t: '#ece8f5' });
      const after = g.snapshot().props;
      const removed = g.removePropAt(120, 92);
      return { before, after: after.length, kept: JSON.stringify(after[0]),
               removed, left: g.snapshot().props.length };
    }""")
    r = report['round_trip']
    if r['before'] != 2: issues.append(f"props did not load ({r['before']} of 2)")
    if r['after'] != 3: issues.append('addProp did not stick')
    if not r['removed'] or r['left'] != 2: issues.append('removePropAt missed')

    # decor must not touch the simulation
    report['inert'] = page.evaluate("""() => {
      function run(props) {
        const t = JSON.parse(JSON.stringify(window.NeoGameTemplates.platformer));
        t.props = props;
        const cv = document.createElement('canvas'); cv.width = 256; cv.height = 176;
        const g = window.NeoGame.create(cv, t);
        g.input.right = true;
        for (let i = 0; i < 180; i++) g.tick(1 / 60);
        const p = g.player;
        return [Math.round(p.x), Math.round(p.y), g.score, g.lives, g.state];
      }
      const bare = run([]);
      // a wall of decor exactly where the player runs
      const wall = [];
      for (let x = 0; x < 40; x++) for (let y = 0; y < 12; y++) wall.push({ i: 8, x: x * 8, y: y * 8 });
      const dressed = run(wall);
      return { bare, dressed, same: JSON.stringify(bare) === JSON.stringify(dressed) };
    }""")
    if not report['inert']['same']:
        issues.append(f"decor changed the game: {report['inert']['bare']} vs {report['inert']['dressed']}")

    # a shared spec with bad decor is refused
    report['validate'] = page.evaluate("""() => {
      const base = () => JSON.parse(JSON.stringify(window.NeoGameTemplates.platformer));
      const cases = {};
      let s = base(); s.props = 'nope'; cases.notList = window.NeoGame.validate(s).ok;
      s = base(); s.props = [{ x: 1, y: 1 }]; cases.noSprite = window.NeoGame.validate(s).ok;
      s = base(); s.props = [{ i: 1, x: 1, y: 1, t: 'javascript:alert(1)' }]; cases.badTint = window.NeoGame.validate(s).ok;
      s = base(); s.props = Array.from({length: 900}, () => ({ i: 1, x: 1, y: 1 })); cases.tooMany = window.NeoGame.validate(s).ok;
      s = base(); s.props = [{ i: 49, x: 8, y: 8, t: '#3fbf4a' }]; cases.goodOk = window.NeoGame.validate(s).ok;
      return cases;
    }""")
    v = report['validate']
    for k in ('notList', 'noSprite', 'badTint', 'tooMany'):
        if v[k]: issues.append(f'validate accepted {k}')
    if not v['goodOk']: issues.append('validate rejected good decor')

    if err: issues.append(f'page errors: {err[:3]}')
    b.close()

print(json.dumps({'report': report, 'issues': issues}, indent=2))
print('\nDecor dresses a level without changing it.' if not issues else f'\n{len(issues)} issue(s).')
sys.exit(1 if issues else 0)
