#!/usr/bin/env python3
"""Read Knytt Stories levels: hand-made side-on geometry, by the thousand.

ZZT gave this corpus its overhead levels. Knytt Stories is the same story one
axis over - a 2007 platformer whose players made levels for it for fifteen
years, archived complete - and side-on is the mode our imported half is
thinnest in.

    python3 tools/import_knytt.py --in "~/.../NEOJUTSU CORPUS/knytt-stories"

What is taken is the geometry. A Knytt level's cast is a set of objects whose
meaning depends on the bank they came from and on the level's own scripting,
which does not travel; its walls do. So the collision layer is read, cut into
level-sized pieces, and furnished with this engine's own cast - exactly what
`import_gbstudio.py` does with a GB Studio scene.

ON LICENCES. The archive states none, and these are somebody's games rather
than somebody's dataset. Output goes to data/study/, which the training run
in docs/training.md does not read.

The format, for anyone reading this later. A `.knytt.bin` is a container:
each entry is "NF", a null-terminated path, a little-endian u32 length, then
that many bytes. Inside it, `Map.bin` is gzip and holds one record per
screen: "x{X}y{Y}\\0", a u32 of 3006, then 3006 bytes -
  4 tile layers    250 bytes each, low 7 bits the tile, high bit the bank
  4 object layers  500 bytes each, 250 of ids then 250 of banks
  6 bytes          tileset a/b, ambiance a/b, music, gradient
A screen is 25 by 10.
"""
import argparse, gzip, io, json, re, struct, sys, zipfile
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_dataset import BUILD, serve, record          # noqa: E402
from level_kit import describe, furnish                 # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
SW, SH = 25, 10                                         # one screen
PER = SW * SH
SCREEN_BYTES = 3006


def entries(data):
    """The container: "NF", a path, a length, the bytes. Anything that does
    not start with NF is not one of ours and ends the walk."""
    out, at = {}, 0
    while at + 2 < len(data):
        if data[at:at + 2] != b'NF':
            break
        end = data.find(b'\0', at + 2)
        if end < 0 or end + 5 > len(data):
            break
        name = data[at + 2:end].decode('cp1252', 'replace').replace('\\', '/')
        size = struct.unpack_from('<I', data, end + 1)[0]
        start = end + 5
        if size > len(data) - start:
            break
        out[name] = data[start:start + size]
        at = start + size
    return out


def screens(map_bin):
    """Every screen in a Map.bin, by its (x, y) on the world grid."""
    try:
        raw = gzip.decompress(map_bin)
    except Exception:
        # Some levels ship it uncompressed, and a few have trailing rubbish
        # that stops gzip finishing; take what came out either way.
        try:
            d = gzip.GzipFile(fileobj=io.BytesIO(map_bin))
            raw = d.read()
        except Exception:
            raw = map_bin
    out, at = {}, 0
    while at < len(raw):
        end = raw.find(b'\0', at)
        if end < 0 or end - at > 24 or end + 4 > len(raw):
            break
        head = raw[at:end].decode('ascii', 'replace')
        m = re.fullmatch(r'x(-?\d+)y(-?\d+)', head)
        if not m:
            break
        size = struct.unpack_from('<I', raw, end + 1)[0]
        body = raw[end + 5:end + 5 + size]
        at = end + 5 + size
        if size != SCREEN_BYTES or len(body) != SCREEN_BYTES:
            continue
        out[(int(m.group(1)), int(m.group(2)))] = body
        if len(out) > 4000:
            break
    return out


def layer(body, i):
    """Tile layer i as a list of 250 tile numbers, bank folded in."""
    return list(body[i * PER:(i + 1) * PER])


def objects(body, i):
    """Object layer i as (bank, id) pairs."""
    base = 1000 + i * 2 * PER
    ids = body[base:base + PER]
    banks = body[base + PER:base + 2 * PER]
    return list(zip(banks, ids))


