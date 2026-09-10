# Training a model to write games

The studio can already write games from a description. That generator is
hand-written rules, and rules run out: they make what they were told to make.
A model is the way past that — but only if it is trained on games that run,
and judged on games that run.

This is the pipeline, what it needs from you, and what it does not.

## The short version

```
tools/make_dataset.py    prompts -> games, graded by playing them   -> data/
tools/import_games.py    your games -> the same JSONL               -> data/
tools/import_gbstudio.py published GB Studio projects -> levels + scripts
tools/find_sources.py    GitHub -> GB Studio projects worth fetching
tools/find_itch.py       itch.io jams and tags -> sources, and descriptions
tools/fetch_sources.py   those -> ~/neojutsu-sources
tools/import_zzt.py      ZZT worlds -> overhead levels              -> data/study/
tools/import_vglc.py     the Video Game Level Corpus -> levels       -> data/study/
tools/import_puzzlescript.py  PuzzleScript games -> rooms           -> data/study/
tools/vocab_gap.py       real descriptions -> the words we ignore
tools/train_lora.py      QLoRA fine-tune, one 24GB card             -> runs/
tools/eval_model.py      generate -> validate -> play -> score      -> data/eval.json
```

Everything under `data/study/` is deliberately outside the training command
below. See **Where the levels come from** for why.

## Where the raw archives live

The tools download other people's archives, and those are not in this
repository - `data/` is ignored, on purpose, because the generated corpus is
rebuilt from a seed in minutes. That reasoning does not extend to a gigabyte
of downloaded worlds, which is not regenerable if a source goes offline, so
they have a home of their own:

```
~/neojutsu-sources    GB Studio projects, one folder each   (fetch_sources.py)
~/neojutsu-corpus/zzt        the Museum of ZZT mass downloads
~/neojutsu-corpus/vglc       TheVGLC, as its repository zip
~/neojutsu-corpus/puzzlescript   the demo games
```

Neither folder is backed up by anything here. If these matter, back them up:
every tool can fetch again today, and no tool can fetch a page that has been
taken down.

Everything is graded the same way at every stage: a game must validate, and a
bot must be able to get somewhere in it. Data that cannot clear that bar does
not go in, and a model that cannot clear it has not improved.

## Two tasks, one format

Every record is the same chat triple, and the system line says which job it
is: *"You write NeoJutsu games"* for a level, *"You write NeoJutsu game
scripts"* for a script. So they train together in one run and the model
learns both, rather than needing two adapters. Mix them; the system prompt
keeps them apart.

## Genres are kept apart

A racing level and a dungeon are not the same thing in different colours, and
a dataset that mixes them teaches exactly that. `make_dataset.py` writes
`data/games.jsonl` **and** `data/by-genre/<mode>.jsonl`. Train on the pile
when you want breadth; train on one file when one genre is going wrong.
`eval_model.py` reports per genre for the same reason — a model that is fine
at platformers and hopeless at racers has an average that says nothing.

## What to collect, and what not to

You offered to gather a pile of games. Some of that is worth a great deal and
some of it is worth nothing, so:

**Worth a lot**

- **Levels, as layouts.** Anything you can express as rows of tiles. The
  format is deliberately plain text: `import_games.py` reads a `.txt` of
  base-36 digits with an optional header. A hundred hand-made levels with
  real pacing is worth more than ten thousand generated ones, because the
  generator can already make ten thousand and cannot make taste.
- **Games the generator got wrong, fixed by hand.** Take a line out of
  `data/rejects.jsonl`, repair the level, save it. That is the highest-value
  data there is: it targets exactly what the model is bad at.
- **Descriptions in your own words.** The pairing is what is being learned.
  The same level with five different descriptions is five examples.
- **Prompts that produced nothing good.** Even without a fixed game, the
  prompt tells you where the vocabulary is thin.

- **The jams, through itch.io.** `find_sources.py` searches GitHub, which
  finds a repository only if somebody tagged it - and a jam entry is usually
  called `my-jam-game` with no topic on it at all. `find_itch.py` goes the
  other way round: the jam's own entry list, then each game's page, then the
  source link the author put there. GBCompo and GBJAM together with the
  `gbstudio` tag come to well over a thousand games. The hit rate is honest
  rather than thrilling - roughly one in ten entries links source, and a
  fraction of those are GB Studio - but they are games nothing else finds.

  It reads repositories with a blobless clone rather than the GitHub API.
  Unauthenticated the API allows sixty calls an hour, which is four hours of
  waiting to check a hundred repositories; `git clone --filter=blob:none`
  fetches the file listing without the files, in under a second, with no
  quota at all.

- **Published GB Studio projects.** The one source of real, hand-made Game
  Boy levels in a format a script can read. `import_gbstudio.py` takes a
  folder of them and writes both halves: the scenes become levels, and the
  event graphs become scripts in our language. Thirty-four projects gave 788
  levels and 1,439 scripts. Two things to know before trusting the output.
  The old single-file format stores its collision layer two ways and reading
  the wrong one produces a tidy stripe that looks like a level; `tests/
  import_gbstudio_smoke.py` exists because forty per cent of the corpus was
  once that. And a scene with no collision layer at all is a title card, not
  an empty level, which is most of what the reject list holds.

