#!/usr/bin/env python3
"""Read ZZT worlds, and keep the boards that play as overhead levels.

ZZT is a 1991 game-construction kit whose players made worlds for it for
thirty years - the Museum of ZZT has more than four thousand of them. A ZZT
board is a 60x25 grid of walls, floor, keys, doors, gems and monsters, which
is very nearly a description of this engine's `topdown` mode. That makes it
the largest body of hand-made overhead level design in a format a script can
read, and none of it was written by a generator.

    python3 tools/import_zzt.py --in ~/zzt-worlds --out data/zzt.jsonl

`--in` may hold .zzt files, or zips, or zips of zips, which is how the
Museum's mass downloads arrive.

ON LICENCES. The Museum states no licence for the worlds it preserves, and
these are somebody's games rather than somebody's dataset. This writes to
data/study/ by default for that reason: it is not mixed into the training
run by `docs/training.md`, and putting it there is a decision for a person
to make rather than a default to inherit.
"""
import argparse, io, json, struct, sys, zipfile
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_dataset import BUILD, serve, record          # noqa: E402
from level_kit import describe, spread                  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
W, H = 60, 25                                           # a ZZT board, always

# What each ZZT element becomes here. The numbering is the one in the file
# format, not the one in the editor's menus.
#   floor is Empty; the walls are Solid, Normal, Breakable and the sliders.
TILE = {
    0: '0',                    # empty - the floor you walk on
    1: '2',                    # board edge
    9: 'c',                    # door            -> door (12)
    11: 'i',                   # passage         -> exit (18)
    19: '6',                   # water
    20: '7',                   # forest          -> breakable, which is what it is
    21: '2',                   # solid wall      -> stone
    22: '1',                   # normal wall     -> ground
    23: '7',                   # breakable wall  -> brick
    24: 'f',                   # boulder         -> crate
    25: 'f', 26: 'f',          # sliders         -> crate
    29: '2',                   # blink wall
    31: '2',                   # line
    32: '2',                   # ricochet
    33: '4', 43: '4',          # blink rays      -> spikes: they are the hazard
}
# Everything a board processes rather than draws. The player is the start.
CAST = {
    5: 'coin',      # ammo
    6: 'coin',      # torch
    7: 'gem',       # gem
    8: 'key',       # key
    14: 'pellet',   # energizer - it makes the monsters flee, which is ours exactly
    34: 'walker',   # bear
    35: 'chaser',   # ruffian
    37: 'walker',   # slime
    38: 'flyer',    # shark
    39: 'turret',   # spinning gun
    41: 'chaser',   # lion
    42: 'hunter',   # tiger - the one that shoots back
    44: 'chaser',   # centipede head
}
PLAYER = 4
# How much of a board's cast survives the trip. See to_spec for why.
PICKUP_CAP, FOE_CAP, CAST_CAP = 20, 12, 40


def worlds_in(path):
    """Every .zzt under here, however deeply it is zipped. The Museum's packs
    are zips of zips, and a world is sometimes zipped again inside those."""
    out = []

    def dig(name, data, depth=0):
        low = name.lower()
        if low.endswith('.zzt'):
            out.append((name, data))
            return
        if depth > 3 or not low.endswith('.zip'):
            return
        try:
            z = zipfile.ZipFile(io.BytesIO(data))
        except Exception:
            return
        for m in z.namelist():
            if m.endswith('/'):
                continue
            try:
                dig(m, z.read(m), depth + 1)
            except Exception:
                continue

    p = Path(path)
    files = [p] if p.is_file() else sorted(q for q in p.rglob('*') if q.is_file())
    for f in files:
        try:
            dig(f.name, f.read_bytes())
        except Exception:
            continue
    return out


