#!/usr/bin/env python3
"""Read PuzzleScript games, and keep the rooms that survive the journey.

A PuzzleScript game is its own source: a text file with a legend and a set of
character grids, which is very close to how a level is written here. What
does not travel is the point of them - these are pushing puzzles, and this
engine has no pushing. What is left is the room: hand-drawn overhead spaces
with walls, hazards and things to reach, which is worth having on its own.

    python3 tools/import_puzzlescript.py --in ~/PuzzleScript/src/demo

Expect a modest yield and read the number honestly. Most of these rooms are
eleven tiles square, which is smaller than the screen, and a room that has to
be padded out to be seen is a room somebody drew for a different frame.
"""
import argparse, json, re, sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_dataset import BUILD, serve, record          # noqa: E402
from level_kit import describe                          # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
MIN_W, MIN_H = 20, 14
# And the size a room has to be already. The median PuzzleScript room is
# eleven by ten, which grown out to a screen is a small abstract shape
# floating in a walled box - a picture of a puzzle rather than a place, and a
# hundred of those would teach exactly that. Only rooms drawn near the scale
# they will be looked at survive; two thirds are not, and the summary says so
# rather than quietly padding them.
DRAWN_W, DRAWN_H = 16, 11

# What an object's name says it is. PuzzleScript has no types, only names, and
# a decade of people naming things has settled into a small vocabulary.
MEANS = [
    (('wall', 'brick', 'stone', 'rock', 'tree', 'block', 'border', 'edge'), 'wall'),
    (('water', 'lava', 'fire', 'spike', 'death', 'hazard', 'pit', 'hole', 'acid'), 'hazard'),
    (('player', 'me', 'hero', 'you', 'cat', 'guy'), 'player'),
    (('target', 'goal', 'exit', 'door', 'flag', 'home'), 'goal'),
    (('crate', 'box', 'ball', 'gem', 'coin', 'star', 'egg', 'apple', 'fruit'), 'thing'),
    (('background', 'floor', 'ground', 'empty', 'sand', 'grass'), 'floor'),
]


def meaning(names):
    low = ' '.join(names).lower()
    for words, kind in MEANS:
        if any(w in low for w in words):
            return kind
    return 'floor'


def sections(text):
    """PuzzleScript separates its parts with a line of equals signs, with the
    part's name on the line above it."""
    lines = text.replace('\r\n', '\n').replace('\r', '\n').split('\n')
    out, name, buf = {}, 'header', []
    for i, line in enumerate(lines):
        if set(line.strip()) == {'='} and len(line.strip()) >= 3:
            if buf:
                buf.pop()                      # the heading belongs to what follows
            out[name] = out.get(name, []) + buf
            name = (lines[i - 1] if i else '').strip().lower()
            buf = []
            continue
        buf.append(line)
    out[name] = out.get(name, []) + buf
    return out


def legend_of(parts):
    """Character to meaning. A legend entry may name several objects at once -
    `@ = Crate and Target` - and the first one that means something wins."""
    look = {}
    for line in parts.get('legend', []):
        if '=' not in line or line.strip().startswith('('):
            continue
        left, right = line.split('=', 1)
        ch = left.strip()
        if len(ch) != 1:
            continue
        names = re.split(r'\band\b|\bor\b', right, flags=re.I)
        look[ch] = meaning([n.strip() for n in names if n.strip()])
    return look


def levels_of(parts):
    """The grids, and only the grids: a LEVELS section is also where messages
    and comments live, and a run of them looks like a very thin room."""
    out, cur = [], []
    for raw in parts.get('levels', []):
        line = raw.rstrip()
        bare = line.strip()
        if not bare or bare.startswith('(') or bare.lower().startswith('message'):
            if len(cur) >= 5:
                out.append(cur)
            cur = []
            continue
        cur.append(line)
    if len(cur) >= 5:
        out.append(cur)
    # A room is a rectangle. Ragged blocks are prose that happened to be short.
    return [g for g in out if len({len(r.rstrip()) for r in g}) == 1 and len(g[0].strip()) >= 5]


