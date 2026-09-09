#!/usr/bin/env python3
"""Turn games you already have into training pairs.

Point it at a folder of games and it produces the same JSONL the generator
does, so hand-made and synthetic data train together. Two inputs are
understood:

  *.json   a NeoJutsu spec, exactly what the studio saves and shares
  *.txt    a plain tilemap: rows of base-36 digits, optional `key: value`
           header lines above them (mode, cat, name, theme, start, lives)

Every game is validated and played by a bot before it is written, on the same
terms as a generated one - a game nobody can move through teaches a model to
write games nobody can move through.

A description is written for each game from what is actually in it, so the
pair is true even when the source file has no prose attached. Supply your own
by putting a `describe:` line in the header or a "describe" key in the JSON.

    python3 tools/import_games.py --in mygames/ --out data/imported.jsonl
"""
import argparse, json, sys, threading, functools, http.server, socketserver
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_dataset import BUILD, SYSTEM, serve, record  # noqa: E402
import level_kit  # noqa: E402
from level_kit import furnish, describe as auto_describe  # noqa: E402

MODE_WORDS = {
    'platform': 'a platformer', 'topdown': 'a top-down dungeon',
    'racer': 'a racing level', 'shmup': 'a space shooter',
}
THEME_WORDS = {
    'cave': 'underground', 'ice': 'somewhere icy', 'sky': 'in the sky',
    'sunset': 'at dusk', 'factory': 'in a factory', 'ruins': 'in some ruins',
    'volcano': 'inside a volcano', 'temple': 'in a temple',
}


# Tiled sets the top three bits of a tile id to mean flipped or rotated, so a
# gid can arrive as a number in the billions. The id is what is left below.
TMX_FLIPS = 0x1FFFFFFF
COLLISION_NAMES = ('collision', 'solid', 'terrain', 'ground', 'walls')


def read_tmx(path, mode='platform', empty=None):
    """A Tiled map. The format records where tiles are, not what they mean, so
    the emptiest tile is taken as background unless told otherwise."""
    import xml.etree.ElementTree as ET
    from collections import Counter
    root = ET.parse(path).getroot()
    w, h = int(root.get('width')), int(root.get('height'))

    layers = root.findall('layer')
    if not layers:
        raise ValueError('no tile layers')
    # A layer that names itself collision or terrain is the one that matters;
    # otherwise the first, which in a single-layer map is the whole map.
    pick = next((l for l in layers
                 if any(k in (l.get('name') or '').lower() for k in COLLISION_NAMES)), layers[0])
    data = pick.find('data')
    if data is None:
        raise ValueError('layer has no data')
    enc = data.get('encoding')
    if enc == 'csv':
        gids = [int(v) & TMX_FLIPS for v in data.text.replace('\n', '').split(',') if v.strip()]
    elif enc == 'base64':
        # Tiled's default: little-endian uint32 per tile, optionally compressed.
        import base64, zlib, struct
        raw = base64.b64decode((data.text or '').strip())
        comp = data.get('compression')
        if comp == 'zlib':
            raw = zlib.decompress(raw)
        elif comp == 'gzip':
            raw = zlib.decompress(raw, 16 + zlib.MAX_WBITS)
        elif comp:
            raise ValueError(f'{comp} compression is not understood')
        gids = [v & TMX_FLIPS for (v,) in struct.iter_unpack('<I', raw)]
    else:
        raise ValueError(f'{enc or "xml"} tile data is not understood')
    if len(gids) != w * h:
        raise ValueError(f'{len(gids)} tiles for a {w}x{h} map')

    if empty is None:
        counts = Counter(gids)
        empty = 0 if counts.get(0, 0) > len(gids) * 0.3 else counts.most_common(1)[0][0]
    grid = [[0 if gids[y * w + x] in (0, empty) else 1 for x in range(w)] for y in range(h)]

    # A Tiled map does not say what kind of game it is. Rather than assume,
    # build every mode it could be and let the bot decide which one it plays
    # as - a top-down town imported as a platformer is a player falling
    # through the floor, and that is what "platform" would have given us.
    modes = ['platform', 'topdown'] if mode == 'auto' else [mode]
    made, why = [], 'no mode fitted'
    for m in modes:
        spec, reason = furnish(grid, w, h, m, f'{path.stem} {m}' if len(modes) > 1 else path.stem)
        if spec is None:
            why = reason
        else:
            made.append(spec)
    if not made:
        raise ValueError(why)
    return made


def looks_like_tilemap(text):
    """A licence file is not a level. Rows of base-36 digits, all the same
    width, or we leave it alone rather than rejecting it noisily."""
    rows = [l.rstrip() for l in text.splitlines()
            if l.strip() and ':' not in l]
    if len(rows) < 4:
        return False
    good = [r for r in rows if len(set(r)) > 0 and all(c in '0123456789abcdefghijklmnopqrstuvwxyz' for c in r)]
    if len(good) < len(rows) * 0.9:
        return False
    return len({len(r) for r in good}) <= 2


