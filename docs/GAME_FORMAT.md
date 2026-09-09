# NeoJutsu game format

A game is one JSON object. No code, nothing to execute. It is small on purpose:
the shipped games are 1.4–1.6 KB each.

```json
{
  "name": "Ice cavern",
  "mode": "platform",
  "seed": "ice",
  "sky0": "#0a1830",
  "sky1": "#4a7fa8",
  "player": { "char": "ninja", "doubleJump": false, "wallJump": false, "dash": false, "attack": false },
  "start": { "x": 16, "y": 104 },
  "lives": 3,
  "level": { "w": 44, "h": 18, "tiles": "0000…\n0000…" },
  "entities": [ { "type": "coin", "x": 72, "y": 81 } ],
  "rules": { "collect": 10, "keys": 0 },
  "script": "on start\n  message \"GO\"\nend"
}
```

## Coordinates

One tile is **8 pixels**. `level.w` and `level.h` are in tiles; `start` and every
entity `x`/`y` are in **pixels**. A piece on tile `(tx, ty)` sits at
`x = tx * 8`, `y = ty * 8`.

## Tiles

`level.tiles` is `h` rows of `w` base-36 digits, joined with `\n`.

| id | char | tile | behaviour |
|----|------|------|-----------|
| 0 | `0` | sky | empty |
| 1 | `1` | ground | solid |
| 2 | `2` | stone | solid |
| 3 | `3` | ledge | solid from above only |
| 4 | `4` | spikes | kills |
| 5 | `5` | ladder | climb with up/down |
| 6 | `6` | water | swim: low gravity, slow |
| 7 | `7` | brick | solid, breaks when head-butted |
| 8 | `8` | ice | solid, slippery |
| 9 | `9` | belt → | solid, carries right |
| 10 | `a` | belt ← | solid, carries left |
| 11 | `b` | spring | solid, launches |
| 12 | `c` | door | solid until every key is held |
| 13 | `d` | checkpoint | sets where death returns you |
| 14 | `e` | lava | kills |
| 15 | `f` | crate | solid, breakable |
| 16 | `g` | grass | decoration |
| 17 | `h` | backwall | decoration |
| 18 | `i` | exit | finishes the level |

## Modes

`mode` decides what kind of game this is, and it is not a setting on one game
— each is its own frame, with its own idea of what a life, a win and a control
mean. Anything else falls back to `platform`.

| mode | the shape of it | how it usually ends |
|------|-----------------|---------------------|
| `platform` | side-on, gravity, you jump | reach the flag |
| `topdown` | overhead, no gravity, you aim in four directions | reach the flag, clear the board, or beat every rival |
| `racer` | a road comes down at you; you steer | arrive at the top |
| `shmup` | a climb comes down at you; you steer and shoot up | arrive alive |
| `scramble` | a cave comes at you sideways; you fly and shoot forward | arrive at the far end |
| `invaders` | one fixed screen; a formation comes down to you | clear the formation |
| `rider` | a bike whose throttle is always on; you jump and land level | reach the finish |
| `blocks` | a well; the piece you steer becomes the level when it lands | clear the line target |

## Entities

Pickups — `coin` (+1) · `gem` (+5) · `heart` (+1 life) · `key` ·
`dot` (+1, what a maze is made of) · `pellet` (+5, and enemies flee for 7s)

The way out — `goal`

Enemies — `walker` (paces, turns at edges) · `flyer` (bobs) ·
`chaser` (hunts on sight) · `jumper` (hops) · `turret` (fires at you) ·
`hunter` (hunts *and* fires) · `ghost` (always knows where you are, slow enough
to outrun) · `invader` (moves as a formation, drops a row at the wall) ·
`rival` (touching it starts a turn-based fight, not a death) · `spike` (static)

Scenery and machinery — `mover` (moving platform)

Enemies take an optional `"dir": 1` or `-1`.

## Rules

Every game needs exactly one ending. `collect` is the default; the rest replace it.

`rules.collect` — pickups needed before the goal opens.
`rules.keys` — keys needed before doors open.
`rules.clearAll` — every pickup on the board; there is no exit to reach.
`rules.clearFoes` — every enemy that can be killed.
`rules.lines` — rows to clear, for `blocks`.
`rules.beat` — rivals to beat, for a game of fights.

## The other keys

`levels` — a run of rooms, each `{ name, level, entities, props, story, start,
rules }`. Score, lives and keys carry across; everything else belongs to the
room. A game with `levels` ignores the single `level` beside it.

`props` — scenery, `{ i, x, y, t, b }`: a sprite index, a position in pixels,
a tint, and `b: 1` to draw it behind the level instead of on top. Never solid.

`story` — speech bubbles, `{ text, … }` plus one trigger: `at` (seconds),
`score`, `keys`, `reach` (a tile column), or `on` (`kill`, `hurt`).

`scroll` — `{ speed, accel, max }` in pixels per second, for the three modes
where the world travels and you only steer.

`coop: true` — a second player on the same keyboard, sharing the lives.

## Script

Optional. A small language of its own — **not JavaScript**. See `NeoScript`.

- Events: `on start|tick|collect|hurt|kill|land|win|lose … end`
- Statements: `set NAME expr`, `if expr … [else …] end`, `while expr … end`,
  `every SECONDS … end`
- Readable: `score keys lives time x y vx vy enemies coins deaths grounded facing random`
- Actions: `message win lose open give heal hurt spawn tile warp push gravity speed shake print`

## What makes a game valid

`NeoGame.validate(spec)` refuses a spec that:

- uses an unknown tile character or entity type
- has a level larger than 40 000 tiles
- asks for more pickups than exist, or more keys than exist
- has a script that will not compile

and warns when a game has no goal and no script that can win — that is, when
nobody could finish it.
