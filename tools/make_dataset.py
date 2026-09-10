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
    # The two arcade shapes. They are their own genres, not a platformer with
    # the gravity turned off, and nothing in the corpus was ever one.
    ('invaders', ['a space invaders game', 'a fixed shooter', 'a galaga style game',
                  'a wave of aliens coming down']),
    ('topdown',  ['a pac-man style maze chase', 'a maze chase with ghosts',
                  'a dot muncher in a maze', 'a maze where ghosts chase you']),
    ('topdown',  ['a pokemon style game with turn based battles',
                  'an overworld with creature battles', 'a game of duels on a map',
                  'a monster battler']),
    ('rider',    ['a motocross rider over hills', 'a dirt bike course',
                  'a stunt bike run', 'a trials course over jumps']),
    ('blocks',   ['a tetris style falling blocks game', 'a falling block puzzle',
                  'a stacker', 'a line clearing puzzle']),
    # The shape that is only ever science fiction: a ship, a cave and a gun.
    ('scramble', ['a gradius style side scrolling shooter', 'an r-type style horizontal shooter',
                  'a side-on shooter through a cave', 'a cave flyer with turrets']),
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
    # The two settings real games asked for and the corpus had no words for.
    'space':   ['in space', 'on a dead planet', 'aboard a derelict', 'out past the moon'],
    'haunted': ['in a haunted house', 'somewhere spooky', 'in a graveyard', 'in a cursed crypt'],
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
# Overhead only: a turret is a thing you drive, not a thing you jump with.
TOPDOWN_ABILITIES = {
    # Not "driving armour": the reader takes "driv" for a racing game, and a
    # prompt that quietly changes the genre is a prompt that cannot be met.
    'aimLock': ['in a tank', 'with a turret', 'in armour', 'as a tank with a turret'],
}
# A room to survive rather than a level to cross, and a clock to beat.
FIGHTS = ['with a boss at the end', 'where a horde comes at you',
          'an arena you have to survive', 'with a swarm to hold off']
CLOCKS = ['against the clock', 'with a countdown', 'timed']
TOGETHER = ['for two players', 'two player']
# A run of rooms rather than one room. The engine has always built these and
# nothing in the corpus was ever one, because no prompt asked for a number.
# Not "rooms": the reader takes that for an overhead game, and asking a
# platformer for three rooms turned it into a dungeon.
RUNS = ['two levels', 'three levels', 'four levels', 'a three stage run',
        'five screens', 'four stages', 'a run of three stages']
# Who you play as, and how much rope you get.
HEROES = ['as a knight', 'as a ninja', 'as a mage', 'as a robot', 'as a rogue',
          'as a beast', 'as a princess', 'playing a hero']
LIVES = ['1 life', '2 lives', '5 lives', '9 lives']
# Shapes the builder knows by name, which only ever arrived by accident before.
SHAPES = ['on floating islands', 'in a cavern', 'up a tower',
          'down a long corridor', 'up a flight of stairs']
HARD = ['hard', 'difficult', 'brutal', 'tough', 'punishing']
EASY = ['easy', 'gentle', 'simple', 'relaxed']
SIZES = {'wide': ['long', 'big', 'sprawling'], 'small': ['short', 'small', 'quick'],
         'tall': ['tall', 'vertical']}
OPENERS = ['Make ', 'Create ', 'Build ', 'Design ', 'Generate ', '']

# Games you finish by clearing the board rather than by reaching a number or a
# flag. They take none of the clauses that assume either.
ARCADE = {'a space invaders game', 'a fixed shooter', 'a galaga style game',
          'a wave of aliens coming down', 'a pac-man style maze chase',
          'a maze chase with ghosts', 'a dot muncher in a maze',
          'a maze where ghosts chase you',
          'a tetris style falling blocks game', 'a falling block puzzle',
          'a stacker', 'a line clearing puzzle',
          'a pokemon style game with turn based battles',
          'an overworld with creature battles', 'a game of duels on a map',
          'a monster battler',
          'a motocross rider over hills', 'a dirt bike course',
          'a stunt bike run', 'a trials course over jumps',
          'a gradius style side scrolling shooter', 'an r-type style horizontal shooter',
          'a side-on shooter through a cave', 'a cave flyer with turrets'}


