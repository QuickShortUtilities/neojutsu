"""Turning bare geometry into a game.

Importers bring in terrain and nothing else - a Tiled map knows where the
walls are and a GB Studio scene knows what is solid, but neither knows what
you are meant to do there. This is the shared part: find the places a player
can stand or walk, then put a start, some coins and somewhere to reach into
them, so what comes out is a game rather than a picture of one.
"""

import random

T = 8
SKY = {
    'platform': ('#1b2a5c', '#7fc4e8'),
    'topdown':  ('#0d0a16', '#241a30'),
    'shmup':    ('#0a0714', '#2a2340'),
    'racer':    ('#0d0a16', '#3a2a4a'),
}


def surfaces(grid, w, h):
    """Every ledge with headroom to stand on."""
    out = []
    for x in range(1, w - 1):
        for y in range(2, h):
            if grid[y][x] and not grid[y - 1][x] and not grid[y - 2][x]:
                out.append((x, y))
    return out


def open_cells(grid, w, h):
    return [(x, y) for y in range(1, h - 1) for x in range(1, w - 1) if not grid[y][x]]


def spread(items, n):
    """n items taken evenly across the list, so pickups are not all in a heap."""
    if not items or n <= 0:
        return []
    step = max(1, len(items) // n)
    return items[::step][:n]


def foes_for(spots, w, h, mode, seed):
    """Something to avoid, placed where a body can be.

    An imported level came out with coins and a flag and nothing else in it,
    which is a walk rather than a game - and 809 of them taught a model that
    levels are empty. The coins and the flag were always our invention too;
    this is the rest of the same invention.

    They are spread down the level and kept away from the first stretch of it,
    because arriving next to a chaser is not a difficulty curve.
    """
    if len(spots) < 12:
        return []
    kinds = ['walker', 'chaser', 'flyer'] if mode == 'platform' else \
            ['walker', 'chaser', 'turret']
    # How many. The two spot lists count different things - a platformer's are
    # places you can stand, an overhead level's is every open tile - so one
    # divisor for both put half of them on the ceiling of the range and called
    # that a formula. A ledge every dozen, a room every ninety.
    per = 12 if mode == 'platform' else 90
    want = max(1, min(18, round(len(spots) / per)))
    out, rng = [], random.Random(f'foes:{seed}:{w}x{h}')
    # Never in the opening quarter: the start is the first spot in the list.
    field = spots[max(3, len(spots) // 4):]
    for x, y in spread(field, want):
        kind = kinds[rng.randrange(len(kinds))]
        dy = 2 if mode == 'platform' else 0
        out.append({'type': kind, 'x': x * T, 'y': (y - dy) * T, 'dir': rng.choice([-1, 1])})
    return out


def furnish(grid, w, h, mode, name, lives=3):
    """Geometry in, a playable spec out - or a reason it cannot be one."""
    if w < 8 or h < 8 or w * h > 40000:
        return None, f'{w}x{h} is not a level we can use'
    solid = sum(1 for row in grid for c in row if c)
    if solid < (w * h) * 0.04:
        return None, 'almost nothing in it'
    if solid > (w * h) * 0.92:
        return None, 'almost solid rock'

    ents = []
    if mode == 'platform':
        spots = sorted(surfaces(grid, w, h))
        if len(spots) < 6:
            return None, 'no ledges to stand on'
        sx, sy = spots[0]
        start = {'x': sx * T, 'y': (sy - 2) * T}
        for x, y in spread(spots[2:], 6 + len(spots) % 9):
            ents.append({'type': 'coin', 'x': x * T + 1, 'y': (y - 1) * T + 1})
        ents += foes_for(spots, w, h, mode, name)
        gx, gy = spots[-1]
        ents.append({'type': 'goal', 'x': gx * T, 'y': (gy - 2) * T})
    elif mode == 'topdown':
        cells = sorted(open_cells(grid, w, h))
        if len(cells) < 30:
            return None, 'nowhere to walk'
        sx, sy = cells[0]
        start = {'x': sx * T, 'y': sy * T}
        for x, y in spread(cells[4:], 5 + len(cells) % 10):
            ents.append({'type': 'coin', 'x': x * T + 1, 'y': y * T + 1})
        ents += foes_for(cells, w, h, mode, name)
        gx, gy = cells[-1]
        ents.append({'type': 'goal', 'x': gx * T, 'y': gy * T})
    else:                                   # a scroller finishes at the far edge
        cells = open_cells(grid, w, h)
        if len(cells) < 30:
            return None, 'nowhere to fly'
        low = max(cells, key=lambda c: c[1])
        start = {'x': (w // 2) * T, 'y': (low[1] - 1) * T}
        for x, y in spread(sorted(cells)[6:], 10):
            ents.append({'type': 'coin', 'x': x * T + 1, 'y': y * T + 1})

    coins = sum(1 for e in ents if e['type'] == 'coin')
    sky0, sky1 = SKY.get(mode, SKY['platform'])
    spec = {
        'name': name[:40],
        'mode': mode,
        'seed': f'imp{abs(hash(name)) % 9999}',
        'sky0': sky0, 'sky1': sky1,
        'player': {'char': 'hero'},
        'start': start,
        'lives': lives,
        'level': {'w': w, 'h': h,
                  'tiles': '\n'.join(''.join(f'{c:x}' for c in row) for row in grid)},
        'entities': ents,
        'rules': {'collect': max(0, coins - 2), 'keys': 0},
    }
    return spec, None


# What a tile means to someone describing the place, rather than to the engine.
FEATURES = [
    (5,  'ladders'), (4, 'spikes'), (14, 'lava'), (6, 'water'),
    (3,  'ledges you can drop through'), (7, 'breakable blocks'),
    (15, 'crates'), (8, 'slippery ice'), (12, 'a locked door'),
    (9,  'conveyor belts'), (11, 'springs'),
]


def describe(spec):
    """A sentence that is true of this level and not of most others.

    Mode, width, height and a coin count come to twenty sentences between
    them, and 809 hand-made levels arrived wearing twenty labels - one of them
    on 120 of them. A model given the same words and a hundred different
    answers learns to average them, and averaging is the one thing these
    levels are here to prevent. So the sentence reads the level: how much of
    it is wall, what is in it, and what shape it is.
    """
    kind = {'platform': 'a platformer', 'topdown': 'a top-down dungeon',
            'shmup': 'a space shooter', 'racer': 'a racing level'}.get(spec['mode'], 'a game')
    lvl = spec['level']
    w, h = lvl['w'], lvl['h']
    rows = lvl['tiles'].split('\n') if isinstance(lvl['tiles'], str) else []
    at = lambda x, y: (int(rows[y][x], 36) if y < len(rows) and x < len(rows[y]) else 0)

    bits = [kind]
    if w >= 48:
        bits.append('long')
    elif w <= 24:
        bits.append('short')
    if h >= 30:
        bits.append('tall')

    solid = sum(1 for y in range(h) for x in range(w) if at(x, y) in (1, 2, 7, 8, 9, 10, 11, 12, 15))
    frac = solid / max(1, w * h)
    if frac < 0.12:
        bits.append('wide open')
    elif frac < 0.22:
        bits.append('open')
    elif frac > 0.62:
        bits.append('cramped')
    elif frac > 0.48:
        bits.append('dense')

    present = {at(x, y) for y in range(h) for x in range(w)}
    feats = [word for tile, word in FEATURES if tile in present]

    if spec['mode'] == 'platform':
        # Ledges with headroom - the thing a platformer is actually made of.
        ledges = len(surfaces([[at(x, y) for x in range(w)] for y in range(h)], w, h))
        per = ledges / max(1, w)
        if per > 1.4:
            bits.append('a lot of ledges')
        elif per < 0.4:
            bits.append('few places to stand')
    else:
        # Corridors or a hall: how boxed in the open floor is.
        open_cells = [(x, y) for y in range(h) for x in range(w) if not at(x, y)]
        if open_cells:
            walled = sum(1 for x, y in open_cells
                         if sum(1 for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))
                                if at(min(w - 1, max(0, x + dx)), min(h - 1, max(0, y + dy)))) >= 2)
            tight = walled / len(open_cells)
            if tight > 0.45:
                bits.append('all corridors')
            elif tight < 0.12:
                bits.append('one big room')

    need = spec['rules']['collect']
    if need:
        bits.append(f'{need} coins to collect')
    ents = spec.get('entities') or []
    foes = sum(1 for e in ents if e['type'] in ('walker', 'flyer', 'chaser', 'jumper',
                                                'turret', 'hunter', 'spike'))
    if foes >= 6:
        bits.append('crowded with enemies')
    elif foes == 0:
        bits.append('nothing in it to fight')

    out = 'Make ' + ', '.join(bits)
    if feats:
        out += ', with ' + (feats[0] if len(feats) == 1
                            else ', '.join(feats[:-1]) + ' and ' + feats[-1])
    return out + '.'
