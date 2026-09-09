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
from level_kit import furnish, describe  # noqa: E402
import gbs_script  # noqa: E402

T = 8
MODES = {'TOPDOWN': 'topdown', 'PLATFORM': 'platform', 'SHMUP': 'shmup'}


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


def build_spec(scene, name, rng):
    """A scene becomes terrain; level_kit puts the game into it."""
    mode = MODES.get(scene.get('type'))
    if not mode:
        return None, f"scene type {scene.get('type')} has no equivalent"
    grid, w, h = scene_to_grid(scene)
    if grid is None:
        return None, 'collision layer did not decode'
    if mode == 'shmup':
        grid, w, h = transpose(grid, w, h)
    return furnish(grid, w, h, mode, name)


def emit_routines(ctx, defs):
    """Every routine reachable from the scripts, not only the ones called
    directly. Translating a routine body turns up more routines, so this runs
    to a fixed point - iterating the set once left every script referring to a
    routine that was never written out, and none of them compiled."""
    out, emitted = [], set()
    pending = set(ctx.used_routines)
    while pending:
        name = pending.pop()
        if name in emitted:
            continue
        emitted.add(name)
        ctx.self_tag = ''
        lines = [l for l in gbs_script.translate(defs.get(name) or [], ctx) if l.strip()]
        body = '\n'.join('  ' + l for l in lines) if lines else '  print "todo"'
        out.append(f'define {name}\n{body}\nend')
        pending |= (ctx.used_routines - emitted)
    return out


def decode_bitfield(bits, n):
    """GB Studio 1.x and 2.x packed collisions as one bit per tile, eight to a
    byte, rather than the run-length hex that 3.x and 4.x use."""
    return [1 if (bits[i >> 3] >> (i & 7)) & 1 else 0 for i in range(n)] if bits else [0] * n


def load_legacy(path):
    """A whole project in one file: scenes, actors, triggers and scripts all
    inline. Everything before GB Studio 3 is shaped this way, which is most of
    what is published."""
    d = json.loads(path.read_text(encoding='utf-8'))
    scenes, names = [], {}
    for sc in d.get('scenes') or []:
        w, h = int(sc.get('width') or 0), int(sc.get('height') or 0)
        if not (w and h):
            continue
        cells = decode_bitfield(sc.get('collisions') or [], w * h)
        names[sc.get('id')] = sc.get('name') or 'room'
        scripts = []
        for tr in sc.get('triggers') or []:
            if tr.get('script'):
                scripts.append(('start', tr['script'], '', f"trigger in {sc.get('name')}"))
        for ac in sc.get('actors') or []:
            if ac.get('script'):
                scripts.append(('start', ac['script'], gbs_script.slug(ac.get('id', '')[:8]),
                                f"actor in {sc.get('name')}"))
        scenes.append({
            'name': sc.get('name') or 'room',
            # 1.x had no scene types; everything was walked around from above.
            'type': sc.get('type') or 'TOPDOWN',
            'width': w, 'height': h,
            'grid': [[1 if cells[y * w + x] else 0 for x in range(w)] for y in range(h)],
            'scripts': scripts,
        })
    routines = {c.get('id'): gbs_script.slug(c.get('name')) for c in (d.get('customEvents') or [])}
    defs = {gbs_script.slug(c.get('name')): c.get('script') or [] for c in (d.get('customEvents') or [])}
    actors = {}
    for sc in d.get('scenes') or []:
        for ac in sc.get('actors') or []:
            actors[ac.get('id')] = gbs_script.slug(ac.get('id', '')[:8])
    return scenes, names, routines, defs, actors


def find_projects(src):
    """Every project under a folder, new format or old."""
    out = []
    for f in sorted(src.rglob('*.gbsproj')):
        try:
            d = json.loads(f.read_text(encoding='utf-8'))
        except Exception:
            continue
        if isinstance(d.get('scenes'), list) and d['scenes']:
            out.append(('legacy', f))
        elif (f.parent / 'project' / 'scenes').exists():
            out.append(('split', f.parent))
    return out


