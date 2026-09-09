#!/usr/bin/env python3
"""Build fine-tuning pairs for a game-writing model.

Generates varied games with a description that is true of each one, then keeps
only those the engine will actually accept and play. The filter is the same
validator the studio uses plus a short simulation, so nothing enters the dataset
that a player could not finish.

    python3 tools/make_dataset.py --count 400 --out data/games.jsonl
"""
import argparse, json, random, sys, threading, functools, http.server, socketserver
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
T = 8

THEMES = {
    'cave':    {'sky': ('#0d0a16', '#241a30'), 'char': 'beast',    'words': ['underground', 'in a cave', 'in a dark cavern']},
    'ice':     {'sky': ('#0a1830', '#4a7fa8'), 'char': 'ninja',    'words': ['in a frozen cave', 'on a glacier', 'somewhere icy']},
    'sky':     {'sky': ('#1b2a5c', '#bfe9ff'), 'char': 'hero',     'words': ['on floating islands', 'high above the clouds', 'in the sky']},
    'sunset':  {'sky': ('#241844', '#c9598a'), 'char': 'princess', 'words': ['at sunset', 'in the evening', 'at dusk']},
    'factory': {'sky': ('#0d0a16', '#3a2a4a'), 'char': 'robot',    'words': ['in a factory', 'in a machine works', 'on an assembly line']},
    'ruins':   {'sky': ('#12002a', '#7a1236'), 'char': 'knight',   'words': ['in some ruins', 'in an old fortress', 'in a broken keep']},
    'volcano': {'sky': ('#2a0410', '#8c2350'), 'char': 'rogue',    'words': ['inside a volcano', 'in lava caves', 'somewhere burning']},
    'temple':  {'sky': ('#0a1424', '#2a5a7a'), 'char': 'mage',     'words': ['in a temple', 'at a shrine', 'in an old sanctuary']},
}
MECHANICS = ['plain', 'springs', 'belts', 'ice', 'doors', 'breakables', 'water', 'moving']
ABILITIES = ['none', 'doubleJump', 'dash', 'attack', 'wallJump']


def grid(w, h, fill='0'):
    return [[fill] * w for _ in range(h)]


def rows(g):
    return '\n'.join(''.join(r) for r in g)