- **How people describe their own games.** The same crawl keeps every
  description it passes, which is the half of the pairing we cannot invent.
  Every prompt in the generated corpus came out of a vocabulary we wrote, so
  the generator has only ever been asked for things it already had words for -
  a closed loop that cannot tell us what a stranger would type.

  `vocab_gap.py` closes it a little. It runs those descriptions past
  `NeoGameGen.read()` and reports the words that come up often and change
  nothing. The first run read 1,230 real descriptions, found 308 words worth
  considering, and understood 40 of them. **space** appeared 178 times and
  meant nothing at all - the studio had a sci-fi shelf and no sky to put a
  game under - and horror, spooky and creepy tag close to three hundred games
  between them with nothing dark to offer any of them. Two themes, a handful
  of words for exploring and escaping, and `puzzle`, `rpg` and `monster`
  later, it understands 70. The rest are mostly about art, music or a story,
  which this engine has nothing to say about.

**Worth nothing, or worse**

- **ROMs and binaries.** A model cannot learn this JSON format from a Game
  Boy ROM. Extracting tilemaps from one is a data-engineering project in its
  own right, and the output is somebody else's level design. A GB Studio
  project is the same games with the design still legible, which is why that
  importer exists and a ROM reader does not.
- **Screenshots and video.** Same problem, more of it.
- **Other people's levels, redrawn.** Fine for you at home, a licensing
  problem the day it ships. Original layouts and CC0 sources stay clean.

## Eight kinds of game, not one with eight skins

For a long while every mode here was the same game: a body moving through a
tilemap, collecting things, reaching a flag. Gravity on or off, scrolling or
not, shooting up or sideways - the tilemaps differed and the game did not.

What makes a genre is how it ends and what a frame is, so those are what
vary now:

| mode | a frame is | you finish by |
|---|---|---|
| `platform` | a body under gravity | reaching the flag |
| `topdown` | a body on a floor | the flag, or clearing the dots, or beating the rivals |
| `racer` | the world coming at you | arriving at the far end |
| `shmup` | the world coming down at you, with a gun | arriving at the far end |
| `scramble` | the world coming at you sideways, with a gun | arriving at the far end |
| `invaders` | a formation coming down at you | clearing it |
| `rider` | a bike with the throttle on | reaching the finish, having landed level |
| `blocks` | a piece falling into a well | clearing enough rows |

The endings are `collect`, `clearAll`, `clearFoes`, `lines` and `beat`, plus
walking into a goal. A new genre almost always means a new ending; if it does
not, it is probably a skin. `scramble` is the one that is not - it shares an
ending with `shmup` and earns its place on the frame alone, because a
corridor closing in front of you is not a thing coming down at you however
you paint it.

Watch the vocabulary as well as the genre. A genre phrase that names a place
has already chosen the setting: "a cave flyer" is a cave, and appending "in a
factory" asks for two things at once. The generator settles that by which word
comes first, which is the genre phrase every time, so the harness threw away
every one of those as a theme it did not understand - 114 rejections out of
180, all from one clause. `make_dataset.py` keeps a list of the words that
name a place for exactly this, and leaves the setting alone when the genre has
already said one.

## What the generated half covers

Prompts are built from a vocabulary, so what the vocabulary cannot say is not
in the corpus however many games you generate. It asks for all eight genres,
eight places, seven mechanics, five abilities including a tank's turret, a
boss, a clock, two players, a run of several rooms, a hero, a number of
lives, five level shapes and a pickup count - and it is worth checking that
list against what the generator can build whenever the generator learns
something new. A feature nothing asks for is a feature the model never sees:
the tank existed for a day with no prompt in the corpus mentioning one.

Games you finish by clearing the board take none of the clauses that assume a
count or a flag. Asking a maze chase for eight coins asks for something it
will not do.

Watch for prompts that quietly change the genre behind their own back. "driving
armour" reads as a racing game because of *driv*, and "three rooms" reads as an
overhead one because of *room* - both ask for something the generator will not
agree to, which is worse than not asking, and both show up in `rejects.jsonl`
as "asked for X, got Y".

## Where the levels come from, and which you can ship

Three of the importers write to `data/study/` rather than `data/`, and the
training command below does not read that folder. The distinction is not
about quality - it is the opposite, `study/` holds the best-designed levels
here - it is about whose they are.

| source | what it is | licence |
|---|---|---|
| `data/games.jsonl` | our own generator, graded | ours |
| `data/gbs-src.jsonl` | published GB Studio projects | each one checked; permissive or copyleft |
| `data/imported.jsonl` | levels you wrote | yours |
| `data/study/zzt.jsonl` | ZZT worlds, 1991 onwards | none stated by anybody |
| `data/study/vglc.jsonl` | Super Mario Bros, Kid Icarus, Lode Runner and the rest | Nintendo's, Capcom's, Broderbund's |
| `data/study/puzzlescript.jsonl` | PuzzleScript demo games | the repository's, MIT |