def boards(data):
    """Split a world into its boards without trusting anything but the length
    each one declares. Stat parsing is where a malformed world bites, and a
    board that says how long it is can be skipped past whatever is inside."""
    if len(data) < 512 or struct.unpack_from('<h', data, 0)[0] != -1:
        return []
    at, got = 512, []
    while at + 2 <= len(data):
        size = struct.unpack_from('<h', data, at)[0]
        if size <= 0 or at + 2 + size > len(data):
            break
        got.append(data[at + 2: at + 2 + size])
        at += 2 + size
        if len(got) > 200:
            break
    return got


def read_board(body):
    """Name, tiles and stats. Tiles are run-length encoded in threes, and a
    count of zero means 256 rather than none - a decoder quirk from 1991 that
    is still in every file."""
    if len(body) < 52:
        return None
    n = body[0]
    name = body[1:1 + min(n, 50)].decode('cp437', 'replace').strip()
    at = 51
    cells, colours = [], []
    while len(cells) < W * H and at + 2 < len(body):
        count, elem, col = body[at], body[at + 1], body[at + 2]
        at += 3
        for _ in range(count or 256):
            cells.append(elem)
            colours.append(col)
            if len(cells) >= W * H:
                break
    if len(cells) < W * H:
        return None

    stats = []
    props = at
    if props + 88 <= len(body):
        count = struct.unpack_from('<h', body, props + 86)[0]
        s = props + 88
        for _ in range(max(0, min(count + 1, 300))):
            if s + 33 > len(body):
                break
            x, y = body[s], body[s + 1]
            length = struct.unpack_from('<h', body, s + 23)[0]
            stats.append((x, y))
            s += 33 + (length if length > 0 else 0)
    return {'name': name, 'cells': cells, 'stats': stats}