def collect_of(spec):
    """What the game asks you to pick up. A run of rooms keeps its rules on
    each room rather than on the game, so looking only at the top level said
    every run had ignored the number it was given."""
    stages = spec.get('levels')
    if isinstance(stages, list) and stages:
        return (stages[0].get('rules') or {}).get('collect')
    return (spec.get('rules') or {}).get('collect')


# The words the generator reads as a setting. This mirrors THEMES[*].words
# in game-gen.js, and is here for one job: a genre phrase that already names a
# place has already chosen the setting, and appending another one asks for two.
# The generator settles that by which word comes first in the sentence, which
# is the genre phrase every time - so "a cave flyer, in a factory" quietly
# became a cave, and every one of those was thrown away as a theme the
# generator did not understand. 114 of 180 rejections, all from one clause.
PLACE_WORDS = (
    'cave', 'cavern', 'underground', 'tunnel', 'mine',
    'ice', 'icy', 'frozen', 'snow', 'glacier', 'cold', 'winter',
    'sky', 'cloud', 'island', 'air', 'high', 'floating',
    'sunset', 'dusk', 'evening', 'pink', 'romantic',
    'factory', 'machine', 'robot', 'industrial', 'belt', 'steel', 'assembly',
    'ruin', 'castle', 'fortress', 'keep', 'knight', 'medieval',
    'volcano', 'lava', 'fire', 'burning', 'hell', 'magma',
    'temple', 'shrine', 'sanctuary', 'magic', 'mage', 'ancient',
    'space', 'star', 'galaxy', 'planet', 'orbit', 'cosmic', 'alien', 'nebula', 'moon', 'asteroid',
    'haunted', 'spooky', 'horror', 'ghostly', 'creepy', 'graveyard', 'crypt', 'nightmare', 'cursed',
)


def make_prompt(rng):
    """A description, and the things it commits the generator to."""
    mode, kinds = rng.choice(KINDS)
    kind = rng.choice(kinds)
    parts = [kind]
    expect = {'mode': mode}
    arcade = kind in ARCADE

    # Only where the genre phrase has not named one already.
    settled = any(w in kind for w in PLACE_WORDS)
    theme = rng.choice(list(PLACES)) if not settled and rng.random() < 0.8 else None
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

    # Things the generator can build that nothing was ever asking it for. A
    # feature with no prompt in the corpus is a feature the model never sees.
    if mode == 'topdown' and rng.random() < 0.3:
        ab = rng.choice(list(TOPDOWN_ABILITIES))
        parts.append(rng.choice(TOPDOWN_ABILITIES[ab]))
        expect['ability'] = ab
    if rng.random() < 0.15:
        parts.append(rng.choice(FIGHTS))
    if rng.random() < 0.15:
        parts.append(rng.choice(CLOCKS))
    if mode in ('platform', 'topdown') and rng.random() < 0.10:
        parts.append(rng.choice(TOGETHER))
    if rng.random() < 0.12:
        parts.append(rng.choice(RUNS))
    if rng.random() < 0.15:
        parts.append(rng.choice(HEROES))
    if rng.random() < 0.10:
        parts.append(rng.choice(LIVES))
    # Only when no place was named: "in a cavern" is a shape to the builder and
    # a cave to the theme scorer, so putting one next to "in the sky" asks for
    # a theme the generator will not agree to.
    if mode == 'platform' and not theme and rng.random() < 0.35:
        parts.append(rng.choice(SHAPES))

    r = rng.random()
    if r < 0.25:
        parts.append(rng.choice(HARD)); expect['difficulty'] = 2
    elif r < 0.5:
        parts.append(rng.choice(EASY)); expect['difficulty'] = 0

    if rng.random() < 0.35:
        size = rng.choice(list(SIZES))
        parts.append(rng.choice(SIZES[size]))

    # Not for the arcade shapes. You finish those by clearing the board, and
    # asking one of them for eight coins asks for something it will not do.
    if not arcade and rng.random() < 0.45:
        n = rng.randint(3, 16)
        parts.append(f'{n} coins to collect')
        expect['collect'] = n

    rng.shuffle(parts[1:])
    text = rng.choice(OPENERS) + ', '.join(parts)
    return text[0].upper() + text[1:] + '.', expect


