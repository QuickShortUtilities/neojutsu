#!/usr/bin/env python3
"""Read GB Studio projects into NeoJutsu games.

GB Studio scenes are 8-pixel tiles on a 20x18 screen, which is our frame
exactly, and its scene types line up with our modes: TOPDOWN, PLATFORM and
SHMUP become topdown, platform and shmup. What transfers is the part worth
having - hand-drawn level geometry, which a generator cannot invent.

What does not transfer is meaning. A GB Studio background is a picture with a
separate collision layer, so a wall is a wall but nothing says which tile is
a spike, a ladder or a door beyond what collision records. Actors are mostly
people with dialogue, not enemies. So a scene arrives as terrain, and the
objectives - coins to collect, somewhere to reach - are placed here, then the
whole thing is validated and played by a bot before it is kept.

Import projects you have the right to use. A tool being free does not make
games built with it free; each one belongs to whoever made it.

    python3 tools/import_gbstudio.py --in "~/GAME DEV/Untitled"
    python3 tools/import_gbstudio.py --in ~/projects --out data/gbs.jsonl
"""
import argparse, json, random, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_dataset import BUILD, serve, record  # noqa: E402

T = 8
MODES = {'TOPDOWN': 'topdown', 'PLATFORM': 'platform', 'SHMUP': 'shmup'}
SKY = {
    'platform': ('#1b2a5c', '#7fc4e8'),
    'topdown':  ('#0d0a16', '#241a30'),
    'shmup':    ('#0a0714', '#2a2340'),
}


def decode_collisions(s):
    """GB Studio 4 packs a collision layer as run-length hex.

    A run is a two-digit value then a hex count then '+'; a single tile is a
    value then '!'. Verified against every scene in a project: each one
    decodes to exactly width x height cells.
    """
    out, i, n = [], 0, len(s)
    while i < n:
        val = int(s[i:i + 2], 16)
        i += 2
        if i < n and s[i] == '!':
            out.append(val); i += 1; continue
        j = i
        while j < n and s[j] in '0123456789abcdefABCDEF':
            j += 1
        cnt = int(s[i:j], 16) if j > i else 1
        if j < n and s[j] == '+':
            j += 1
        out.extend([val] * cnt)
        i = j
    return out


def tile_for(v):
    """Collision bits to one of our tiles. 1 top, 2 bottom, 4 left, 8 right,
    0x10 ladder; the high nibble is slopes, which we take as ground."""
    if v == 0:
        return 0
    if v & 0x10:
        return 5                       # ladder
    if (v & 0x0f) == 0x0f:
        return 1                       # solid on every face
    if v & 0x01 and not (v & 0x0e):
        return 3                       # stood on from above only
    return 1


def scene_to_grid(scene):
    w, h = scene['width'], scene['height']
    raw = scene.get('collisions') or ''
    # A scene with no collision layer at all - a title card, a menu - is not a
    # broken one, it is an empty one, and saying so keeps the reject list
    # honest about what is actually wrong.
    cells = [0] * (w * h) if not raw else decode_collisions(raw)
    if len(cells) != w * h:
        return None, w, h
    grid = [[tile_for(cells[y * w + x]) for x in range(w)] for y in range(h)]
    return grid, w, h


def transpose(grid, w, h):
    """Our shoot-em-up scrolls up the screen; GB Studio's runs across it. A
    quarter turn is what makes one the other."""
    return [[grid[y][x] for y in range(h)] for x in range(w)], h, w


def surfaces(grid, w, h):
    """Every ledge with room to stand on it."""
    out = []
    for x in range(1, w - 1):
        for y in range(2, h):
            if grid[y][x] and not grid[y - 1][x] and not grid[y - 2][x]:
                out.append((x, y))
    return out


def open_cells(grid, w, h):
    return [(x, y) for y in range(1, h - 1) for x in range(1, w - 1) if not grid[y][x]]