def to_spec(board, source):
    """One board, as a game. The floor is what you can walk on, the monsters
    are the cast, and the way out is a passage where there is one."""
    cells = board['cells']
    grid = [['0'] * W for _ in range(H)]
    found, start, exits = {}, None, 0
    for i, e in enumerate(cells):
        x, y = i % W, i // W
        if e == PLAYER:
            start = (x, y)
            continue
        if e in CAST:
            found.setdefault(CAST[e], []).append({'type': CAST[e], 'x': x * 8, 'y': y * 8})
            continue
        ch = TILE.get(e)
        if ch is None:
            # Text, objects, scrolls, monitors: things this engine has no
            # word for. They stand where they stood, as floor.
            continue
        if ch == 'i':
            exits += 1
        grid[y][x] = ch

    # The player is not always drawn on the board. ZZT keeps him as the first
    # stat and only paints him where you last stood, so a room nobody has
    # walked into has his position recorded and nothing in the grid. Reading
    # the grid alone threw away a third of every world.
    if not start and board['stats']:
        x, y = board['stats'][0]
        if 0 < x <= W and 0 < y <= H:
            start = (x - 1, y - 1)               # ZZT counts from one
    if not start:
        return None

    # Items used as wallpaper. ZZT draws a torch as a little glyph, and
    # authors tiled them by the hundred to texture a wall - one board here has
    # a hundred and seventeen of them in a shack. Read literally that is a
    # level with a hundred and seventeen pickups in it, which is not a level,
    # it is a misreading of one. The layout is the part worth having, so the
    # cast is thinned to a playable number, spread across where it stood.
    ents = []
    for kind, group in found.items():
        cap = PICKUP_CAP if kind in ('coin', 'gem', 'key', 'pellet', 'heart') else FOE_CAP
        ents += group if len(group) <= cap else spread(group, cap)
    # And a ceiling on the whole cast, not only on each kind of it: nine kinds
    # each just under their own cap is still a hundred and ten things in one
    # room, which teaches a distribution no hand-made level has.
    if len(ents) > CAST_CAP:
        ents = spread(ents, CAST_CAP)
    gems = sum(1 for e in ents if e['type'] in ('coin', 'gem'))

    # The border is the edge of the world in ZZT, and an edge you can stand on
    # is an edge you can walk off.
    for x in range(W):
        grid[0][x] = grid[H - 1][x] = '2'
    for y in range(H):
        grid[y][0] = grid[y][W - 1] = '2'
    sx, sy = start
    if not (0 < sx < W - 1 and 0 < sy < H - 1):
        return None
    grid[sy][sx] = '0'

    rules = ({'collect': 0, 'keys': 0, 'clearAll': True} if not exits and gems
             else {'collect': min(gems, 6), 'keys': 0})
    return {
        'name': (board['name'] or 'a room')[:40],
        'mode': 'topdown',
        'seed': source[:24],
        'sky0': '#0a0a14', 'sky1': '#1a1626',
        'player': {'char': 'hero'},
        'start': {'x': sx * 8, 'y': sy * 8},
        'lives': 3,
        'level': {'w': W, 'h': H, 'tiles': '\n'.join(''.join(r) for r in grid)},
        'entities': ents[:120],
        'rules': rules,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='src', required=True)
    ap.add_argument('--out', default='data/study/zzt.jsonl')
    ap.add_argument('--rejects', default='data/study/zzt-rejects.jsonl')
    ap.add_argument('--min-moved', type=int, default=24)
    ap.add_argument('--min-open', type=int, default=180,
                    help='floor tiles a board needs before it is a place rather than a picture')
    ap.add_argument('--limit', type=int, default=0)
    args = ap.parse_args()

    found = worlds_in(args.src)
    print(f'{len(found)} world file(s)', file=sys.stderr)

    made, why = [], Counter()
    for name, data in found:
        bs = boards(data)
        for i, body in enumerate(bs):
            b = read_board(body)
            if not b:
                why['unreadable board'] += 1
                continue
            spec = to_spec(b, f'{Path(name).stem}-{i}')
            if not spec:
                why['nobody in it'] += 1
                continue
            open_floor = spec['level']['tiles'].count('0')
            if open_floor < args.min_open:
                why['almost no floor'] += 1
                continue
            if len(spec['entities']) < 2:
                why['nothing in it'] += 1
                continue
            made.append((f"{Path(name).stem}:{b['name']}", spec))
        if args.limit and len(made) >= args.limit:
            break
    print(f'{len(made)} boards worth grading', file=sys.stderr)
    if not made:
        print(json.dumps({'worlds': len(found), 'boards': 0, 'why': dict(why)}, indent=2))
        return 0

    from playwright.sync_api import sync_playwright
    kept, rejects = [], []
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
                verdicts = page.evaluate(CHECK, {'prompts': [s for _, s in chunk]})
                for (tag, spec), v in zip(chunk, verdicts):
                    if v.get('error'):
                        rejects.append({'board': tag, 'why': 'threw: ' + v['error'][:60]})
                    elif not v.get('ok'):
                        rejects.append({'board': tag,
                                        'why': 'invalid: ' + '; '.join(v.get('errors') or [])[:80]})
                    elif v.get('moved', 0) < args.min_moved:
                        rejects.append({'board': tag,
                                        'why': f"a bot got {v.get('moved', 0)}px into it"})
                    else:
                        kept.append((describe(spec), spec))
                print(f'\r  graded {min(i + 6, len(made))}/{len(made)}',
                      end='', file=sys.stderr, flush=True)
            print(file=sys.stderr)
            b.close()
    finally:
        srv.shutdown()

    out = ROOT / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open('w', encoding='utf-8') as fh:
        for prompt, spec in kept:
            fh.write(json.dumps(record(prompt, spec), ensure_ascii=False) + '\n')
    rj = ROOT / args.rejects
    rj.parent.mkdir(parents=True, exist_ok=True)
    with rj.open('w', encoding='utf-8') as fh:
        for r in rejects:
            fh.write(json.dumps(r, ensure_ascii=False) + '\n')

    print(json.dumps({
        'worlds': len(found), 'boards_offered': len(made), 'written': len(kept),
        'file': str(out), 'rejected': len(rejects),
        'skipped_before_grading': dict(why.most_common(6)),
        'top_rejections': dict(Counter(r['why'].split(':')[0][:40] for r in rejects).most_common(5)),
    }, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