def read_txt(path):
    """A tilemap with an optional header. Everything else is inferred."""
    head, rows = {}, []
    for line in path.read_text(encoding='utf-8').splitlines():
        if not rows and ':' in line and not line.strip().isalnum():
            k, _, v = line.partition(':')
            head[k.strip().lower()] = v.strip()
            continue
        if line.strip():
            rows.append(line.rstrip())
    if not rows:
        raise ValueError('no tile rows')
    w = max(len(r) for r in rows)
    rows = [r.ljust(w, '0') for r in rows]
    spec = {
        'name': head.get('name', path.stem),
        'mode': head.get('mode', 'platform'),
        'seed': head.get('seed', path.stem),
        'level': {'w': w, 'h': len(rows), 'tiles': '\n'.join(rows)},
        'entities': json.loads(head['entities']) if 'entities' in head else [],
        'lives': int(head.get('lives', 3)),
        'rules': {'collect': int(head.get('collect', 0)), 'keys': 0},
    }
    if 'cat' in head:
        spec['cat'] = head['cat']
    if 'start' in head:
        x, _, y = head['start'].partition(',')
        spec['start'] = {'x': int(x), 'y': int(y)}
    else:
        spec['start'] = {'x': 8, 'y': 8}
    if 'describe' in head:
        spec['describe'] = head['describe']
    return spec


def describe(spec):
    """A sentence that is true of this game, for when none was supplied.

    The same one the GB Studio import uses, which reads the level rather than
    its dimensions - four fields make twenty sentences however many levels you
    have, and a model given one prompt and a hundred answers learns to average
    them. What is added here is the things a hand-written game may carry that
    an imported scene never does: a theme it named, a key, an ability.
    """
    if spec.get('describe'):
        return str(spec['describe'])
    text = level_kit.describe(spec)
    extra = []
    theme = spec.get('theme')
    if theme in THEME_WORDS:
        extra.append(THEME_WORDS[theme])
    ents = spec.get('entities') or []
    if any(e.get('type') == 'key' for e in ents):
        extra.append('with a locked door and a key')
    if (spec.get('player') or {}).get('doubleJump'):
        extra.append('with a double jump')
    if not extra:
        return text
    return text.rstrip('.') + ', ' + ', '.join(extra) + '.'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='src', required=True, help='folder of .json / .txt / .tmx games')
    ap.add_argument('--out', default='data/imported.jsonl')
    ap.add_argument('--rejects', default='data/imported-rejects.jsonl')
    ap.add_argument('--min-moved', type=int, default=24)
    ap.add_argument('--batch', type=int, default=12)
    ap.add_argument('--mode', default='auto',
                    help='mode for .tmx maps, which carry no scene type')
    ap.add_argument('--empty', type=int, default=None,
                    help='gid that means background in a .tmx; guessed if not given')
    args = ap.parse_args()

    src = Path(args.src)
    files = sorted([f for f in src.rglob('*') if f.suffix.lower() in ('.json', '.txt', '.tmx')])
    if not files:
        print(f'no .json, .txt or .tmx games under {src}', file=sys.stderr)
        return 1
    print(f'{len(files)} file(s)', file=sys.stderr)

    loaded, broken, skipped = [], [], 0
    for f in files:
        try:
            ext = f.suffix.lower()
            if ext == '.json':
                spec = json.loads(f.read_text(encoding='utf-8'))
            elif ext == '.tmx':
                spec = read_tmx(f, args.mode, args.empty)
            else:
                text = f.read_text(encoding='utf-8', errors='replace')
                if not looks_like_tilemap(text):
                    skipped += 1
                    continue
                spec = read_txt(f)
            if isinstance(spec, dict) and 'spec' in spec:      # a saved studio project
                spec = spec['spec']
            for one in (spec if isinstance(spec, list) else [spec]):
                loaded.append((f, one))
        except Exception as e:
            broken.append({'file': str(f), 'why': f'could not read: {e}'})

    from playwright.sync_api import sync_playwright
    kept, rejects = [], list(broken)
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
            for i in range(0, len(loaded), args.batch):
                chunk = loaded[i:i + args.batch]
                verdicts = page.evaluate(CHECK, {'prompts': [s for _, s in chunk]})
                for (f, spec), v in zip(chunk, verdicts):
                    if v.get('error'):
                        rejects.append({'file': str(f), 'why': 'threw: ' + v['error'][:60]})
                    elif not v.get('ok'):
                        rejects.append({'file': str(f), 'why': 'invalid: ' + '; '.join(v.get('errors') or [])[:80]})
                    elif v.get('moved', 0) < args.min_moved:
                        rejects.append({'file': str(f), 'why': f"a bot got {v.get('moved', 0)}px into it"})
                    else:
                        clean = {k: val for k, val in spec.items() if k != 'describe'}
                        kept.append((describe(spec), clean))
                print(f'\rkept {len(kept)}  rejected {len(rejects)}', end='', file=sys.stderr)
            b.close()
    finally:
        srv.shutdown()
    print(file=sys.stderr)

    out = ROOT / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open('w', encoding='utf-8') as fh:
        for prompt, spec in kept:
            fh.write(json.dumps(record(prompt, spec), ensure_ascii=False) + '\n')
    if args.rejects and rejects:
        rj = ROOT / args.rejects
        rj.parent.mkdir(parents=True, exist_ok=True)
        with rj.open('w', encoding='utf-8') as fh:
            for r in rejects:
                fh.write(json.dumps(r, ensure_ascii=False) + '\n')

    by = {}
    for _, spec in kept:
        by[spec.get('mode', 'other')] = by.get(spec.get('mode', 'other'), 0) + 1
    print(json.dumps({'written': len(kept), 'file': str(out),
                      'by_mode': by, 'rejected': len(rejects), 'not_games': skipped,
                      'rejects_file': args.rejects if rejects else None}, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
