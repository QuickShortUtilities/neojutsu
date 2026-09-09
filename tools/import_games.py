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

MODE_WORDS = {
    'platform': 'a platformer', 'topdown': 'a top-down dungeon',
    'racer': 'a racing level', 'shmup': 'a space shooter',
}
THEME_WORDS = {
    'cave': 'underground', 'ice': 'somewhere icy', 'sky': 'in the sky',
    'sunset': 'at dusk', 'factory': 'in a factory', 'ruins': 'in some ruins',
    'volcano': 'inside a volcano', 'temple': 'in a temple',
}


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
    """A sentence that is true of this game, for when none was supplied."""
    if spec.get('describe'):
        return str(spec['describe'])
    bits = [MODE_WORDS.get(spec.get('mode', 'platform'), 'a game')]
    theme = spec.get('theme')
    if theme in THEME_WORDS:
        bits.append(THEME_WORDS[theme])
    lvl = spec.get('level') or {}
    w, h = lvl.get('w', 0), lvl.get('h', 0)
    if w >= 48:
        bits.append('long')
    elif w and w <= 26:
        bits.append('short')
    if h >= 30:
        bits.append('tall')
    need = (spec.get('rules') or {}).get('collect') or 0
    if need:
        bits.append(f'{need} coins to collect')
    ents = spec.get('entities') or []
    if any(e.get('type') == 'key' for e in ents):
        bits.append('with a locked door and a key')
    foes = sum(1 for e in ents if e.get('type') in ('walker', 'flyer', 'chaser', 'jumper', 'turret'))
    if foes >= 6:
        bits.append('busy with enemies')
    if (spec.get('player') or {}).get('doubleJump'):
        bits.append('with a double jump')
    text = 'Make ' + ', '.join(bits) + '.'
    return text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='src', required=True, help='folder of .json / .txt games')
    ap.add_argument('--out', default='data/imported.jsonl')
    ap.add_argument('--rejects', default='data/imported-rejects.jsonl')
    ap.add_argument('--min-moved', type=int, default=24)
    ap.add_argument('--batch', type=int, default=12)
    args = ap.parse_args()

    src = Path(args.src)
    files = sorted([f for f in src.rglob('*') if f.suffix.lower() in ('.json', '.txt')])
    if not files:
        print(f'no .json or .txt games under {src}', file=sys.stderr)
        return 1
    print(f'{len(files)} file(s)', file=sys.stderr)

    loaded, broken = [], []
    for f in files:
        try:
            spec = json.loads(f.read_text(encoding='utf-8')) if f.suffix.lower() == '.json' else read_txt(f)
            if isinstance(spec, dict) and 'spec' in spec:      # a saved studio project
                spec = spec['spec']
            loaded.append((f, spec))
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
                      'by_mode': by, 'rejected': len(rejects),
                      'rejects_file': args.rejects if rejects else None}, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