# ---- the browser side: generate, validate, and try to play ----
BUILD = r"""
(args) => {
  const prompts = args.prompts || args;
  const CHIP = args.chip || 'gameboy';
  const T = 8, TILES = window.NeoGame.TILES;

  // The same bot the picker uses to keep its previews alive. A game a bot
  // cannot move through is not a game, whatever the validator says.
  function drive(g, seconds) {
    const info = (tx, ty) => TILES[g.level.at(tx, ty)] || {};
    const steps = Math.round(seconds * 60);
    /* Furthest, not final. Dying puts the bot back where it started, so
       measuring where it ended up called a game it had played for ten
       seconds "0px into it" - which threw out one generated game in
       twenty-five for being unplayable after watching it be played. In a
       scroller the player is held in the frame and the world moves, so
       progress is whichever of the two actually travelled. */
    const x0 = g.player.x, y0 = g.player.y, vx0 = g.view.x, vy0 = g.view.y;
    let far = 0, landed = 0, lastPiece = null;
    const mark = () => {
      /* A well has nobody in it to move. Measuring how far the player got
         reads zero for every falling-block game ever generated, and threw
         every one of them out as unplayable - so there, progress is pieces
         that have come to rest. */
      if (g.mode === 'blocks') {
        if (g.piece && g.piece !== lastPiece) { if (lastPiece) landed++; lastPiece = g.piece; }
        far = Math.max(far, landed * T, g.lines * T * 3);
        return;
      }
      const d = Math.max(Math.abs(g.player.x - x0), Math.abs(g.player.y - y0),
                         Math.abs(g.view.x - vx0), Math.abs(g.view.y - vy0));
      if (d > far) far = d;
    };
    for (let i = 0; i < steps; i++) {
      if (g.state !== 'play') break;
      const p = g.player;
      if (g.mode === 'racer' || g.mode === 'shmup') {
        // The road that is coming, not the one you are in: the world arrives
        // from the top, so your own row is where you already are.
        const row = Math.max(0, Math.floor((p.y + p.h / 2) / T) - 3);
        const here = Math.floor((p.x + p.w / 2) / T);
        let L = here, R = here;
        while (L > 0 && info(L - 1, row).solid !== true && here - L < 12) L--;
        while (R < g.level.w - 1 && info(R + 1, row).solid !== true && R - here < 12) R++;
        const want = ((L + R) / 2) * T + T / 2;
        g.input.left = want < p.x + p.w / 2 - 3;
        g.input.right = want > p.x + p.w / 2 + 3;
      } else if (g.mode === 'blocks') {
        /* Drop into whichever column has the most room, which keeps the pile
           flat enough to clear a row now and then. Holding a direction and
           hoping builds a tower and stacks out in twenty seconds. */
        const pc = g.piece;
        if (pc) {
          let bestX = null, bestD = -1;
          for (let x = 1; x < g.level.w - 1; x++) {
            if (info(x, 1).solid === true) continue;
            let d = g.level.h;
            for (let y = 0; y < g.level.h; y++) if (g.level.at(x, y)) { d = y; break; }
            if (d > bestD) { bestD = d; bestX = x; }
          }
          g.input.left = bestX !== null && pc.x > bestX;
          g.input.right = bestX !== null && pc.x < bestX;
          g.input.down = bestX !== null && pc.x === bestX;
          g.input.a = (i % 97) === 0;
        }
      } else if (g.mode === 'scramble') {
        /* Down the middle of the corridor, read a little ahead of the nose:
           by the time rock is beside you it is too late to be anywhere else.
           The trigger simply stays down - in a cave everything worth
           shooting is in front of you. */
        const col = Math.min(g.level.w - 1, Math.floor((p.x + p.w + 10) / T));
        const here = Math.floor((p.y + p.h / 2) / T);
        let U = here, D = here;
        while (U > 0 && info(col, U - 1).solid !== true && here - U < 12) U--;
        while (D < g.level.h - 1 && info(col, D + 1).solid !== true && D - here < 12) D++;
        const want = ((U + D) / 2) * T + T / 2;
        g.input.up = want < p.y + p.h / 2 - 3;
        g.input.down = want > p.y + p.h / 2 + 3;
        g.input.b = true;
      } else if (g.mode === 'rider') {
        // Keep it level. The throttle looks after itself; the landing does not.
        g.input.up = p.pitch > 0.06;
        g.input.down = p.pitch < -0.06;
        g.input.a = p.grounded && (i % 45) === 0;
      } else if (g.mode === 'invaders') {
        // Get under the lowest one and fire. Holding a direction and hoping
        // is not playing this game, and it is the only mode where a bot that
        // does not shoot cannot get anywhere at all.
        const rank = g.entities.filter(e => e.alive && e.def.march);
        if (rank.length) {
          const low = rank.reduce((a, b) => (b.y > a.y ? b : a));
          const want = low.x + low.w / 2, me = p.x + p.w / 2;
          g.input.left = want < me - 2;
          g.input.right = want > me + 2;
          g.input.b = Math.abs(want - me) < 6;
        }
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
      mark();
    }
    return far;
  }

  /* Readability, judged after the palette has had its way.

     A level can validate, play, and still be unplayable: a magenta enemy on
     a purple wall is obvious in thirty-two colours and gone in four. So the
     frame is snapped to the hardware palette first, and only then is the
     cast measured against the ground it stands on. Draw it twice - once with
     everything, once with the level alone - and the pixels that differ are
     exactly the things a player needs to see. */
  function readability(spec, chip) {
    const cv = document.createElement('canvas'); cv.width = 160; cv.height = 144;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const g = window.NeoGame.create(cv, JSON.parse(JSON.stringify(spec)), { hud: false });
    g.tick(1.6);                                     // past the arrival blink

    /* One game, one moment, one camera. Pin the view first: building a second
       game without the cast re-runs the simulation and takes the camera with
       it, and then the two frames differ everywhere. */
    g.freeCam = true;
    const paint = () => {
      // A speech bubble hangs off whoever is speaking, so hiding the player
      // hides their bubble too - and a big bright box of dialogue swamps the
      // silhouette it was meant to measure. Judge the character, not the talk.
      g.bubbles.length = 0;
      g.draw();
      window.NeoPalette.snap(ctx, 160, 144, { chip, dither: 'bayer4', dithAmt: 0.6 });
      return ctx.getImageData(0, 0, 160, 144).data;
    };
    const lum = (d, i) => d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;

    /* Measured against whichever frame is missing the thing being judged, so
       the pixels that differ are that thing and nothing else. Contrast is the
       larger of the two directions: a dark shape on a light ground reads as
       well as the reverse. */
    const against = (other) => {
      let n = 0, mn = 255, mx = 0;
      const box = [999, 999, -1, -1];
      for (let i = 0, px = 0; i < full.length; i += 4, px++) {
        if (full[i] === other[i] && full[i + 1] === other[i + 1] && full[i + 2] === other[i + 2]) continue;
        const l = lum(full, i);
        n++; if (l < mn) mn = l; if (l > mx) mx = l;
        const x = px % 160, y = (px / 160) | 0;
        if (x < box[0]) box[0] = x; if (y < box[1]) box[1] = y;
        if (x > box[2]) box[2] = x; if (y > box[3]) box[3] = y;
      }
      if (n < 8) return { n, contrast: null };
      let bg = 0, bgN = 0;
      for (let y = Math.max(0, box[1] - 8); y < Math.min(144, box[3] + 8); y++) {
        for (let x = Math.max(0, box[0] - 8); x < Math.min(160, box[2] + 8); x++) {
          const i = (y * 160 + x) * 4;
          if (full[i] === other[i] && full[i + 1] === other[i + 1] && full[i + 2] === other[i + 2]) {
            bg += lum(other, i); bgN++;
          }
        }
      }
      const mean = bgN ? bg / bgN : 0;
      return { n, contrast: Math.round(Math.max(mx - mean, mean - mn)) };
    };

    const full = paint();

    /* What the player has to be able to pick out. Usually that is the body
       they are steering; in a falling-block game there is no body at all, and
       the thing they are steering is the piece - measuring the body there
       reads nothing and threw out every well as unreadable. */
    const py = g.player.y;
    const pc = g.piece;
    if (g.mode === 'blocks') { if (pc) pc.y = -99999; }
    else g.player.y = -99999;
    const noPlayer = paint();
    if (g.mode === 'blocks') { if (pc) pc.y = 0; }
    else g.player.y = py;

    const hidden = [];
    for (const e of g.entities) if (e.alive) { e.alive = false; hidden.push(e); }
    const noCast = paint();
    for (const e of hidden) e.alive = true;

    const seen = new Set();
    for (let i = 0; i < full.length; i += 4) seen.add(full[i] + ',' + full[i + 1] + ',' + full[i + 2]);

    /* A player who leaves almost no pixels behind is either off the screen -
       nothing to judge - or standing right there and indistinguishable from
       what is behind them, which is the worst score there is, not a missing
       one. Telling the two apart is the difference between a grader and a
       rubber stamp. */
    const sx = g.player.x + g.player.w / 2 - g.view.x;
    const sy = g.player.y + g.player.h / 2 - g.view.y;
    const onScreen = g.mode === 'blocks' ? !!g.piece
                   : (sx > -8 && sx < 168 && sy > -8 && sy < 152);

    const P = against(noPlayer), C = against(noCast);
    if (P.contrast === null) P.contrast = onScreen ? 0 : null;
    /* The binding constraint is the worst-reading thing on screen, not the
       average of everything. A level whose coins gleam while the player is
       invisible is not a readable level, and averaging says it is. */
    const both = [P.contrast, C.contrast].filter(v => v !== null);
    return {
      cast: P.n + C.n,
      playerContrast: P.contrast,
      castContrast: C.contrast,
      contrast: both.length ? Math.min(...both) : 0,
      shades: seen.size,
    };
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
        out.moved = Math.round(drive(g, 14));
        out.state = g.state;
        out.scored = g.score;
        out.lost = (spec.lives ?? 3) - g.lives;
        Object.assign(out, readability(spec, CHIP));
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


def real_prompts(path, page):
    """Sentences people wrote about their own Game Boy games, and what this
    generator makes of each one.

    A description is only usable as a prompt if the reader gets something out
    of it: told "a cosy game about a cat", the generator has heard the word
    cat and nothing else, and the level it builds is a level it would have
    built anyway. Pairing that with the sentence teaches a model that the
    words do not matter, which is worse than not training on it.

    So each one is read first, and only those that settle a mode or a place
    are kept - with what was understood carried along as the thing to check
    the built game against, exactly as for a prompt we wrote ourselves.
    """
    rows = []
    for line in Path(path).read_text(encoding='utf-8').splitlines():
        if not line.strip():
            continue
        d = json.loads(line)
        text = (d.get('short_text') or '').strip()
        # Long enough to be a description, short enough to be a request.
        if not (12 <= len(text) <= 180):
            continue
        rows.append(text)
    heard = page.evaluate("""(texts) => texts.map(t => {
      const w = NeoGameGen.read(t);
      return { mode: w.mode || null, theme: w.theme || null };
    })""", rows)
    out = []
    for text, w in zip(rows, heard):
        if not (w['mode'] or w['theme']):
            continue
        expect = {}
        if w['mode']:
            expect['mode'] = w['mode']
        if w['theme']:
            expect['theme'] = w['theme']
        out.append((text, expect))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--count', type=int, default=800)
    ap.add_argument('--out', default='data/games.jsonl')
    ap.add_argument('--genre-dir', default='data/by-genre')
    ap.add_argument('--rejects', default='data/rejects.jsonl')
    ap.add_argument('--batch', type=int, default=12)
    ap.add_argument('--seed', default='neojutsu')
    ap.add_argument('--real-prompts', default='',
                    help='a jsonl from tools/find_itch.py. A share of the corpus is '
                         'then built from sentences real people wrote about their own '
                         'games, rather than from our vocabulary')
    ap.add_argument('--real-share', type=float, default=0.25,
                    help='how much of the corpus those should be, at most')
    ap.add_argument('--min-moved', type=int, default=24,
                    help='pixels a bot must cover before a game counts as playable')
    ap.add_argument('--chip', default='gameboy',
                    help='palette the readability check judges against')
    ap.add_argument('--min-contrast', type=int, default=28,
                    help='how far the cast must stand out from the ground, after the palette snap')
    ap.add_argument('--min-shades', type=int, default=3,
                    help='distinct shades a frame must use; a level that snaps to two is flat')
    args = ap.parse_args()

    from playwright.sync_api import sync_playwright
    rng = random.Random(args.seed)
    kept, rejects = [], []
    seen = set()
    reasons = Counter()
    shapes = Counter()

    srv, port = serve()
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(headless=True)
            page = b.new_context(viewport={'width': 900, 'height': 700}).new_page()
            page.on('pageerror', lambda e: reasons.update(['page error: ' + str(e)[:40]]))
            page.goto(f'http://127.0.0.1:{port}/game.html')
            page.wait_for_function('!!(window.NeoGameGen && window.NeoSprites && window.NeoSprites.loaded)',
                                   timeout=30000)

            # A share of the prompts written by people rather than by us.
            real, real_left = [], 0
            if args.real_prompts:
                real = real_prompts(args.real_prompts, page)
                rng.shuffle(real)
                real_left = min(len(real), int(args.count * args.real_share))
                print(f'{len(real)} real descriptions the reader understands; '
                      f'using up to {real_left}', file=sys.stderr)

            def next_prompt(r):
                nonlocal real_left
                if real_left > 0 and real and r.random() < args.real_share:
                    real_left -= 1
                    return real[real_left % len(real)]
                return make_prompt(r)

            guard = 0
            while len(kept) < args.count and guard < args.count * 6:
                batch = [next_prompt(rng) for _ in range(args.batch)]
                guard += len(batch)
                results = page.evaluate(BUILD, {'prompts': [pr for pr, _ in batch], 'chip': args.chip})
                for (prompt, expect), r in zip(batch, results):
                    why = None
                    spec = r.get('spec')
                    if r.get('error'):
                        why = 'threw: ' + r['error'][:40]
                    elif not r.get('ok'):
                        why = 'invalid: ' + (r.get('errors') or ['?'])[0][:50]
                    elif spec.get('mode') != expect['mode']:
                        why = f"asked for {expect['mode']}, got {spec.get('mode')}"
                    elif 'collect' in expect and collect_of(spec) != expect['collect']:
                        why = 'collect count not honoured'
                    elif 'theme' in expect and r['understood'].get('theme') != expect['theme']:
                        why = 'theme not understood'
                    elif r.get('moved', 0) < args.min_moved:
                        why = f"a bot got {r.get('moved', 0)}px into it"
                    elif r.get('cast', 0) < 12 and spec.get('mode') != 'blocks':
                        why = 'nothing of the cast is on screen'
                    elif spec.get('mode') == 'blocks' and r.get('cast', 0) < 4:
                        # a well has no cast; what has to be visible is the piece
                        why = 'the falling piece cannot be seen'
                    elif r.get('contrast', 0) < args.min_contrast:
                        why = f"cast reads at {r.get('contrast', 0)} against the ground"
                    elif r.get('shades', 0) < args.min_shades:
                        why = f"the frame snaps to {r.get('shades', 0)} shade(s)"
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
                        # Which layout it came out as. Two modes have two
                        # shapes each and the tilemap does not say which, so
                        # without this there is no way to tell a corpus that
                        # covers both from one that only ever built the first.
                        sh = (r.get('understood') or {}).get('shape')
                        if sh: shapes.update([f"{spec.get('mode')}:{sh}"])
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
        'by_shape': dict(sorted(shapes.items())),
        'top_rejections': dict(reasons.most_common(6)),
    }, indent=2))


if __name__ == '__main__':
    main()