The Museum of ZZT preserves more than four thousand community worlds and
states no licence for any of them. The VGLC is published for research, which
is a well-worn path, and transcribing a commercial game's levels does not
make them yours. Training on either at home is one question; shipping a model
to the public that learned from them is a different question with a different
answer, and it is a decision for a person to take on purpose rather than a
default to inherit by putting a folder on a command line.

What they are unarguably good for is measuring. These are levels that
professionals and obsessives made and that millions of people played, and
comparing what the generator produces against them says something no amount
of self-play can.

## The flywheel

The rare part of this setup is not the data, it is the grader. Generating a
level is cheap; knowing whether it is any good is the expensive bit, and the
studio can do it in a browser in milliseconds: `validate()` for structure,
then a bot that plays for fourteen seconds.

So the loop is:

1. Generate far more candidates than you need.
2. Keep only the ones that validate and play.
3. Train.
4. Evaluate on held-out prompts with the same grader.
5. Feed the failures back as the next thing to fix by hand.

Rejects are written to `data/rejects.jsonl` with the reason. Read it. It is a
list of the generator's blind spots, and later, the model's.

## Running it

Build data — the studio's generator drives this, in a real browser, so there
is one definition of what a game is:

```bash
python3 tools/make_dataset.py --count 3000
python3 tools/import_games.py --in ~/my-levels --out data/imported.jsonl
python3 tools/import_gbstudio.py --in ~/neojutsu-sources \
        --out data/gbs-src.jsonl --scripts data/gbs-src-scripts.jsonl
```

Train. Sized for a 24GB card: 4-bit base, LoRA adapters, gradient
checkpointing. A few thousand examples is a couple of hours, not a cluster.

```bash
pip install "transformers>=4.44" peft trl bitsandbytes accelerate datasets
python3 tools/train_lora.py --data data/games.jsonl \
        --extra data/gbs-src.jsonl data/gbs-src-scripts.jsonl data/imported.jsonl \
        --out runs/neojutsu-v1
```

That is roughly 4,600 examples: 3,000 generated levels, 810 imported ones and
824 scripts. The generated 3,000 come out as all eight genres and all five
endings - a little over 300 of each kind, the rest overhead - in 623 different
level sizes, from 2,983 different descriptions, at a 97.6% accept rate. What
is left over is worth reading: all but three of the 74 rejections are a bot
failing to get anywhere in a level, which is the honest kind. The generated
half teaches the shape; the imported half is the only part with anyone's
taste in it.

Genre is not the whole of the variety, and the summary says so. `by_shape`
counts the builder each game actually came out of - nineteen of them across
the eight modes, six ways to lay out a platformer and five a dungeon, two
each for a road and a climb. It reports what ran rather than what the words
asked for, which matters more than it sounds: a road that splits was
reaching the corpus a third as often as it was chosen, because its first
island sat under a second from the start line and the pre-flight check
retired anything that killed a car which had not moved yet. Nothing in the
tilemap says which builder made it, so without this the corpus could quietly
have been one shape per mode again and looked exactly the same.

They are not all one size. A single room is around a thousand tokens and a run
of eight rooms is closer to eight thousand, so `--maxlen` defaults to 8192 and
`train_lora.py` counts the corpus before it starts. It will not train on a
game it would have to cut in half: a JSON object with the end sliced off is
not a shorter lesson, it is a wrong one. Pass `--drop-long` to leave the
handful that still overflow out of the run.

The script count went *down* when the corpus got better: 616 of the 1,439 were
exact repeats, because a published game uses the same script for the same door
in twelve rooms. One copy of each is worth more than twelve of one.

Judge it:

```bash
python3 tools/eval_model.py --adapter runs/neojutsu-v1 --count 100
```

Four numbers come back, and they are a ladder — each one is harder than the
last:

| | |
|---|---|
| `json` | it emitted a parseable object at all |
| `valid` | the engine accepts it |
| `playable` | a bot can get somewhere in it |
| `on_brief` | it is the genre that was asked for |

`json` near 1.0 comes quickly. `playable` is the one that takes work.

## Choosing a base model

Gemma 2 2B fits comfortably and is enough to learn a fixed JSON shape. Move
up to 9B when `on_brief` stalls rather than when `valid` does — structure is a
small-model problem, understanding a request is not.

The output is JSON with a known schema, so constrained decoding is worth more
than a bigger model: a grammar that cannot emit an invalid tile character
removes a whole class of failure before it starts.

## Where the ceiling is

This trains a model to write *this* engine's games. That is on purpose: the
spec is small, verifiable and playable, which is what makes the grader
possible. A model that writes a game engine as well as a game is a different
project and a much larger one.
