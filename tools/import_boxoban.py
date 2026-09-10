#!/usr/bin/env python3
"""Import Boxoban levels into NeoJutsu format.

Boxoban is 1.5 million Sokoban levels (10x10 grids).
This script parses them and writes them as top-down puzzle rooms
using pushable blocks and switches.
"""
import argparse, json, sys
from pathlib import Path

def parse_boxoban(text):
    levels = []
    lines = text.strip().split('\n')
    current = []
    for line in lines:
        if line.startswith(';'):
            if current:
                levels.append(current)
                current = []
        elif line.strip():
            current.append(line)
    if current:
        levels.append(current)
    return levels

def convert_level(grid):
    # Boxoban mapping: 
    # # = wall -> 2 (stone)
    # . = goal -> switch (we'll map to a tile if we add one, or use a gem for now)
    # $ = box -> crate entity
    # * = box on goal -> crate entity on switch
    # @ = player -> player start
    # + = player on goal -> player on switch
    # ' ' = floor -> 0 (empty)
    w = max(len(r) for r in grid)
    h = len(grid)
    tiles = []
    entities = []
    player = None
    
    for y, row in enumerate(grid):
        t_row = ""
        for x in range(w):
            c = row[x] if x < len(row) else ' '
            if c == '#':
                t_row += '2'
            elif c == '.':
                t_row += '0'
                entities.append({"type": "switch", "x": x*8, "y": y*8})
            elif c == '$':
                t_row += '0'
                entities.append({"type": "crate", "x": x*8, "y": y*8})
            elif c == '*':
                t_row += '0'
                entities.append({"type": "switch", "x": x*8, "y": y*8})
                entities.append({"type": "crate", "x": x*8, "y": y*8})
            elif c == '@':
                t_row += '0'
                player = {"x": x*8, "y": y*8}
            elif c == '+':
                t_row += '0'
                entities.append({"type": "switch", "x": x*8, "y": y*8})
                player = {"x": x*8, "y": y*8}
            else:
                t_row += '0'
        tiles.append(t_row)
        
    return {
        "mode": "topdown",
        "rules": {"collect": len([e for e in entities if e['type'] == 'crate'])},
        "levels": [{
            "w": w, "h": h,
            "start": player or {"x": 8, "y": 8},
            "tiles": "\n".join(tiles),
            "entities": entities
        }]
    }

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--in', dest='input', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()

    in_path = Path(args.input)
    if not in_path.exists():
        print(f"Not found: {in_path}")
        sys.exit(1)

    with open(in_path, 'r') as f:
        levels = parse_boxoban(f.read())
        
    converted = [convert_level(l) for l in levels]
    
    with open(args.out, 'w') as f:
        for c in converted:
            f.write(json.dumps(c) + "\n")
            
    print(f"Imported {len(converted)} Boxoban levels.")

if __name__ == '__main__':
    main()
