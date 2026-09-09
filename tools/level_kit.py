"""Turning bare geometry into a game.

Importers bring in terrain and nothing else - a Tiled map knows where the
walls are and a GB Studio scene knows what is solid, but neither knows what
you are meant to do there. This is the shared part: find the places a player
can stand or walk, then put a start, some coins and somewhere to reach into
them, so what comes out is a game rather than a picture of one.
"""

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
        for x, y in spread(spots[2:], 14):
            ents.append({'type': 'coin', 'x': x * T + 1, 'y': (y - 1) * T + 1})
        gx, gy = spots[-1]
        ents.append({'type': 'goal', 'x': gx * T, 'y': (gy - 2) * T})
    elif mode == 'topdown':
        cells = sorted(open_cells(grid, w, h))
        if len(cells) < 30:
            return None, 'nowhere to walk'
        sx, sy = cells[0]
        start = {'x': sx * T, 'y': sy * T}
        for x, y in spread(cells[4:], 12):
            ents.append({'type': 'coin', 'x': x * T + 1, 'y': y * T + 1})
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


def describe(spec):
    kind = {'platform': 'a platformer', 'topdown': 'a top-down dungeon',
            'shmup': 'a space shooter', 'racer': 'a racing level'}.get(spec['mode'], 'a game')
    bits = [kind]
    lvl = spec['level']
    if lvl['w'] >= 48:
        bits.append('long')
    elif lvl['w'] <= 24:
        bits.append('short')
    if lvl['h'] >= 30:
        bits.append('tall')
    need = spec['rules']['collect']
    if need:
        bits.append(f'{need} coins to collect')
    return 'Make ' + ', '.join(bits) + '.'
