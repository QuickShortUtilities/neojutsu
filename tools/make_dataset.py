#!/usr/bin/env python3
"""Build fine-tuning pairs for a game-writing model.

The games come from the studio's own generator, driven in a real browser, so
there is one implementation of what a game is and the dataset cannot drift
away from what the engine plays. Every candidate is then graded the way a
player would grade it: it has to validate, and a bot has to be able to get
somewhere in it.

Genres are kept apart. One flat pile of "games" teaches a model that a racing
level and a dungeon are the same thing wearing different colours, which is
exactly the mistake worth avoiding - so records carry their mode and category
and are written per genre as well as combined.

    python3 tools/make_dataset.py --count 2000
    python3 tools/make_dataset.py --count 200 --out data/games.jsonl
"""
import argparse, json, hashlib, random, sys, threading, functools, http.server, socketserver
from pathlib import Path
from collections import Counter

ROOT = Path(__file__).resolve().parents[1]

# Vocabulary the generator's own reader understands. Keeping the prompt bank
# and the parser in step is what makes a pair honest: the description has to
# be true of the game that comes back.
KINDS = [
    ('platform', ['a platformer', 'a side-scrolling platformer', 'a jumping level',
                  'a platform level', 'a side-on level with ledges']),
    ('topdown',  ['a top-down dungeon', 'an overhead maze', 'a dungeon crawl',
                  'a top-down level of rooms', 'an overhead dungeon']),
    ('racer',    ['a racing level', 'a driving level', 'a rally stage',
                  'a car race', 'a speedway run']),
    ('shmup',    ['a space shooter', 'a shoot-em-up', 'a starfighter run',
                  'a bullet hell', 'a dogfight in space']),
]
PLACES = {
    'cave':    ['underground', 'in a cave', 'in a dark cavern', 'in a deep mine'],
    'ice':     ['in a frozen cave', 'on a glacier', 'somewhere icy', 'in the snow'],
    'sky':     ['on floating islands', 'high above the clouds', 'in the sky'],
    'sunset':  ['at sunset', 'in the evening', 'at dusk'],
    'factory': ['in a factory', 'in a machine works', 'on an assembly line'],
    'ruins':   ['in some ruins', 'in an old fortress', 'in a broken keep'],
    'volcano': ['inside a volcano', 'in lava caves', 'somewhere burning'],
    'temple':  ['in a temple', 'at a shrine', 'in an old sanctuary'],
}
MECHS = {
    'springs':    ['with bounce pads', 'full of springs', 'with trampolines'],
    'belts':      ['with conveyor belts', 'with moving belts'],
    'ice':        ['with slippery ground', 'where the floor is icy'],
    'doors':      ['with a locked door and a key', 'where a key opens the way'],
    'breakables': ['with bricks you can smash', 'with breakable crates'],
    'water':      ['with water to swim through', 'partly flooded'],
    'moving':     ['with moving platforms', 'with platforms that slide'],
}
ABILITIES = {
    'doubleJump': ['with a double jump', 'where you can jump twice'],
    'dash':       ['with a dash', 'where you can dash'],
    'wallJump':   ['with a wall jump', 'where you can climb walls'],
    'attack':     ['where you can shoot', 'with a weapon'],
}
HARD = ['hard', 'difficult', 'brutal', 'tough', 'punishing']
EASY = ['easy', 'gentle', 'simple', 'relaxed']
SIZES = {'wide': ['long', 'big', 'sprawling'], 'small': ['short', 'small', 'quick'],
         'tall': ['tall', 'vertical']}
OPENERS = ['Make ', 'Create ', 'Build ', 'Design ', 'Generate ', '']


def make_prompt(rng):
    """A description, and the things it commits the generator to."""
    mode, kinds = rng.choice(KINDS)
    parts = [rng.choice(kinds)]
    expect = {'mode': mode}

    theme = rng.choice(list(PLACES)) if rng.random() < 0.8 else None
    if theme:
        parts.append(rng.choice(PLACES[theme]))
        expect['theme'] = theme

    # Several mechanics only make sense side-on; asking for one in a racer
    # would be a description the generator cannot honour.
    if mode == 'platform' and rng.random() < 0.6:
        mech = rng.choice(list(MECHS))
        parts.append(rng.choice(MECHS[mech]))
        expect['mech'] = mech

    if rng.random() < 0.4:
        ab = rng.choice(list(ABILITIES))
        parts.append(rng.choice(ABILITIES[ab]))
        expect['ability'] = ab

    r = rng.random()
    if r < 0.25:
        parts.append(rng.choice(HARD)); expect['difficulty'] = 2
    elif r < 0.5:
        parts.append(rng.choice(EASY)); expect['difficulty'] = 0

    if rng.random() < 0.35:
        size = rng.choice(list(SIZES))
        parts.append(rng.choice(SIZES[size]))

    if rng.random() < 0.45:
        n = rng.randint(3, 16)
        parts.append(f'{n} coins to collect')
        expect['collect'] = n

    rng.shuffle(parts[1:])
    text = rng.choice(OPENERS) + ', '.join(parts)
    return text[0].upper() + text[1:] + '.', expect


