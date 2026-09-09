#!/usr/bin/env python3
"""Write a NeoJutsu game out as a GB Studio project.

The point is a real Game Boy ROM. Writing a C backend means solving bank
switching, VRAM budgets and the ten-sprites-per-scanline rule, all of which
GB Studio's authors already solved - so the short road to a .gb file is to
hand them a project and let their compiler do it:

    our spec  ->  .gbsproj  ->  GB Studio  ->  game.gb

This is the inverse of tools/import_gbstudio.py and shares its understanding
of the format. A level becomes a scene: the tilemap is drawn to a background
image and its solid tiles become the scene's collision layer.

    python3 tools/export_gbsproj.py --spec mygame.json --out ~/MyGame
    python3 tools/export_gbsproj.py --template platformer --out ~/Platformer

Geometry, collision and the cast go across: every coin, enemy and goal
becomes a GB Studio actor, drawn with a sprite cut out of the same 1-bit
atlas the browser uses, so the exported project looks like the game it came
from rather than a blank room.

What does not travel: tinted decor and per-prop colour have no counterpart on
the hardware, our scripts are not their event graphs, and a Game Boy has hard
limits on sprites per scanline that our levels do not respect - twenty coins
in a row is fine here and will flicker there.
"""
import argparse, json, sys, uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
T = 8
# The four greens, darkest first, as GB Studio indexes them.
DMG = [(15, 56, 15), (48, 98, 48), (139, 172, 15), (155, 188, 15)]

def _tile_look():
    """The tile table, read out of game-gbs.js.

    The browser writes these projects too, and two copies of a lookup is two
    answers to the same question - they had already drifted on doors and on
    the back wall before anyone noticed. So there is one table, it lives with
    the browser exporter, and this reads it.
    """
    import re
    src = (ROOT / 'game-gbs.js').read_text(encoding='utf-8')
    i = src.index('const TILE_LOOK = {')
    body = src[i + len('const TILE_LOOK = '):src.index('};', i) + 1]
    body = re.sub(r'//[^\n]*', '', body)
    body = re.sub(r'0x([0-9a-fA-F]+)', lambda m: str(int(m.group(1), 16)), body)
    body = re.sub(r'(\d+)\s*:', r'"\1":', body)
    body = re.sub(r',\s*}', '}', body)
    return {int(k): tuple(v) for k, v in json.loads(body).items()}


# Which of the four shades a tile of ours is drawn in, and whether it stops you.
# GB Studio collision bits: 1 top, 2 bottom, 4 left, 8 right, 16 ladder.
TILE_LOOK = _tile_look()


def encode_rle(cells):
    """The inverse of the decoder in the importer: a two digit value, a hex
    count, then '+'; a single cell is the value then '!'."""
    out, i, n = [], 0, len(cells)
    while i < n:
        v = cells[i]
        j = i
        while j < n and cells[j] == v:
            j += 1
        run = j - i
        out.append(f'{v:02x}' + ('!' if run == 1 else f'{run:x}+'))
        i = j
    return ''.join(out)


def read_tiles(level):
    w, h = int(level['w']), int(level['h'])
    raw = level.get('tiles')
    grid = [[0] * w for _ in range(h)]
    if isinstance(raw, str):
        rows = raw.strip().split('\n')
        for y in range(min(h, len(rows))):
            for x in range(min(w, len(rows[y]))):
                try:
                    grid[y][x] = int(rows[y][x], 36)
                except ValueError:
                    grid[y][x] = 0
    elif isinstance(raw, list):
        for i, v in enumerate(raw[:w * h]):
            grid[i // w][i % w] = int(v or 0)
    return grid, w, h


def draw_background(grid, w, h, path):
    """A scene's background is a picture. Ours is drawn from the tilemap, one
    flat block per tile, which is enough to see the level and to let GB Studio
    slice it into hardware tiles."""
    from PIL import Image
    img = Image.new('RGB', (w * T, h * T))
    px = img.load()
    for ty in range(h):
        for tx in range(w):
            shade = TILE_LOOK.get(grid[ty][tx], (3, 0))[0]
            col = DMG[shade]
            # A lit lip on the top edge of anything solid, so a floor reads as
            # a floor rather than a slab.
            lip = TILE_LOOK.get(grid[ty][tx], (3, 0))[1] and (
                ty == 0 or not TILE_LOOK.get(grid[ty - 1][tx], (3, 0))[1])
            for y in range(T):
                for x in range(T):
                    c = DMG[2] if (lip and y < 2) else col
                    px[tx * T + x, ty * T + y] = c
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path)


# GB Studio keys sprite transparency on this exact green.
SPRITE_KEY = (101, 255, 0)