def solid_layer(world):
    """Which of the four tile layers holds the walls.

    Knytt Stories draws two layers behind the player and two in front, and
    only one of them stops him - and which one is a convention rather than
    anything written in the file. Rather than guess, this asks the level:
    the player start is an object, and a player stands on the ground, so the
    layer with something solid under the start and nothing in it is the one
    doing the collision. Every screen with a start in it gets a vote.
    """
    votes = Counter()
    for pos, body in world.items():
        start = None
        for i in range(4):
            for n, (bank, oid) in enumerate(objects(body, i)):
                if bank == 0 and oid == 1:
                    start = (n % SW, n // SW)
                    break
            if start:
                break
        if not start:
            continue
        sx, sy = start
        for L in range(4):
            t = layer(body, L)
            here = t[sy * SW + sx] if sy < SH else 1
            below = t[(sy + 1) * SW + sx] if sy + 1 < SH else 0
            if here == 0 and below != 0:
                votes[L] += 1
    return votes.most_common(1)[0][0] if votes else 2


def stitch(world, solid, ox, oy, cols, rows):
    """A block of neighbouring screens, as one grid of walls."""
    # Numbers, not characters: level_kit reads a cell's truth to mean solid,
    # and the string "0" is true in Python. A grid of characters here would
    # have come out as solid rock from edge to edge.
    w, h = cols * SW, rows * SH
    grid = [[0] * w for _ in range(h)]
    filled = 0
    for cy in range(rows):
        for cx in range(cols):
            body = world.get((ox + cx, oy + cy))
            if body is None:
                # A screen that is not there is outside the level: wall it off
                # rather than leave a hole somebody can walk into.
                for y in range(SH):
                    for x in range(SW):
                        grid[cy * SH + y][cx * SW + x] = 2
                continue
            t = layer(body, solid)
            for y in range(SH):
                for x in range(SW):
                    if t[y * SW + x]:
                        grid[cy * SH + y][cx * SW + x] = 2
                        filled += 1
    return grid, filled


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='src', required=True)
    ap.add_argument('--out', default='data/study/knytt.jsonl')
    ap.add_argument('--rejects', default='data/study/knytt-rejects.jsonl')
    ap.add_argument('--min-moved', type=int, default=24)
    ap.add_argument('--cols', type=int, default=2, help='screens across, per level')
    ap.add_argument('--rows', type=int, default=2, help='screens down, per level')
    ap.add_argument('--per-level', type=int, default=6,
                    help='most pieces to take from any one level, so a big world '
                         'does not drown out fifty small ones')
    ap.add_argument('--limit', type=int, default=0)
    args = ap.parse_args()

    src = Path(args.src).expanduser()
    files = [src] if src.is_file() else sorted(src.rglob('*'))
    made, why = [], Counter()
    seen_levels = 0

    def offer(name, data):
        nonlocal seen_levels
        box = entries(data)
        mb = next((v for k, v in box.items() if k.lower().endswith('map.bin')), None)
        if mb is None:
            why['no Map.bin'] += 1
            return
        world = screens(mb)
        if len(world) < args.cols * args.rows:
            why['too few screens'] += 1
            return
        seen_levels += 1
        solid = solid_layer(world)
        xs = sorted({p[0] for p in world})
        ys = sorted({p[1] for p in world})
        taken = 0
        for oy in range(min(ys), max(ys) + 1, args.rows):
            for ox in range(min(xs), max(xs) + 1, args.cols):
                if taken >= args.per_level:
                    return
                # Only where most of the block is really there.
                have = sum(1 for cy in range(args.rows) for cx in range(args.cols)
                           if (ox + cx, oy + cy) in world)
                if have < args.cols * args.rows:
                    continue
                grid, filled = stitch(world, solid, ox, oy, args.cols, args.rows)
                w, h = args.cols * SW, args.rows * SH
                open_cells = w * h - filled
                # A block that is nearly all wall, or nearly all sky, is not a
                # place: it is the edge of somebody's map.
                if not (0.25 < open_cells / (w * h) < 0.92):
                    why['all wall or all sky'] += 1
                    continue
                spec, bad = furnish(grid, w, h, 'platform', f'{Path(name).stem} {ox},{oy}')
                if spec is None:
                    why[f'would not furnish: {bad}'[:44]] += 1
                    continue
                made.append((f'{Path(name).stem}:{ox},{oy}', spec))
                taken += 1

    def dig(name, data, depth=0):
        low = name.lower()
        if low.endswith('.knytt.bin'):
            offer(name, data)
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
            if args.limit and len(made) >= args.limit:
                return

    for f in files:
        if not f.is_file():
            continue
        try:
            dig(f.name, f.read_bytes())
        except Exception:
            continue
        if args.limit and len(made) >= args.limit:
            break

    print(f'{seen_levels} level(s) read, {len(made)} pieces to grade', file=sys.stderr)
    if not made:
        print(json.dumps({'levels': seen_levels, 'why': dict(why.most_common(8))}, indent=2))
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
                        rejects.append({'piece': tag, 'why': 'threw: ' + v['error'][:60]})
                    elif not v.get('ok'):
                        rejects.append({'piece': tag,
                                        'why': 'invalid: ' + '; '.join(v.get('errors') or [])[:80]})
                    elif v.get('moved', 0) < args.min_moved:
                        rejects.append({'piece': tag, 'why': f"a bot got {v.get('moved', 0)}px into it"})
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
        'levels_read': seen_levels, 'pieces_offered': len(made), 'written': len(kept),
        'file': str(out), 'rejected': len(rejects),
        'skipped': dict(why.most_common(6)),
        'top_rejections': dict(Counter(r['why'].split(':')[0][:40] for r in rejects).most_common(5)),
    }, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
