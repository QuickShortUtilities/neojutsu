"""The importers read what they claim to read.

Four formats arrive from outside: ZZT worlds, the Video Game Level Corpus,
PuzzleScript games and itch.io pages. Each is somebody else's, none of them
can be changed to suit us, and all four are parsed by hand - which is exactly
the kind of code that quietly starts returning something plausible and wrong.

Nothing here touches the network. Each fixture is built here, byte for byte,
so a failure means the parser changed rather than that a website did.
"""
import json, struct, sys, tempfile, zipfile
from pathlib import Path

ROOT = Path('/Users/christophercohen/Documents/GitHub/neojutsu')
sys.path.insert(0, str(ROOT / 'tools'))
issues, report = [], {}

import import_zzt as Z            # noqa: E402
import import_vglc as V           # noqa: E402
import import_puzzlescript as P   # noqa: E402
import find_itch as I             # noqa: E402


# ---------- ZZT ----------
def zzt_world():
    """A world of one board: a room with a wall down the middle, a player, a
    gem, a key, a lion and a passage out."""
    W, H = Z.W, Z.H
    cells = [22] * (W * H)                      # normal wall everywhere
    for y in range(2, H - 2):
        for x in range(2, W - 2):
            cells[y * W + x] = 0                # hollow it out
    for y in range(2, H - 2):
        cells[y * W + 30] = 21                  # a solid wall down the middle
    cells[5 * W + 5] = 4                        # player
    cells[6 * W + 6] = 7                        # gem
    cells[7 * W + 7] = 8                        # key
    cells[8 * W + 8] = 41                       # lion
    cells[9 * W + 9] = 14                       # energizer
    cells[10 * W + 40] = 11                     # passage out

    rle = bytearray()
    i = 0
    while i < len(cells):
        e = cells[i]
        n = 0
        while i + n < len(cells) and cells[i + n] == e and n < 255:
            n += 1
        rle += bytes([n, e, 0x0f])
        i += n

    name = b'Test Room'
    body = bytearray([len(name)]) + name + bytes(50 - len(name)) + rle
    body += bytes(86)                            # board properties
    body += struct.pack('<h', -1)                # no stats at all
    world = bytearray(struct.pack('<hh', -1, 0)) + bytes(512 - 4)
    world += struct.pack('<h', len(body)) + body
    return bytes(world)


data = zzt_world()
bs = Z.boards(data)
report['zzt'] = {'boards': len(bs)}
if len(bs) != 1:
    issues.append(f'a one-board world split into {len(bs)} boards')
else:
    b = Z.read_board(bs[0])
    if not b:
        issues.append('the board would not read at all')
    else:
        report['zzt']['name'] = b['name']
        if b['name'] != 'Test Room':
            issues.append(f"board name came back {b['name']!r}")
        spec = Z.to_spec(b, 'test')
        if not spec:
            issues.append('a board with a player in it produced no game')
        else:
            rows = spec['level']['tiles'].split('\n')
            kinds = sorted({e['type'] for e in spec['entities']})
            report['zzt'].update({'start': spec['start'], 'cast': kinds,
                                  'wall_col': rows[10][30], 'floor': rows[10][20]})
            if spec['start'] != {'x': 5 * 8, 'y': 5 * 8}:
                issues.append(f"the player landed at {spec['start']}, not 5,5")
            if rows[10][30] != '2':
                issues.append(f"the solid wall came through as {rows[10][30]!r}")
            if rows[10][20] != '0':
                issues.append(f"open floor came through as {rows[10][20]!r}")
            for want in ('gem', 'key', 'chaser', 'pellet'):
                if want not in kinds:
                    issues.append(f'{want} did not survive the trip: {kinds}')
            if 'i' not in spec['level']['tiles']:
                issues.append('the passage out was lost')

# A board whose player is only in the stat list, never drawn.
b2 = {'name': 'Unvisited', 'cells': [0] * (Z.W * Z.H), 'stats': [(12, 9)]}
for i in range(Z.W * Z.H):
    b2['cells'][i] = 0
b2['cells'][3 * Z.W + 3] = 7
spec2 = Z.to_spec(b2, 'test2')
report['zzt']['from_stats'] = spec2['start'] if spec2 else None
if not spec2 or spec2['start'] != {'x': 11 * 8, 'y': 8 * 8}:
    issues.append(f'a player kept only in the stat list was lost: {spec2 and spec2["start"]}')


# ---------- VGLC ----------
legend = {
    '-': ['passable', 'empty'],
    '#': ['solid', 'ground'],
    'H': ['solid', 'damaging', 'hazard'],
    'T': ['solidtop', 'passable', 'platform'],
    'o': ['collectable', 'coin'],
    'E': ['damaging', 'enemy'],
    'D': ['solid', 'openable', 'door'],
    '%': ['climbable', 'ladder'],
}
grid = ['-' * 30 for _ in range(6)] + ['-' * 10 + 'o' + '-' * 8 + 'E' + '-' * 10,
                                       '-' * 12 + 'TTT' + '-' * 15,
                                       '-' * 30, '-' * 14 + '%' + '-' * 15,
                                       '#' * 12 + 'HH' + '#' * 16,
                                       '#' * 30, '#' * 30, '#' * 30]
spec = V.convert('Test Game 1', grid, legend, 'platform')
report['vglc'] = {}
if not spec:
    issues.append('a plain platformer grid would not convert')