def make_platform(rng, theme, mech, w, h, difficulty):
    g = grid(w, h)
    ground = h - 3
    for y in range(ground, h):
        for x in range(w):
            g[y][x] = '1'

    # pits, and something unpleasant at the bottom of them
    pit_char = 'e' if theme == 'volcano' else ('6' if mech == 'water' else '4')
    x = 6
    pits = []
    while x < w - 8:
        if rng.random() < 0.28 + difficulty * 0.12:
            span = rng.randint(2, 3 + (1 if difficulty > 1 else 0))
            for px in range(x, min(x + span, w - 4)):
                for y in range(ground, h):
                    g[y][px] = '0'
                g[h - 1][px] = pit_char
            pits.append((x, span))
            x += span + rng.randint(4, 7)
        else:
            x += rng.randint(3, 6)

    # ledges to climb, and the mechanic this game is about
    ledges = []
    x = 4
    while x < w - 6:
        if rng.random() < 0.5:
            span = rng.randint(3, 5)
            y = ground - rng.randint(3, 5)
            ch = '3'
            if mech == 'ice': ch = '8'
            if mech == 'belts': ch = '9' if rng.random() < .5 else 'a'
            for lx in range(x, min(x + span, w - 2)):
                g[y][lx] = ch
            ledges.append((x, y, span))
            x += span + rng.randint(3, 6)
        else:
            x += rng.randint(4, 8)

    if mech == 'springs':
        for _ in range(max(1, len(pits))):
            sx = rng.randint(3, w - 5)
            g[ground - 1][sx] = 'b'
    if mech == 'breakables':
        for _ in range(rng.randint(3, 6)):
            bx, by = rng.randint(3, w - 4), ground - rng.randint(4, 6)
            g[by][bx] = '7'

    ents, coins = [], 0
    for (lx, ly, span) in ledges:
        for i in range(min(2, span)):
            ents.append({'type': 'coin', 'x': (lx + i) * T + 1, 'y': (ly - 1) * T + 1}); coins += 1
    for _ in range(rng.randint(2, 5)):
        ents.append({'type': 'coin', 'x': rng.randint(2, w - 3) * T, 'y': (ground - 1) * T}); coins += 1
    if rng.random() < .4:
        ents.append({'type': 'gem', 'x': rng.randint(2, w - 3) * T, 'y': (ground - 2) * T})

    foes = ['walker', 'flyer', 'chaser', 'jumper', 'turret']
    n_foes = 1 + difficulty + rng.randint(0, 2)
    for _ in range(n_foes):
        kind = rng.choice(foes[:3 + difficulty])
        ents.append({'type': kind, 'x': rng.randint(6, w - 4) * T,
                     'y': (ground - 2) * T, 'dir': rng.choice([1, -1])})
    if difficulty == 0 or rng.random() < .4:
        ents.append({'type': 'heart', 'x': rng.randint(3, w - 3) * T, 'y': (ground - 2) * T})

    keys = 0
    if mech == 'doors':
        dx = int(w * 0.62)
        for y in (ground - 2, ground - 1):
            g[y][dx] = 'c'
        ents.append({'type': 'key', 'x': rng.randint(3, dx - 3) * T, 'y': (ground - 2) * T})
        keys = 1
    if mech == 'moving':
        ents.append({'type': 'mover', 'x': int(w * .5) * T, 'y': (ground - 4) * T})

    ents.append({'type': 'goal', 'x': (w - 3) * T, 'y': (ground - 2) * T})
    return g, ents, coins, keys, ground


def make_topdown(rng, theme, mech, w, h, difficulty):
    g = grid(w, h, '1')
    rooms = []
    for (rx, ry) in [(2, 2), (int(w * .55), 2), (2, int(h * .55)), (int(w * .55), int(h * .55))]:
        rw, rh = int(w * .38), int(h * .38)
        for y in range(ry, min(ry + rh, h - 1)):
            for x in range(rx, min(rx + rw, w - 1)):
                g[y][x] = '0'
        rooms.append((rx, ry, rw, rh))
    mid_x, mid_y = int(w * .48), int(h * .48)
    for x in range(2, w - 2): g[mid_y][x] = '0'
    for y in range(2, h - 2): g[mid_x][y % h] = '0'
    for y in range(2, h - 2): g[y][mid_x] = '0'
    hazard = '6' if mech == 'water' else '4'
    for _ in range(2 + difficulty * 2):
        g[rng.randint(3, h - 4)][rng.randint(3, w - 4)] = hazard

    ents, coins = [], 0
    for (rx, ry, rw, rh) in rooms:
        for _ in range(2):
            ents.append({'type': 'coin', 'x': (rx + rng.randint(1, max(1, rw - 2))) * T,
                         'y': (ry + rng.randint(1, max(1, rh - 2))) * T}); coins += 1
    for _ in range(1 + difficulty):
        ents.append({'type': rng.choice(['walker', 'chaser']),
                     'x': rng.randint(3, w - 4) * T, 'y': rng.randint(3, h - 4) * T,
                     'dir': rng.choice([1, -1])})
    keys = 0
    if mech == 'doors' or rng.random() < .4:
        for x in range(mid_x - 1, mid_x + 2): g[mid_y][x] = 'c'
        ents.append({'type': 'key', 'x': (rooms[1][0] + 2) * T, 'y': (rooms[1][1] + 2) * T})
        keys = 1
    ents.append({'type': 'goal', 'x': (rooms[3][0] + 2) * T, 'y': (rooms[3][1] + 2) * T})
    return g, ents, coins, keys, None