# ---- the browser side: generate, validate, and try to play ----
BUILD = r"""
(prompts) => {
  const T = 8, TILES = window.NeoGame.TILES;

  // The same bot the picker uses to keep its previews alive. A game a bot
  // cannot move through is not a game, whatever the validator says.
  function drive(g, seconds) {
    const info = (tx, ty) => TILES[g.level.at(tx, ty)] || {};
    const steps = Math.round(seconds * 60);
    for (let i = 0; i < steps; i++) {
      if (g.state !== 'play') break;
      const p = g.player;
      if (g.mode === 'racer' || g.mode === 'shmup') {
        const row = Math.floor((p.y + p.h / 2) / T);
        const here = Math.floor((p.x + p.w / 2) / T);
        let L = here, R = here;
        while (L > 0 && info(L - 1, row).solid !== true && here - L < 12) L--;
        while (R < g.level.w - 1 && info(R + 1, row).solid !== true && R - here < 12) R++;
        const want = ((L + R) / 2) * T + T / 2;
        g.input.left = want < p.x + p.w / 2 - 3;
        g.input.right = want > p.x + p.w / 2 + 3;
      } else if (g.mode === 'topdown') {
        // No gravity to jump with: a wall means going round it, so pick a
        // side and hold it for a while rather than jittering on the spot.
        const ahead = Math.floor((p.x + p.w + 2) / T);
        const mid = Math.floor((p.y + p.h / 2) / T);
        const blocked = info(ahead, mid).solid === true;
        const flip = Math.floor(i / 40) % 2 === 0;
        g.input.right = !blocked;
        g.input.left = false;
        g.input.up = blocked && flip;
        g.input.down = blocked && !flip;
      } else {
        const ahead = Math.floor((p.x + p.w + 2) / T);
        const mid = Math.floor((p.y + p.h / 2) / T);
        const foot = Math.floor((p.y + p.h + 2) / T);
        const blocked = info(ahead, mid).solid === true;
        const gap = info(ahead, foot).solid !== true && !info(ahead, foot).hazard;
        const spike = !!info(ahead, foot).hazard || !!info(ahead, mid).hazard;
        g.input.right = true;
        g.input.a = blocked || gap || spike;
      }
      g.tick(1 / 60);
      g.input.a = false;
    }
  }

  return prompts.map(prompt => {
    try {
      const r = window.NeoGameGen.generateValid(prompt);
      const spec = r.spec;
      const v = window.NeoGame.validate(spec);
      const out = { prompt, spec, understood: r.understood,
                    ok: v.ok, errors: v.errors.slice(0, 3), warnings: v.warnings.length };
      if (v.ok) {
        const cv = document.createElement('canvas'); cv.width = 160; cv.height = 144;
        const g = window.NeoGame.create(cv, JSON.parse(JSON.stringify(spec)), { hud: false });
        const x0 = g.player.x, y0 = g.player.y;
        const vx0 = g.view.x, vy0 = g.view.y;
        drive(g, 14);
        // In a scroller the player is held in the frame and the world moves,
        // so their own displacement is near zero however well it is going.
        // Progress is whichever of the two actually travelled.
        out.moved = Math.round(Math.max(
          Math.abs(g.player.x - x0), Math.abs(g.player.y - y0),
          Math.abs(g.view.x - vx0), Math.abs(g.view.y - vy0)));
        out.state = g.state;
        out.scored = g.score;
        out.lost = (spec.lives ?? 3) - g.lives;
      }
      return out;
    } catch (e) { return { prompt, error: String(e && e.message || e) }; }
  });
}
"""

SYSTEM = ('You write NeoJutsu games. Reply with one JSON object and nothing else. '
          'One tile is 8 pixels; level.w and level.h are in tiles while start and entity '
          'x/y are in pixels. Tiles are rows of base-36 digits joined with newlines.')


def serve():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
    srv = socketserver.TCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(ROOT)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


