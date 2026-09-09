"""Imported geometry has to be the geometry that was drawn.

GB Studio's old single-file format stores a collision layer two different
ways - one value per tile, or one bit per tile - and reading the first as the
second does not fail. It produces a tidy repeating stripe that passes every
structural check, looks like a level at a glance, and teaches a model to draw
stripes. Roughly forty per cent of this corpus was imported that way before
anyone looked at one. So: decode both encodings exactly, and refuse a corpus
that has gone periodic.
"""
import json, sys
from pathlib import Path

ROOT = Path('/Users/christophercohen/Documents/GitHub/neojutsu')
sys.path.insert(0, str(ROOT / 'tools'))
import import_gbstudio as G

issues, report = [], {}

# ---- a value-per-tile layer decodes to exactly what was written ----
W, H = 9, 5
drawn = [
    [15, 15, 15, 0, 0, 0, 15, 15, 15],
    [15, 0,  0,  0, 0, 0, 0,  0,  15],
    [15, 0,  1,  1, 1, 0, 0,  0,  15],
    [15, 0,  0,  0, 0, 0, 0,  16, 15],
    [15, 15, 15, 15, 15, 15, 15, 15, 15],
]
flat = [v for row in drawn for v in row]
got = G.decode_bitfield(flat, W * H)
if got != flat:
    issues.append('a value-per-tile collision layer did not decode to itself')
report['value_per_tile'] = got == flat

# ---- a bitfield layer still decodes as a bitfield ----
want = [1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1]
packed = bytearray((len(want) + 7) // 8)
for i, b in enumerate(want):
    if b:
        packed[i >> 3] |= 1 << (i & 7)
bits = G.decode_bitfield(list(packed), len(want))
if [1 if v else 0 for v in bits] != want:
    issues.append(f'a bitfield collision layer decoded wrong: {bits}')
report['bitfield'] = [1 if v else 0 for v in bits] == want

# ---- the two must not be confused ----
# The stripe bug in one line: this layer is one value per tile and is the
# length of the level, so it must never be read eight tiles to a byte.
if len(flat) >= W * H and got[:W] != flat[:W]:
    issues.append('a full-length layer was read as a bitfield')

# ---- face bits survive as tiles, not as yes-or-no ----
kinds = {G.tile_for(v) for v in (0, 1, 15, 16)}
if len(kinds) < 3:
    issues.append(f'collision faces all collapse to the same tile: {kinds}')
report['tile_kinds'] = sorted(kinds)

# ---- and the whole path, on a project shaped like the ones that broke ----
# A legacy project whose collision layer is one value per tile. What comes out
# has to be the shape that went in, tile for tile.
import tempfile, shutil
tmp = Path(tempfile.mkdtemp(prefix='neojutsu-gbs-'))
try:
    proj = tmp / 'sample.gbsproj'
    proj.write_text(json.dumps({
        'name': 'sample',
        'scenes': [{
            'id': 's1', 'name': 'Town', 'type': 'TOPDOWN',
            'width': W, 'height': H, 'collisions': flat,
            'actors': [], 'triggers': [],
        }],
        'customEvents': [],
    }), encoding='utf-8')

    found = G.find_projects(tmp)
    if [k for k, _ in found] != ['legacy']:
        issues.append(f'a single-file project was not recognised: {found}')
    else:
        scenes, _names, _routines, _defs, _actors = G.load_legacy(found[0][1])
        want = [[G.tile_for(v) for v in row] for row in drawn]
        if not scenes:
            issues.append('the project loaded no scenes')
        elif scenes[0]['grid'] != want:
            issues.append('the imported grid is not the drawn grid')
            report['drawn'] = want
            report['imported'] = scenes[0]['grid']
        else:
            report['end_to_end'] = 'the imported grid is the drawn grid'
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print(json.dumps({'report': report, 'issues': issues}, indent=2))
print('\nImported geometry is the geometry that was drawn.' if not issues
      else f'\n{len(issues)} issue(s).')
sys.exit(1 if issues else 0)