def atlas():
    """The same 1-bit sheet the browser draws from, decoded once.

    It lives as base64 inside game-sprites.js because a packaged game is one
    HTML file; there is no PNG on disk to open, so it is read back out of the
    source rather than kept in two places that can disagree.
    """
    import base64, io, re
    from PIL import Image
    src = (ROOT / 'game-sprites.js').read_text(encoding='utf-8')
    runs = re.findall(r'[A-Za-z0-9+/=]{2000,}', src)
    if not runs:
        return None
    return Image.open(io.BytesIO(base64.b64decode(runs[0]))).convert('RGBA')


def sprite_table(name):
    """A lookup read out of game-sprites.js, so the ROM uses the same drawing
    for a coin that the browser does and cannot quietly drift from it."""
    import re
    src = (ROOT / 'game-sprites.js').read_text(encoding='utf-8')
    head = f'const {name} = {{'
    if head not in src:
        return {}
    i = src.index(head)
    body = src[i + len(f'const {name} = '):src.index('};', i) + 1]
    body = re.sub(r'//[^\n]*', '', body)
    body = re.sub(r'([A-Za-z_][A-Za-z_0-9]*)\s*:', r'"\1":', body)
    body = re.sub(r',\s*}', '}', body)
    try:
        return json.loads(body)
    except ValueError:
        return {}


def sprite_for(kind):
    """Which drawing an entity type gets. Items are one apiece; the cast has a
    few to choose from and takes the first, because a ROM wants one sprite per
    kind rather than a different guard in every room."""
    item = sprite_table('ITEM').get(kind)
    if isinstance(item, int):
        return item
    base = sprite_table('BASE').get(kind)
    if isinstance(base, list) and base:
        return base[0]
    return None