def build_spec(scene, name, rng):
    mode = MODES.get(scene.get('type'))
    if not mode:
        return None, f"scene type {scene.get('type')} has no equivalent"
    grid, w, h = scene_to_grid(scene)
    if grid is None:
        return None, 'collision layer did not decode'
    if mode == 'shmup':
        grid, w, h = transpose(grid, w, h)
    if w < 8 or h < 8 or w * h > 40000:
        return None, f'{w}x{h} is not a level we can use'
    solid = sum(1 for row in grid for c in row if c)
    if solid < (w * h) * 0.04:
        return None, 'almost nothing in it'

    ents, start = [], None
    if mode == 'platform':
        spots = surfaces(grid, w, h)
        if len(spots) < 6:
            return None, 'no ledges to stand on'
        spots.sort()
        sx, sy = spots[0]
        start = {'x': sx * T, 'y': (sy - 2) * T}
        picks = spots[2::max(1, len(spots) // 14)][:14]
        for x, y in picks:
            ents.append({'type': 'coin', 'x': x * T + 1, 'y': (y - 1) * T + 1})
        gx, gy = spots[-1]
        ents.append({'type': 'goal', 'x': gx * T, 'y': (gy - 2) * T})
    elif mode == 'topdown':
        cells = open_cells(grid, w, h)
        if len(cells) < 30:
            return None, 'nowhere to walk'
        cells.sort(key=lambda c: (c[0], c[1]))
        sx, sy = cells[0]
        start = {'x': sx * T, 'y': sy * T}
        for x, y in cells[4::max(1, len(cells) // 12)][:12]:
            ents.append({'type': 'coin', 'x': x * T + 1, 'y': y * T + 1})
        gx, gy = cells[-1]
        ents.append({'type': 'goal', 'x': gx * T, 'y': gy * T})
    else:                                       # shmup: the far edge is the finish
        cells = open_cells(grid, w, h)
        if len(cells) < 30:
            return None, 'nowhere to fly'
        low = max(cells, key=lambda c: c[1])
        start = {'x': (w // 2) * T, 'y': (low[1] - 1) * T}
        for x, y in cells[6::max(1, len(cells) // 10)][:10]:
            ents.append({'type': 'coin', 'x': x * T + 1, 'y': y * T + 1})

    coins = sum(1 for e in ents if e['type'] == 'coin')
    sky0, sky1 = SKY[mode]
    spec = {
        'name': name[:40],
        'mode': mode,
        'seed': f'gbs{abs(hash(name)) % 9999}',
        'sky0': sky0, 'sky1': sky1,
        'player': {'char': 'hero'},
        'start': start,
        'lives': 3,
        'level': {'w': w, 'h': h, 'tiles': '\n'.join(''.join(f'{c:x}' for c in row) for row in grid)},
        'entities': ents,
        'rules': {'collect': max(0, coins - 2), 'keys': 0},
    }
    return spec, None


def describe(spec, scene):
    kind = {'platform': 'a platformer', 'topdown': 'a top-down dungeon',
            'shmup': 'a space shooter'}[spec['mode']]
    bits = [kind]
    lvl = spec['level']
    if lvl['w'] >= 48:
        bits.append('long')
    elif lvl['w'] <= 24:
        bits.append('short')
    if lvl['h'] >= 30:
        bits.append('tall')
    need = spec['rules']['collect']
    if need:
        bits.append(f'{need} coins to collect')
    return 'Make ' + ', '.join(bits) + '.'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='src', required=True, help='a GB Studio project folder, or a folder of them')
    ap.add_argument('--out', default='data/gbstudio.jsonl')
    ap.add_argument('--rejects', default='data/gbstudio-rejects.jsonl')
    ap.add_argument('--min-moved', type=int, default=24)
    ap.add_argument('--seed', default='gbs')
    args = ap.parse_args()

    src = Path(args.src).expanduser()
    scenes = sorted(src.rglob('scenes/**/scene.gbsres'))
    if not scenes:
        print(f'no GB Studio scenes under {src}', file=sys.stderr)
        return 1
    print(f'{len(scenes)} scene(s)', file=sys.stderr)

    rng = random.Random(args.seed)
    made, rejects = [], []
    for f in scenes:
        try:
            scene = json.loads(f.read_text(encoding='utf-8'))
        except Exception as e:
            rejects.append({'scene': str(f), 'why': f'unreadable: {e}'}); continue
        name = scene.get('name') or f.parent.name
        spec, why = build_spec(scene, name, rng)
        if spec is None:
            rejects.append({'scene': name, 'why': why})
        else:
            made.append((name, spec, scene))

    from playwright.sync_api import sync_playwright
    kept = []
    srv, port = serve()
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(headless=True)
            page = b.new_context(viewport={'width': 900, 'height': 700}).new_page()
            page.goto(f'http://127.0.0.1:{port}/game.html')
            page.wait_for_function('!!(window.NeoGame && window.NeoSprites && window.NeoSprites.loaded)',
                                   timeout=30000)
            CHECK = BUILD.replace('window.NeoGameGen.generateValid(prompt)',
                                  '{ spec: prompt, understood: {} }')
            for i in range(0, len(made), 6):
                chunk = made[i:i + 6]
                verdicts = page.evaluate(CHECK, [s for _, s, _ in chunk])
                for (name, spec, scene), v in zip(chunk, verdicts):
                    if v.get('error'):
                        rejects.append({'scene': name, 'why': 'threw: ' + v['error'][:60]})
                    elif not v.get('ok'):
                        rejects.append({'scene': name, 'why': 'invalid: ' + '; '.join(v.get('errors') or [])[:80]})
                    elif v.get('moved', 0) < args.min_moved:
                        rejects.append({'scene': name, 'why': f"a bot got {v.get('moved', 0)}px into it"})
                    else:
                        kept.append((describe(spec, scene), spec))
            b.close()
    finally:
        srv.shutdown()

    out = ROOT / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open('w', encoding='utf-8') as fh:
        for prompt, spec in kept:
            fh.write(json.dumps(record(prompt, spec), ensure_ascii=False) + '\n')
    if rejects:
        rj = ROOT / args.rejects
        rj.parent.mkdir(parents=True, exist_ok=True)
        with rj.open('w', encoding='utf-8') as fh:
            for r in rejects:
                fh.write(json.dumps(r, ensure_ascii=False) + '\n')

    by = {}
    for _, spec in kept:
        by[spec['mode']] = by.get(spec['mode'], 0) + 1
    print(json.dumps({'scenes': len(scenes), 'written': len(kept), 'file': str(out),
                      'by_mode': by, 'rejected': len(rejects),
                      'why': [r['why'][:50] for r in rejects[:6]]}, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
