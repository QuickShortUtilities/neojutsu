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

What does not travel: our sprite atlas, tinted decor and per-prop colour have
no counterpart on the hardware, and a Game Boy has hard limits on sprites and
tiles that our levels do not respect. Geometry and collision go across.
Actors and scripts are the next piece of work, not this one.
"""
import argparse, json, sys, uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
T = 8
# The four greens, darkest first, as GB Studio indexes them.
DMG = [(15, 56, 15), (48, 98, 48), (139, 172, 15), (155, 188, 15)]

# Which of the four shades a tile of ours is drawn in, and whether it stops you.
# GB Studio collision bits: 1 top, 2 bottom, 4 left, 8 right, 16 ladder.
TILE_LOOK = {
    0:  (3, 0x00),   # sky
    1:  (0, 0x0f),   # ground
    2:  (0, 0x0f),   # stone
    3:  (1, 0x01),   # ledge, stood on from above
    4:  (1, 0x00),   # spikes - hazards are not collision on their hardware
    5:  (2, 0x10),   # ladder
    6:  (2, 0x00),   # water
    7:  (1, 0x0f),   # brick
    8:  (2, 0x0f),   # ice
    9:  (1, 0x0f),   # belt
    10: (1, 0x0f),   # belt
    11: (1, 0x0f),   # spring
    12: (0, 0x0f),   # door
    13: (2, 0x00),   # checkpoint
    14: (1, 0x00),   # lava
    15: (1, 0x0f),   # crate
    16: (2, 0x00),   # grass
    17: (1, 0x00),   # backwall
    18: (2, 0x00),   # exit
    19: (2, 0x00),   # road
    20: (3, 0x00),   # line
}


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