def write_sprite(sheet, idx, path):
    """One 16x16 sprite, cut from the atlas and recoloured for the hardware:
    the ink in the darkest green, everything else the transparency key."""
    from PIL import Image
    cell = sheet.crop(((idx % 49) * 16, (idx // 49) * 16, (idx % 49) * 16 + 16, (idx // 49) * 16 + 16))
    img = Image.new('RGB', (16, 16), SPRITE_KEY)
    src, dst = cell.load(), img.load()
    for y in range(16):
        for x in range(16):
            if src[x, y][3] > 40:
                dst[x, y] = DMG[0]
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path)


def slug(s):
    out = ''.join(c if c.isalnum() else '_' for c in str(s or 'scene')).strip('_').lower()
    return (out or 'scene')[:28]


def write(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2), encoding='utf-8')


def stages_of(spec):
    if isinstance(spec.get('levels'), list) and spec['levels']:
        return spec['levels']
    return [{'name': spec.get('name'), 'level': spec.get('level'),
             'entities': spec.get('entities'), 'start': spec.get('start')}]


def export(spec, out, name):
    out = Path(out).expanduser()
    stages = stages_of(spec)
    scene_ids, first = [], None

    # One sprite per kind of thing in the game, cut from the atlas before any
    # scene is written, because several rooms share a coin and the hardware
    # wants one sheet for all of them.
    sheet = atlas()
    sprites = {}
    for st in stages:
        for e in (st.get('entities') or []):
            kind = e.get('type')
            if kind in sprites or kind is None:
                continue
            idx = sprite_for(kind)
            if idx is None or sheet is None:
                continue
            sid_sp, name_sp = str(uuid.uuid4()), slug(kind)
            write_sprite(sheet, idx, out / 'assets' / 'sprites' / f'{name_sp}.png')
            write(out / 'project' / 'sprites' / f'{name_sp}.gbsres', {
                '_resourceType': 'sprite', 'id': sid_sp, 'name': kind,
                'symbol': f'sprite_{name_sp}', 'numFrames': 1,
                'filename': f'{name_sp}.png', 'width': 16, 'height': 16,
                'canvasWidth': 16, 'canvasHeight': 16,
                'boundsX': 0, 'boundsY': 0, 'boundsWidth': 16, 'boundsHeight': 16,
                'states': [{
                    'id': str(uuid.uuid4()), 'name': '',
                    'animationType': 'fixed', 'flipLeft': False,
                    'animations': [{'id': str(uuid.uuid4()), 'frames': [{
                        'id': str(uuid.uuid4()),
                        # Four hardware tiles make one 16x16 sprite.
                        'tiles': [{'id': str(uuid.uuid4()), 'x': tx, 'y': ty,
                                   'sliceX': tx, 'sliceY': ty, 'palette': 0,
                                   'flipX': False, 'flipY': False,
                                   'objPalette': 'OBP0', 'paletteIndex': 0,
                                   'priority': False}
                                  for ty in (0, 8) for tx in (0, 8)],
                    }]}] + [{'id': str(uuid.uuid4()), 'frames': []} for _ in range(7)],
                }],
            })
            sprites[kind] = sid_sp

    for i, st in enumerate(stages):
        level = st.get('level') or {}
        if not level.get('w'):
            continue
        grid, w, h = read_tiles(level)
        room = slug(st.get('name') or f'room {i + 1}')
        sid, bid = str(uuid.uuid4()), str(uuid.uuid4())
        if first is None:
            first = (sid, st.get('start') or {'x': T, 'y': T})

        png = out / 'assets' / 'backgrounds' / f'{room}.png'
        draw_background(grid, w, h, png)
        write(png.with_suffix('.png.gbsres'), {
            '_resourceType': 'background', 'id': bid, 'name': room,
            'symbol': f'bg_{room}', 'tileColors': '',
            'filename': f'{room}.png', 'width': w, 'height': h,
            'imageWidth': w * T, 'imageHeight': h * T, 'autoColor': False,
        })

        cells = [TILE_LOOK.get(grid[y][x], (3, 0))[1] for y in range(h) for x in range(w)]
        write(out / 'project' / 'scenes' / room / 'scene.gbsres', {
            '_resourceType': 'scene', 'id': sid, '_index': i,
            'type': 'PLATFORM' if spec.get('mode') == 'platform' else 'TOPDOWN',
            'name': st.get('name') or f'Room {i + 1}', 'symbol': f'scene_{room}',
            'x': 40 + i * 240, 'y': 40, 'width': w, 'height': h,
            'backgroundId': bid, 'tilesetId': '', 'colorModeOverride': 'none',
            'paletteIds': [], 'spritePaletteIds': [], 'autoFadeSpeed': 1,
            'collisions': encode_rle(cells),
            'script': [], 'playerHit1Script': [], 'playerHit2Script': [], 'playerHit3Script': [],
        })
        # The cast. A coin sitting in a room is the difference between a level
        # and a picture of one, and their x and y are in tiles on the hardware
        # where ours are in pixels.
        for n, e in enumerate(st.get('entities') or []):
            sp = sprites.get(e.get('type'))
            if not sp:
                continue
            aname = slug(f"{e.get('type')}_{n}")
            write(out / 'project' / 'scenes' / room / 'actors' / f'{aname}.gbsres', {
                '_resourceType': 'actor', 'id': str(uuid.uuid4()),
                'name': f"{e.get('type')} {n + 1}", 'symbol': f'actor_{room}_{n}',
                'spriteSheetId': sp, 'prefabId': '', 'frame': 0, 'animate': False,
                'direction': 'down', 'moveSpeed': 1, 'animSpeed': 15,
                'paletteId': '', 'isPinned': False, 'persistent': False,
                'collisionGroup': '', 'prefabScriptOverrides': {},
                'x': max(0, int(e.get('x', 0)) // T), 'y': max(0, int(e.get('y', 0)) // T),
                '_index': n,
                'script': [], 'startScript': [], 'updateScript': [],
                'hit1Script': [], 'hit2Script': [], 'hit3Script': [],
            })
        scene_ids.append((room, sid))

    if not scene_ids:
        return None

    sid, start = first
    write(out / 'project' / 'settings.gbsres', {
        '_resourceType': 'settings',
        'startSceneId': sid,
        'startX': max(0, int(start.get('x', T)) // T),
        'startY': max(0, int(start.get('y', T)) // T),
        'startDirection': 'right', 'startMoveSpeed': 1, 'startAnimSpeed': 15,
        'showCollisions': True, 'showConnections': 'selected',
        'defaultBackgroundPaletteIds': ['default-bg-1', 'default-bg-2', 'default-bg-3',
                                        'default-bg-4', 'default-bg-5', 'default-bg-6'],
        'defaultSpritePaletteIds': ['default-sprite'] * 8,
        'defaultUIPaletteId': 'default-ui',
        'musicDriver': 'huge', 'cartType': 'mbc5',
    })
    write(out / 'project' / 'variables.gbsres', {'_resourceType': 'variables', 'variables': []})
    write(out / f'{slug(name)}.gbsproj', {
        '_resourceType': 'project', 'name': name,
        'author': 'NeoJutsu', 'notes': '',
        '_version': '4.2.0', '_release': '10',
    })
    return {'folder': str(out), 'scenes': len(scene_ids),
            'rooms': [r for r, _ in scene_ids]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--spec', help='a NeoJutsu spec as JSON')
    ap.add_argument('--template', help='export one of the studio\'s starter games instead')
    ap.add_argument('--out', required=True)
    ap.add_argument('--name', default='NeoJutsu Game')
    args = ap.parse_args()

    if args.spec:
        spec = json.loads(Path(args.spec).expanduser().read_text(encoding='utf-8'))
        if 'spec' in spec:
            spec = spec['spec']
    elif args.template:
        src = (ROOT / 'game-templates.js').read_text(encoding='utf-8')
        start = src.index('{', src.index('window.NeoGameTemplates = '))
        end = src.index('\n};\n})();')
        spec = json.loads(src[start:end + 2])[args.template]
    else:
        print('give me --spec or --template', file=sys.stderr)
        return 1

    got = export(spec, args.out, args.name)
    if not got:
        print('nothing to export: no levels in that spec', file=sys.stderr)
        return 1
    print(json.dumps(got, indent=2))
    print('\nOpen the folder in GB Studio, then Build to get a .gb', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