def record(prompt, spec):
    return {'messages': [
        {'role': 'system', 'content': SYSTEM},
        {'role': 'user', 'content': prompt},
        {'role': 'assistant', 'content': json.dumps(spec, separators=(',', ':'))},
    ]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--count', type=int, default=800)
    ap.add_argument('--out', default='data/games.jsonl')
    ap.add_argument('--genre-dir', default='data/by-genre')
    ap.add_argument('--rejects', default='data/rejects.jsonl')
    ap.add_argument('--batch', type=int, default=12)
    ap.add_argument('--seed', default='neojutsu')
    ap.add_argument('--min-moved', type=int, default=24,
                    help='pixels a bot must cover before a game counts as playable')
    args = ap.parse_args()

    from playwright.sync_api import sync_playwright
    rng = random.Random(args.seed)
    kept, rejects = [], []
    seen = set()
    reasons = Counter()

    srv, port = serve()
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(headless=True)
            page = b.new_context(viewport={'width': 900, 'height': 700}).new_page()
            page.on('pageerror', lambda e: reasons.update(['page error: ' + str(e)[:40]]))
            page.goto(f'http://127.0.0.1:{port}/game.html')
            page.wait_for_function('!!(window.NeoGameGen && window.NeoSprites && window.NeoSprites.loaded)',
                                   timeout=30000)

            guard = 0
            while len(kept) < args.count and guard < args.count * 6:
                batch = [make_prompt(rng) for _ in range(args.batch)]
                guard += len(batch)
                results = page.evaluate(BUILD, [pr for pr, _ in batch])
                for (prompt, expect), r in zip(batch, results):
                    why = None
                    spec = r.get('spec')
                    if r.get('error'):
                        why = 'threw: ' + r['error'][:40]
                    elif not r.get('ok'):
                        why = 'invalid: ' + (r.get('errors') or ['?'])[0][:50]
                    elif spec.get('mode') != expect['mode']:
                        why = f"asked for {expect['mode']}, got {spec.get('mode')}"
                    elif 'collect' in expect and (spec.get('rules') or {}).get('collect') != expect['collect']:
                        why = 'collect count not honoured'
                    elif 'theme' in expect and r['understood'].get('theme') != expect['theme']:
                        why = 'theme not understood'
                    elif r.get('moved', 0) < args.min_moved:
                        why = f"a bot got {r.get('moved', 0)}px into it"
                    else:
                        key = hashlib.sha1(json.dumps(spec, sort_keys=True).encode()).hexdigest()
                        if key in seen:
                            why = 'duplicate level'
                        else:
                            seen.add(key)
                    if why:
                        reasons.update([why.split(':')[0][:44]])
                        rejects.append({'prompt': prompt, 'why': why,
                                        'spec': spec if spec else None})
                    else:
                        kept.append((prompt, spec))
                print(f'\rkept {len(kept)}/{args.count}  tried {guard}  '
                      f'rejected {len(rejects)}', end='', file=sys.stderr)
            b.close()
    finally:
        srv.shutdown()
    print(file=sys.stderr)

    kept = kept[:args.count]
    out = ROOT / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open('w', encoding='utf-8') as f:
        for prompt, spec in kept:
            f.write(json.dumps(record(prompt, spec), ensure_ascii=False) + '\n')

    # Per genre as well as combined, so a model can be trained or evaluated on
    # one kind of game without the others drowning it out.
    by = {}
    for prompt, spec in kept:
        by.setdefault(spec.get('mode', 'other'), []).append((prompt, spec))
    gdir = ROOT / args.genre_dir
    gdir.mkdir(parents=True, exist_ok=True)
    for mode, rows in by.items():
        with (gdir / f'{mode}.jsonl').open('w', encoding='utf-8') as f:
            for prompt, spec in rows:
                f.write(json.dumps(record(prompt, spec), ensure_ascii=False) + '\n')

    if args.rejects:
        rj = ROOT / args.rejects
        rj.parent.mkdir(parents=True, exist_ok=True)
        with rj.open('w', encoding='utf-8') as f:
            for r in rejects:
                f.write(json.dumps(r, ensure_ascii=False) + '\n')

    sizes = sorted(len(json.dumps(s, separators=(',', ':'))) for _, s in kept) or [0]
    print(json.dumps({
        'written': len(kept), 'file': str(out),
        'by_mode': {k: len(v) for k, v in sorted(by.items())},
        'rejected': len(rejects),
        'accept_rate': round(len(kept) / max(1, len(kept) + len(rejects)), 3),
        'chars': {'min': sizes[0], 'median': sizes[len(sizes) // 2], 'max': sizes[-1]},
        'top_rejections': dict(reasons.most_common(6)),
    }, indent=2))


if __name__ == '__main__':
    main()
