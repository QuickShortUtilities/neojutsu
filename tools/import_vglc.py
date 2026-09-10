#!/usr/bin/env python3
"""Read the Video Game Level Corpus, which is the best level design there is.

The VGLC is the academic corpus for this exact problem: Super Mario Bros,
Super Mario Land, Kid Icarus, Mega Man, Lode Runner and others, hand-annotated
as character grids with a legend saying what each character means. Nothing
generated comes close to it for pacing - these are levels professionals made
and millions of people played.

    python3 tools/import_vglc.py --in ~/vglc --out data/study/vglc.jsonl

Each game ships its own legend, so nothing here is hardcoded per game: the
legend says "solid" or "hazard" or "climbable" and the converter reads that,
which is why Rainbow Islands works without anybody having played it.

ON LICENCES, AND THIS ONE MATTERS. These are Nintendo's and Capcom's and
Broderbund's levels, transcribed. The corpus is published for research and
that is a well-worn path, but a model shipped to the public having been
trained on them is a different question with a different answer. It writes to
data/study/, which `docs/training.md` does not put in the training run. That
is deliberate. Mixing it in is a decision for a person to take on purpose.
"""
import argparse, io, json, sys, zipfile
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_dataset import BUILD, serve, record          # noqa: E402
from level_kit import describe, spread                  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]

# Games whose levels are a body moving through a tilemap. Doom is rooms in
# three dimensions and Super Mario Kart is a road seen through a trick of the
# hardware; neither is a thing this engine has.
PLAYS = {
    'Super Mario Bros': 'platform',
    'Super Mario Bros 2': 'platform',
    'Super Mario Bros 2 (Japan)': 'platform',
    'Super Mario Land': 'platform',
    'Kid Icarus': 'platform',
    'MegaMan': 'platform',
    'Rainbow Islands': 'platform',
    'Lode Runner': 'platform',
}

MIN_W, MIN_H = 20, 14        # a level narrower than the screen is not a level


def tile_for(words):
    """One tile, from what the legend says it does. Order matters: a thing
    that is both solid and damaging is a hazard first, because that is the
    part a player has to know."""
    w = {str(x).lower() for x in words}
    # An enemy before a hazard. The corpus marks its monsters as both
    # "damaging" and "enemy", and asking about damage first turned every one
    # of them into a spike: a level with the shape of its threats and none of
    # their movement, which is a different game.
    if 'enemy' in w:
        return '0', 'walker'
    if w & {'hazard', 'damaging'}:
        return '4', None
    if w & {'ladder', 'climbable', 'rope'}:
        return '5', None
    if w & {'door', 'openable', 'locked'}:
        return 'c', None
    if w & {'collectable', 'coin', 'pickupable', 'gold'}:
        return '0', 'coin'
    if w & {'powerup', 'health', 'question block', 'full question block'}:
        return '0', 'heart'
    if w & {'key'}:
        return '0', 'key'
    if w & {'moving'} and w & {'platform'}:
        return '0', 'mover'
    if w & {'solidtop'}:
        return '3', None
    if w & {'breakable', 'diggable'}:
        return '7', None
    if w & {'exit', 'destination'}:
        return 'i', None
    if w & {'start', 'spawn', 'source'}:
        return '0', 'start'
    if w & {'solid', 'wall', 'ground', 'floor', 'pipe'}:
        return '2', None
    return '0', None          # passable, empty, decorative, out of bounds


def convert(name, grid, legend, mode):
    """A character grid, as a game. The legend has already said what
    everything is; this places it and works out where a body can stand."""
    h = len(grid)
    w = max(len(r) for r in grid)
    rows = [r.ljust(w, list(legend)[0] if False else ' ') for r in grid]

    look = {ch: tile_for(words) for ch, words in legend.items()}
    tiles = [['0'] * w for _ in range(h)]
    ents, start = [], None
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            t, thing = look.get(ch, ('0', None))
            tiles[y][x] = t
            if thing == 'start':
                start = (x, y)
            elif thing:
                ents.append({'type': thing, 'x': x * 8, 'y': y * 8})

    # Somewhere to begin: the first open cell with ground under it, from the
    # left, because these levels are read left to right.
    if not start:
        for x in range(1, w - 1):
            for y in range(h - 2):
                if tiles[y][x] == '0' and tiles[y + 1][x] == '0' and tiles[y + 2][x] in '1234567f':
                    start = (x, y)
                    break
            if start:
                break
    if not start:
        return None

    # Narrower or shorter than the screen and there is nothing to look at.
    if w < MIN_W:
        pad = (MIN_W - w + 1) // 2
        tiles = [['2'] * pad + r + ['2'] * (MIN_W - w - pad) for r in tiles]
        ents = [{**e, 'x': e['x'] + pad * 8} for e in ents]
        start = (start[0] + pad, start[1])
        w = MIN_W
    if h < MIN_H or w * h > 39000:
        return None

    sx, sy = start
    for y in range(max(0, sy - 1), min(h, sy + 2)):
        for x in range(max(0, sx - 1), min(w, sx + 2)):
            if tiles[y][x] == '4':
                tiles[y][x] = '0'

    # A cast, thinned. These levels have a hundred coins in them because that
    # is what an arcade game is; a level here is read in a frame 160 wide.
    pick = [e for e in ents if e['type'] in ('coin', 'heart', 'key')]
    foes = [e for e in ents if e['type'] in ('walker', 'mover')]
    ents = (spread(pick, 24) if len(pick) > 24 else pick) + \
           (spread(foes, 12) if len(foes) > 12 else foes)
    coins = sum(1 for e in ents if e['type'] == 'coin')

    has_exit = any('i' in r for r in tiles)
    if not has_exit:
        # Out the right-hand side, which is where these levels end.
        for y in range(h):
            if tiles[y][w - 1] == '0' and (y + 1 >= h or tiles[y + 1][w - 1] != '0'):
                tiles[y][w - 1] = 'i'
                has_exit = True
        if not has_exit:
            tiles[max(0, sy)][w - 1] = 'i'

    return {
        'name': name[:40],
        'mode': mode,
        'seed': name[:24],
        'sky0': '#1b2a5c', 'sky1': '#7fc4e8',
        'player': {'char': 'hero'},
        'start': {'x': sx * 8, 'y': sy * 8},
        'lives': 3,
        'level': {'w': w, 'h': h, 'tiles': '\n'.join(''.join(r) for r in tiles)},
        'entities': ents,
        'rules': {'collect': min(coins, 8), 'keys': 0},
    }