def script_for(rng, mech, need, timed):
    lines = []
    hello = rng.choice(['GO', 'GOOD LUCK', 'BEGIN', 'MOVE'])
    lines.append(f'on start\n  message "{hello}"\nend')
    if timed:
        secs = rng.choice([30, 45, 60, 90])
        lines.append(f'on start\n  set left {secs}\nend')
        lines.append('on tick\n  every 1\n    set left left - 1\n    if left == 10\n      message "10 LEFT"\n    end\n    if left <= 0\n      lose\n    end\n  end\nend')
    if mech == 'doors' and rng.random() < .6:
        lines.append('on collect\n  if keys >= 1\n    message "DOOR OPEN"\n  end\nend')
    if rng.random() < .35:
        lines.append('on hurt\n  shake 3\nend')
    if rng.random() < .3 and need:
        lines.append(f'on collect\n  if score >= {need}\n    message "GO TO THE FLAG"\n  end\nend')
    return '\n'.join(lines)


def describe(rng, theme, mode, mech, ability, difficulty, need, timed, size):
    t = THEMES[theme]
    where = rng.choice(t['words'])
    kind = 'top-down' if mode == 'topdown' else 'platformer'
    bits = [f'a {kind} set {where}']
    if size == 'wide': bits.append('a long level')
    elif size == 'tall': bits.append('a tall level to climb')
    elif size == 'small': bits.append('a short level')
    mech_words = {
        'springs': 'bouncy springs', 'belts': 'conveyor belts', 'ice': 'slippery ice',
        'doors': 'a locked door and a key', 'breakables': 'breakable bricks',
        'water': 'water to swim through', 'moving': 'a moving platform',
    }
    if mech in mech_words: bits.append(mech_words[mech])
    ability_words = {'doubleJump': 'a double jump', 'dash': 'a dash', 'attack': 'the ability to shoot',
                     'wallJump': 'wall jumping'}
    if ability in ability_words: bits.append(f'give the player {ability_words[ability]}')
    bits.append(['easy', 'normal', 'hard'][difficulty])
    if need: bits.append(f'{need} things to collect')
    if timed: bits.append('a countdown')
    ask = rng.choice(['Make', 'Build', 'Create', 'Design', 'Write'])
    return f'{ask} {bits[0]} with ' + ', '.join(bits[1:-1]) + f', {bits[-1]}.' if len(bits) > 2 \
        else f'{ask} {bits[0]}.'


def build_one(rng):
    theme = rng.choice(list(THEMES))
    mode = 'topdown' if rng.random() < 0.22 else 'platform'
    mech = rng.choice(MECHANICS)
    ability = rng.choice(ABILITIES)
    difficulty = rng.randint(0, 2)
    size = rng.choice(['small', 'normal', 'wide', 'tall'])
    if mode == 'topdown':
        w, h = rng.choice([(26, 20), (30, 22), (34, 24)])
    else:
        w, h = {'small': (28, 16), 'normal': (40, 18), 'wide': (56, 18), 'tall': (22, 34)}[size]

    maker = make_topdown if mode == 'topdown' else make_platform
    g, ents, coins, keys, ground = maker(rng, theme, mech, w, h, difficulty)
    need = 0
    if coins and rng.random() < .75:
        need = max(1, int(coins * rng.choice([.5, .7, 1.0])))
    timed = rng.random() < .18
    t = THEMES[theme]
    start_y = (ground - 2) * T if ground else 3 * T
    spec = {
        'name': f'{theme.title()} {rng.choice(["run", "climb", "dive", "trial", "path", "chase"])}',
        'mode': mode, 'seed': f'{theme}{rng.randint(100, 999)}',
        'sky0': t['sky'][0], 'sky1': t['sky'][1],
        'player': {'char': t['char']},
        'start': {'x': 2 * T, 'y': start_y},
        'lives': [4, 3, 2][difficulty],
        'level': {'w': w, 'h': h, 'tiles': rows(g)},
        'entities': ents,
        'rules': {'collect': need, 'keys': keys},
    }
    if ability != 'none':
        spec['player'][ability] = True
    script = script_for(rng, mech, need, timed)
    if script:
        spec['script'] = script
    prompt = describe(rng, theme, mode, mech, ability, difficulty, need, timed, size)
    return prompt, spec