def read_scripts(src):
    """Every script in a project, translated, plus what would not translate."""
    actors, routines, defs = {}, {}, {}
    for f in src.rglob('scenes/**/actors/*.gbsres'):
        try:
            a = json.loads(f.read_text(encoding='utf-8'))
            actors[a.get('id')] = gbs_script.slug(a.get('name'))
        except Exception:
            pass
    for f in src.rglob('scripts/**/*.gbsres'):
        try:
            c = json.loads(f.read_text(encoding='utf-8'))
            if c.get('_resourceType') in (None, 'customEvent') or 'script' in c:
                routines[c.get('id')] = gbs_script.slug(c.get('name'))
                defs[gbs_script.slug(c.get('name'))] = c.get('script') or []
        except Exception:
            pass

    scenes = {}
    for f in src.rglob('scenes/**/scene.gbsres'):
        try:
            d = json.loads(f.read_text(encoding='utf-8'))
            scenes[d.get('id')] = d.get('name') or f.parent.name
        except Exception:
            pass

    ctx = gbs_script.Ctx(actors=actors, routines=routines, scenes=scenes)
    out, seen = [], set()

    def take(nodes, event, self_tag, where):
        if not nodes:
            return
        ctx.self_tag = self_tag
        lines = gbs_script.translate(nodes, ctx)
        lines = [l for l in lines if l.strip()]
        if len(lines) < 2:
            return
        body = '\n'.join('  ' + l for l in lines)
        src_text = f'on {event}\n{body}\nend'
        key = src_text
        if key in seen:
            return
        seen.add(key)
        out.append({'where': where, 'event': event, 'lines': len(lines), 'script': src_text,
                    'describe': gbs_script.describe(lines, event)})

    for f in src.rglob('scenes/**/scene.gbsres'):
        try:
            d = json.loads(f.read_text(encoding='utf-8'))
        except Exception:
            continue
        take(d.get('script'), 'start', '', d.get('name') or f.parent.name)
    for f in src.rglob('scenes/**/triggers/*.gbsres'):
        try:
            d = json.loads(f.read_text(encoding='utf-8'))
        except Exception:
            continue
        take(d.get('script'), 'start', '', f'trigger {d.get("name") or f.stem}')
    for f in src.rglob('scenes/**/actors/*.gbsres'):
        try:
            d = json.loads(f.read_text(encoding='utf-8'))
        except Exception:
            continue
        tag = gbs_script.slug(d.get('name'))
        take(d.get('startScript'), 'start', tag, f'actor {d.get("name")}')
        take(d.get('updateScript'), 'tick', tag, f'actor {d.get("name")} each frame')

    # Routines that got used, written out so a translated script compiles.
    return out, emit_routines(ctx, defs), ctx.missing


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='src', required=True, help='a GB Studio project folder, or a folder of them')
    ap.add_argument('--out', default='data/gbstudio.jsonl')
    ap.add_argument('--rejects', default='data/gbstudio-rejects.jsonl')
    ap.add_argument('--min-moved', type=int, default=24)
    ap.add_argument('--seed', default='gbs')
    ap.add_argument('--scripts', default='data/gbstudio-scripts.jsonl',
                    help='where to write translated scripts as training pairs')
    args = ap.parse_args()

    src = Path(args.src).expanduser()
    projects = find_projects(src)
    split = sorted(src.rglob('scenes/**/scene.gbsres'))
    if not projects and not split:
        print(f'no GB Studio projects under {src}', file=sys.stderr)
        return 1

    rng = random.Random(args.seed)
    made, rejects = [], []
    legacy_scripts, legacy_routines = [], []

    # The old single-file layout, which is most of what has been published.
    for kind, path in projects:
        if kind != 'legacy':
            continue
        try:
            scenes_l, names, routines, defs, actors = load_legacy(path)
        except Exception as e:
            rejects.append({'scene': str(path), 'why': f'unreadable: {e}'}); continue
        ctx = gbs_script.Ctx(actors=actors, routines=routines, scenes=names)
        for sc in scenes_l:
            spec, why = furnish(sc['grid'], sc['width'], sc['height'],
                                MODES.get(sc['type'], 'topdown'), f"{path.stem}/{sc['name']}")
            if spec is None:
                rejects.append({'scene': sc['name'], 'why': why})
            else:
                made.append((sc['name'], spec, sc))
            for event, nodes, self_tag, where in sc['scripts']:
                ctx.self_tag = self_tag
                lines = [l for l in gbs_script.translate(nodes, ctx) if l.strip()]
                if len(lines) < 2:
                    continue
                body = '\n'.join('  ' + l for l in lines)
                legacy_scripts.append({'where': where, 'event': event, 'lines': len(lines),
                                       'script': f'on {event}\n{body}\nend',
                                       'describe': gbs_script.describe(lines, event)})
        legacy_routines += emit_routines(ctx, defs)

    print(f'{len(split)} split scene(s), {len(made)} from single-file projects', file=sys.stderr)

    # The split layout that GB Studio 3 and 4 write.
    for f in split:
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

    # Scripts travel separately from levels: they are the part a generator
    # cannot invent, and the part our language was missing until now.
    scripts, routines, missing = read_scripts(src)
    scripts = scripts + legacy_scripts
    routines = routines + legacy_routines
    if args.scripts and scripts:
        sp = ROOT / args.scripts
        sp.parent.mkdir(parents=True, exist_ok=True)
        preamble = ('\n\n'.join(routines) + '\n\n') if routines else ''
        with sp.open('w', encoding='utf-8') as fh:
            for r in scripts:
                if not r['describe']:
                    continue
                fh.write(json.dumps({'messages': [
                    {'role': 'system', 'content': 'You write NeoJutsu game scripts. Reply with script and nothing else.'},
                    {'role': 'user', 'content': r['describe']},
                    {'role': 'assistant', 'content': preamble + r['script']},
                ]}, ensure_ascii=False) + '\n')

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
                verdicts = page.evaluate(CHECK, {'prompts': [s for _, s, _ in chunk]})
                for (name, spec, scene), v in zip(chunk, verdicts):
                    if v.get('error'):
                        rejects.append({'scene': name, 'why': 'threw: ' + v['error'][:60]})
                    elif not v.get('ok'):
                        rejects.append({'scene': name, 'why': 'invalid: ' + '; '.join(v.get('errors') or [])[:80]})
                    elif v.get('moved', 0) < args.min_moved:
                        rejects.append({'scene': name, 'why': f"a bot got {v.get('moved', 0)}px into it"})
                    else:
                        kept.append((describe(spec), spec))
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
    print(json.dumps({'scenes': len(split) + len(made), 'written': len(kept), 'file': str(out),
                      'by_mode': by, 'rejected': len(rejects),
                      'why': [r['why'][:50] for r in rejects[:6]],
                      'scripts': {'translated': len(scripts), 'routines': len(routines),
                                  'file': args.scripts if scripts else None,
                                  # What our language still cannot say, counted
                                  # from a real game rather than imagined.
                                  'no_equivalent': dict(missing.most_common(10))}}, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