def read_corpus(src):
    """Legends and levels, from a folder or from the repository's zip."""
    src = Path(src)
    files = {}
    if src.is_file() and src.suffix == '.zip':
        z = zipfile.ZipFile(src)
        for n in z.namelist():
            if n.endswith('/'):
                continue
            files[n] = z.read(n)
    else:
        for q in src.rglob('*'):
            if q.is_file():
                files[str(q.relative_to(src))] = q.read_bytes()

    # Three games in the corpus ship levels and no legend of their own -
    # Super Mario Land among them, which is the one actually made for a Game
    # Boy. Their characters are the corpus's usual ones, so the union of every
    # other legend reads them: nothing is guessed, it is borrowed from a game
    # that spelled it out.
    union = {}
    for path, data in files.items():
        if not path.endswith('.json'):
            continue
        try:
            d = json.loads(data)
        except Exception:
            continue
        for ch, words in (d.get('tiles') or {}).items():
            union.setdefault(ch, words)

    games = {}
    for path, data in files.items():
        parts = path.replace('\\', '/').split('/')
        game = next((p for p in parts if p in PLAYS), None)
        if not game:
            continue
        g = games.setdefault(game, {'legend': None, 'levels': []})
        # SMB2 ships each level twice, with its enemies and without. The one
        # with them in is the level; the other is a study aid.
        if '/NoEnemies/' in path:
            continue
        if path.endswith('.json') and g['legend'] is None:
            try:
                d = json.loads(data)
            except Exception:
                continue
            if 'tiles' in d:
                g['legend'] = d['tiles']
        elif path.endswith('.txt') and '/Original/' not in path:
            body = [r.rstrip('\r') for r in data.decode('utf-8', 'replace').split('\n')]
            body = [r for r in body if r.strip()]
            if len(body) >= 6:
                g['levels'].append((parts[-1][:-4], body))
    for game, g in games.items():
        if g['legend'] is None and union:
            g['legend'] = union
            g['borrowed'] = True
    return games


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='src', required=True)
    ap.add_argument('--out', default='data/study/vglc.jsonl')
    ap.add_argument('--rejects', default='data/study/vglc-rejects.jsonl')
    ap.add_argument('--min-moved', type=int, default=24)
    args = ap.parse_args()

    games = read_corpus(args.src)
    made, why, borrowed = [], Counter(), []
    for game, g in sorted(games.items()):
        if not g['legend']:
            why[f'{game}: no legend'] += 1
            continue
        if g.get('borrowed'):
            borrowed.append(game)
        for name, grid in sorted(g['levels']):
            spec = convert(f'{game} {name}', grid, g['legend'], PLAYS[game])
            if spec:
                made.append((f'{game}/{name}', spec))
            else:
                why[f'{game}: would not convert'] += 1
    print(f'{len(games)} games, {len(made)} levels to grade', file=sys.stderr)
    if not made:
        print(json.dumps({'games': list(games), 'why': dict(why)}, indent=2))
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
                        rejects.append({'level': tag, 'why': 'threw: ' + v['error'][:60]})
                    elif not v.get('ok'):
                        rejects.append({'level': tag,
                                        'why': 'invalid: ' + '; '.join(v.get('errors') or [])[:80]})
                    elif v.get('moved', 0) < args.min_moved:
                        rejects.append({'level': tag, 'why': f"a bot got {v.get('moved', 0)}px into it"})
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

    by = Counter(tag.split('/')[0] for tag, _ in made)
    print(json.dumps({
        'games': dict(by), 'offered': len(made), 'written': len(kept),
        'file': str(out), 'rejected': len(rejects),
        'skipped': dict(why.most_common(8)),
        'legend_borrowed_for': borrowed,
        'top_rejections': dict(Counter(r['why'].split(':')[0][:40] for r in rejects).most_common(5)),
    }, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