else:
    rows = spec['level']['tiles'].split('\n')
    kinds = sorted({e['type'] for e in spec['entities']})
    report['vglc'] = {'size': [spec['level']['w'], spec['level']['h']],
                      'cast': kinds, 'ground': rows[-1][0], 'hazard': rows[10][12],
                      'ledge': rows[7][12], 'ladder': rows[9][14]}
    if rows[-1][0] != '2':
        issues.append(f"solid ground read as {rows[-1][0]!r}")
    if rows[10][12] != '4':
        issues.append(f"a hazard read as {rows[10][12]!r}, so it does not hurt")
    if rows[7][12] != '3':
        issues.append(f"a one-way platform read as {rows[7][12]!r}")
    if rows[9][14] != '5':
        issues.append(f"a ladder read as {rows[9][14]!r}")
    if 'coin' not in kinds or 'walker' not in kinds:
        issues.append(f'the cast did not come through: {kinds}')
    if 'i' not in spec['level']['tiles']:
        issues.append('no way out of a level that had no exit character')

# A game with no legend borrows the union of the others.
with tempfile.TemporaryDirectory() as td:
    d = Path(td)
    (d / 'Kid Icarus').mkdir()
    (d / 'Kid Icarus' / 'KidIcarus.json').write_text(json.dumps({'tiles': legend}))
    (d / 'Kid Icarus' / 'Processed').mkdir()
    (d / 'Kid Icarus' / 'Processed' / 'one.txt').write_text('\n'.join(grid))
    (d / 'Super Mario Land').mkdir()
    (d / 'Super Mario Land' / 'Processed').mkdir()
    (d / 'Super Mario Land' / 'Processed' / 'two.txt').write_text('\n'.join(grid))
    games = V.read_corpus(d)
    report['vglc']['borrowed'] = bool(games.get('Super Mario Land', {}).get('borrowed'))
    if not games.get('Super Mario Land', {}).get('legend'):
        issues.append('a game with no legend of its own got none at all')


# ---------- PuzzleScript ----------
PS = """title Test Push
author nobody

========
OBJECTS
========

Background
GREEN

=======
LEGEND
=======

. = Background
# = Wall
P = Player
* = Crate
@ = Target
~ = Water

=======
LEVELS
=======

message Here we go.

#########
#.......#
#.P.*...#
#...#..@#
#..~....#
#.......#
#########

"""
parts = P.sections(PS)
look = P.legend_of(parts)
rooms = P.levels_of(parts)
report['puzzlescript'] = {'legend': look, 'rooms': len(rooms)}
if look.get('#') != 'wall' or look.get('P') != 'player':
    issues.append(f'the legend was misread: {look}')
if look.get('~') != 'hazard':
    issues.append(f"water did not read as a hazard: {look.get('~')}")
if len(rooms) != 1:
    issues.append(f'{len(rooms)} rooms found, expected one (a message is not a room)')
else:
    spec = P.convert('Test Push', '1', rooms[0], look)
    if not spec:
        issues.append('a room with a player and a crate produced no game')
    else:
        report['puzzlescript']['size'] = [spec['level']['w'], spec['level']['h']]
        report['puzzlescript']['cast'] = sorted({e['type'] for e in spec['entities']})
        if spec['level']['w'] < 20 or spec['level']['h'] < 14:
            issues.append(f"a small room was not grown to fit the screen: "
                          f"{spec['level']['w']}x{spec['level']['h']}")
        if not spec['rules'].get('clearAll'):
            issues.append('a push room should end by clearing the board')


# ---------- itch.io ----------
PAGE = """<html><body>
<div class="formatted_description user_formatted">
  <p>A short game about a <b>haunted</b> lighthouse.</p><p>Made in a weekend.</p>
</div><div class="after"></div>
<table><tr><td>Made with</td><td>GB Studio, Aseprite</td></tr></table>
<a href="/games/tag-gbstudio">gbstudio</a><a href="/games/tag-horror">horror</a>
<a href="https://github.com/someone/lighthouse-gb">source</a>
<a href="https://github.com/itchio/itch">the itch app</a>
</body></html>"""
got = I.read_page(PAGE)
report['itch'] = got
if 'haunted lighthouse' not in got['description'].lower():
    issues.append(f"the description did not come through: {got['description'][:60]!r}")
if 'GB Studio' not in got['made_with']:
    issues.append(f"made-with was missed: {got['made_with']!r}")
if 'gbstudio' not in got['tags'] or 'horror' not in got['tags']:
    issues.append(f"tags were missed: {got['tags']}")
if 'https://github.com/someone/lighthouse-gb' not in got['links']:
    issues.append(f'the source link was missed: {got["links"]}')
if any('itchio' in u for u in got['links']):
    issues.append('itch\'s own repository was taken for somebody\'s source')

# Both orders of attributes on a game link, which is how itch really writes them.
LUMP = json.dumps({'content':
    '<a href="https://one.itch.io/a" class="thumb_link game_link"></a>'
    '<a class="thumb_link game_link" href="https://two.itch.io/b"></a>'})
import re                                                       # noqa: E402
found = []
for tag in re.findall(r'<a\b[^>]*class="[^"]*thumb_link[^"]*"[^>]*>', json.loads(LUMP)['content']):
    m = re.search(r'href="([^"]+)"', tag)
    if m:
        found.append(m.group(1))
report['itch']['both_orders'] = found
if len(found) != 2:
    issues.append(f'a game link is only read when its attributes are in one order: {found}')

print(json.dumps({'report': report, 'issues': issues}, indent=2, default=str))
print('\nFour formats, read the way they are written.' if not issues else f'\n{len(issues)} issue(s).')
sys.exit(1 if issues else 0)
