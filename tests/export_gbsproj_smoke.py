"""A game exported for the hardware has to be the game that was exported.

The point of the GB Studio export is a real .gb file, and nobody finds out it
was wrong until the ROM boots. So the check is a round trip: write a project
out, read it back with our own importer, and insist the collision layer is the
tilemap that went in, cell for cell, and that every piece of the cast arrived
on the tile it left from.
"""
import json, sys, shutil, tempfile
from pathlib import Path

ROOT = Path('/Users/christophercohen/Documents/GitHub/neojutsu')
sys.path.insert(0, str(ROOT / 'tools'))
import export_gbsproj as E          # noqa: E402
import import_gbstudio as G         # noqa: E402

issues, report = [], {}
tmp = Path(tempfile.mkdtemp(prefix='neojutsu-gbs-out-'))

try:
    src = (ROOT / 'game-templates.js').read_text(encoding='utf-8')
    i = src.index('window.NeoGameTemplates =') + len('window.NeoGameTemplates =')
    templates = json.loads(src[i:src.rindex('};') + 1])

    # A run of rooms and a single room, since they take different paths in.
    for key in ('quest', 'armour'):
        spec = templates[key]
        out = tmp / key
        made = E.export(spec, out, key)
        if not made:
            issues.append(f'{key}: exported nothing')
            continue

        kinds = [k for k, _ in G.find_projects(out)]
        if kinds != ['split']:
            issues.append(f'{key}: our own importer does not recognise it ({kinds})')

        scenes = {}
        for f in sorted(out.rglob('scenes/**/scene.gbsres')):
            sc = json.loads(f.read_text(encoding='utf-8-sig'))
            scenes[sc['name']] = (sc, f.parent)

        stages = E.stages_of(spec)
        if len(scenes) != len(stages):
            issues.append(f'{key}: {len(stages)} rooms went in, {len(scenes)} came out')

        rows = []
        for st in stages:
            name = st.get('name') or spec.get('name')
            if name not in scenes:
                issues.append(f'{key}: room "{name}" is missing from the project')
                continue
            sc, folder = scenes[name]

            grid, w, h = E.read_tiles(st['level'])
            want = [E.TILE_LOOK.get(grid[y][x], (3, 0))[1] for y in range(h) for x in range(w)]
            got = G.decode_collisions(sc['collisions'], w * h)
            if got != want:
                wrong = sum(1 for a, b in zip(want, got) if a != b)
                issues.append(f'{key}/{name}: {wrong} of {len(want)} collision cells came back wrong')
            if (sc['width'], sc['height']) != (w, h):
                issues.append(f'{key}/{name}: {w}x{h} went in, {sc["width"]}x{sc["height"]} came out')

            # every piece of the cast we have a drawing for must be in the room,
            # on the tile it stood on
            ents = st.get('entities') or []
            drawable = [e for e in ents if E.sprite_for(e.get('type')) is not None]
            actors = [json.loads(p.read_text()) for p in sorted((folder / 'actors').glob('*.gbsres'))]
            if len(actors) != len(drawable):
                issues.append(f'{key}/{name}: {len(drawable)} things to draw, {len(actors)} actors written')
            placed = sorted((a['x'], a['y']) for a in actors)
            expect = sorted((int(e['x']) // E.T, int(e['y']) // E.T) for e in drawable)
            if placed != expect:
                issues.append(f'{key}/{name}: the cast moved on the way out')
            for a in actors:
                if not a.get('spriteSheetId'):
                    issues.append(f'{key}/{name}: an actor has no sprite')
                    break
            rows.append({'room': name, 'size': [w, h], 'actors': len(actors)})

        # the sprites themselves: two colours, the ink and the transparency key
        sheets = sorted((out / 'assets' / 'sprites').glob('*.png'))
        if not sheets:
            issues.append(f'{key}: no sprites were cut')
        try:
            from PIL import Image
            for p in sheets:
                im = Image.open(p)
                if im.size != (16, 16):
                    issues.append(f'{key}: {p.name} is {im.size}, not 16x16')
                cols = {c for _, c in (im.convert('RGB').getcolors(64) or [])}
                if not cols <= {E.SPRITE_KEY, E.DMG[0]}:
                    issues.append(f'{key}: {p.name} uses colours the hardware has no word for: {cols}')
                if E.SPRITE_KEY not in cols:
                    issues.append(f'{key}: {p.name} has no transparent ground')
        except ImportError:
            pass

        # and the pieces GB Studio itself opens the folder by
        for want_file in (f'{E.slug(key)}.gbsproj', 'project/settings.gbsres'):
            if not (out / want_file).exists():
                issues.append(f'{key}: {want_file} was not written')
        report[key] = {'rooms': rows, 'sprites': [p.stem for p in sheets]}
    # ---- and the browser writes the same project the command line does ----
    # Both can export; two answers to the same question is one answer too
    # many, and they had already drifted on doors before anyone looked.
    import http.server, threading, functools, socketserver, zipfile, io
    from playwright.sync_api import sync_playwright

    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    httpd = socketserver.TCPServer(('127.0.0.1', 0), handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(accept_downloads=True)
        page = ctx.new_page()
        perr = []
        page.on('pageerror', lambda e: perr.append(str(e)))
        page.goto(f'http://127.0.0.1:{port}/game.html')
        page.wait_for_function('!!(window.NeoGBS && window.NeoSprites && window.NeoSprites.loaded)',
                               timeout=30000)
        # the same tile table on both sides
        theirs = page.evaluate('()=>window.NeoGBS.TILE_LOOK')
        mine = {str(k): list(v) for k, v in E.TILE_LOOK.items()}
        if {k: list(v) for k, v in theirs.items()} != mine:
            issues.append('the browser and the command line disagree about the tile table')
        report['tile_table_shared'] = {k: list(v) for k, v in theirs.items()} == mine

        page.evaluate("""()=>{ const s=document.getElementById('g-template');
          s.value='quest'; s.dispatchEvent(new Event('change',{bubbles:true})); }""")
        page.wait_for_timeout(1200)
        with page.expect_download(timeout=30000) as dl:
            page.click('#g-gbs')
        data = open(dl.value.path(), 'rb').read()
        try:
            z = zipfile.ZipFile(io.BytesIO(data))
        except zipfile.BadZipFile as e:
            issues.append(f'the browser wrote a zip that will not open: {e}')
            z = None
        if z is not None:
            if z.testzip() is not None:
                issues.append('the browser wrote a corrupt zip')
            web = tmp / 'web'
            z.extractall(web)
            if [k for k, _ in G.find_projects(web)] != ['split']:
                issues.append('our importer does not recognise the browser project')
            wscenes = {}
            for f in sorted(web.rglob('scenes/**/scene.gbsres')):
                sc = json.loads(f.read_text(encoding='utf-8-sig'))
                wscenes[sc['name']] = (sc, f.parent)
            for st in E.stages_of(templates['quest']):
                nm = st.get('name')
                if nm not in wscenes:
                    issues.append(f'browser export is missing room "{nm}"')
                    continue
                sc, folder = wscenes[nm]
                grid, w, h = E.read_tiles(st['level'])
                want = [E.TILE_LOOK.get(grid[y][x], (3, 0))[1] for y in range(h) for x in range(w)]
                if G.decode_collisions(sc['collisions'], w * h) != want:
                    issues.append(f'browser export: {nm} collision does not match the level')
                ents = st.get('entities') or []
                drawable = [e for e in ents if E.sprite_for(e.get('type')) is not None]
                actors = [json.loads(pth.read_text())
                          for pth in sorted((folder / 'actors').glob('*.gbsres'))]
                if sorted((a['x'], a['y']) for a in actors) != \
                   sorted((int(e['x']) // E.T, int(e['y']) // E.T) for e in drawable):
                    issues.append(f'browser export: the cast moved in "{nm}"')
            report['browser'] = {'bytes': len(data), 'entries': len(z.namelist())}
        if perr:
            issues.append(f'page errors during export: {perr[:2]}')
        br.close()
    httpd.shutdown()
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print(json.dumps({'report': report, 'issues': issues}, indent=2))
print('\nWhat was exported is what goes to the hardware.' if not issues
      else f'\n{len(issues)} issue(s).')
sys.exit(1 if issues else 0)