def convert(title, name, grid, look):
    h, w = len(grid), max(len(r) for r in grid)
    if w < DRAWN_W or h < DRAWN_H:
        return None
    tiles = [['0'] * w for _ in range(h)]
    ents, start = [], None
    for y, row in enumerate(grid):
        for x, ch in enumerate(row.ljust(w)):
            kind = look.get(ch, 'floor')
            if kind == 'wall':
                tiles[y][x] = '2'
            elif kind == 'hazard':
                tiles[y][x] = '4'
            elif kind == 'player':
                start = (x, y)
            elif kind == 'goal':
                ents.append({'type': 'gem', 'x': x * 8, 'y': y * 8})
            elif kind == 'thing':
                ents.append({'type': 'coin', 'x': x * 8, 'y': y * 8})
    if not start or not ents:
        return None

    # Out to the size of a screen, walled, so the room sits in the frame it is
    # going to be looked at in rather than floating in a corner of it.
    px, py = max(0, (MIN_W - w + 1) // 2), max(0, (MIN_H - h + 1) // 2)
    if px or py:
        nw, nh = max(w + 2 * px, MIN_W), max(h + 2 * py, MIN_H)
        grown = [['2'] * nw for _ in range(nh)]
        for y in range(h):
            for x in range(w):
                grown[y + py][x + px] = tiles[y][x]
        tiles, w, h = grown, nw, nh
        ents = [{**e, 'x': e['x'] + px * 8, 'y': e['y'] + py * 8} for e in ents]
        start = (start[0] + px, start[1] + py)
    if w * h > 39000:
        return None

    return {
        'name': f'{title} {name}'[:40],
        'mode': 'topdown',
        'seed': f'{title}-{name}'[:24],
        'sky0': '#0a0a14', 'sky1': '#1a1626',
        'player': {'char': 'hero'},
        'start': {'x': start[0] * 8, 'y': start[1] * 8},
        'lives': 3,
        'level': {'w': w, 'h': h, 'tiles': '\n'.join(''.join(r) for r in tiles)},
        'entities': ents[:40],
        'rules': {'collect': 0, 'keys': 0, 'clearAll': True},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='src', required=True)
    ap.add_argument('--out', default='data/study/puzzlescript.jsonl')
    ap.add_argument('--rejects', default='data/study/puzzlescript-rejects.jsonl')
    ap.add_argument('--min-moved', type=int, default=24)
    args = ap.parse_args()

    src = Path(args.src)
    files = [src] if src.is_file() else sorted(src.rglob('*.txt'))
    made, why = [], Counter()
    for f in files:
        try:
            text = f.read_text(encoding='utf-8', errors='replace')
        except Exception:
            continue
        parts = sections(text)
        look = legend_of(parts)
        if not look:
            why['no legend'] += 1
            continue
        title = (re.search(r'^title\s+(.+)$', text, re.M | re.I) or [None, f.stem])[1].strip()
        rooms = levels_of(parts)
        if not rooms:
            why['no rooms'] += 1
        for i, grid in enumerate(rooms):
            spec = convert(title, str(i + 1), grid, look)
            if spec:
                made.append((f'{f.stem}/{i + 1}', spec))
            else:
                why['too small, or nobody in it'] += 1
    print(f'{len(files)} files, {len(made)} rooms to grade', file=sys.stderr)
    if not made:
        print(json.dumps({'files': len(files), 'why': dict(why)}, indent=2))
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
                        rejects.append({'room': tag, 'why': 'threw: ' + v['error'][:60]})
                    elif not v.get('ok'):
                        rejects.append({'room': tag,
                                        'why': 'invalid: ' + '; '.join(v.get('errors') or [])[:80]})
                    elif v.get('moved', 0) < args.min_moved:
                        rejects.append({'room': tag, 'why': f"a bot got {v.get('moved', 0)}px into it"})
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
        'files': len(files), 'rooms_offered': len(made), 'written': len(kept),
        'file': str(out), 'rejected': len(rejects),
        'skipped': dict(why.most_common(5)),
        'top_rejections': dict(Counter(r['why'].split(':')[0][:40] for r in rejects).most_common(4)),
    }, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