# ---------- validation in the real engine ----------
def serve():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
    srv = socketserver.TCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(ROOT)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


CHECK = """(specs)=>specs.map(spec=>{
  const v = window.NeoGame.validate(spec);
  if (!v.ok) return {ok:false, why:v.errors.slice(0,2)};
  try {
    const cv=document.createElement('canvas'); cv.width=160; cv.height=144;
    const g=window.NeoGame.create(cv, JSON.parse(JSON.stringify(spec)), {hud:false});
    g.tick(1.5);
    if (g.state!=='play') return {ok:false, why:['dies immediately']};
    if (g.player.y > spec.level.h*8+40) return {ok:false, why:['falls out of the world']};
    g.input.right=true; for(let i=0;i<300;i++) g.tick(1/60); g.input.right=false;
    if (g.scriptFault) return {ok:false, why:['script fault: '+g.scriptFault]};
    return {ok:true, warnings:v.warnings.length};
  } catch(e) { return {ok:false, why:['threw: '+e.message]}; }
})"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--count', type=int, default=400)
    ap.add_argument('--out', default='data/games.jsonl')
    ap.add_argument('--seed', type=int, default=7)
    ap.add_argument('--batch', type=int, default=50)
    args = ap.parse_args()

    from playwright.sync_api import sync_playwright
    rng = random.Random(args.seed)
    srv, port = serve()
    kept, rejected, reasons = [], 0, {}
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(headless=True)
            page = b.new_context().new_page()
            page.goto(f'http://127.0.0.1:{port}/game.html'); page.wait_for_timeout(900)
            made = 0
            while len(kept) < args.count and made < args.count * 4:
                batch = [build_one(rng) for _ in range(args.batch)]
                made += len(batch)
                verdicts = page.evaluate(CHECK, [s for _, s in batch])
                for (prompt, spec), v in zip(batch, verdicts):
                    if v['ok']:
                        kept.append((prompt, spec))
                    else:
                        rejected += 1
                        for w in v['why']:
                            key = w.split(':')[0][:40]
                            reasons[key] = reasons.get(key, 0) + 1
                print(f'\rkept {len(kept)}/{args.count}  rejected {rejected}', end='', file=sys.stderr)
            b.close()
    finally:
        srv.shutdown()
    print(file=sys.stderr)

    out = ROOT / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    system = ('You write NeoJutsu games. Reply with one JSON object and nothing else. '
              'One tile is 8 pixels; level.w and level.h are in tiles while start and entity '
              'x/y are in pixels. Tiles are rows of base-36 digits joined with newlines.')
    with out.open('w', encoding='utf-8') as f:
        for prompt, spec in kept[:args.count]:
            f.write(json.dumps({'messages': [
                {'role': 'system', 'content': system},
                {'role': 'user', 'content': prompt},
                {'role': 'assistant', 'content': json.dumps(spec, separators=(',', ':'))},
            ]}, ensure_ascii=False) + '\n')

    sizes = [len(json.dumps(s, separators=(',', ':'))) for _, s in kept[:args.count]]
    print(json.dumps({
        'written': min(len(kept), args.count), 'file': str(out),
        'rejected': rejected,
        'accept_rate': round(len(kept) / max(1, len(kept) + rejected), 3),
        'bytes': {'min': min(sizes), 'median': sorted(sizes)[len(sizes)//2], 'max': max(sizes)},
        'top_rejections': dict(sorted(reasons.items(), key=lambda kv: -kv[1])[:5]),
    }, indent=2))


if __name__ == '__main__':
    main()
