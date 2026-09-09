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
tools/train_lora.py      QLoRA fine-tune, one 24GB card             -> runs/
tools/eval_model.py      generate -> validate -> play -> score      -> data/eval.json
```

Everything is graded the same way at every stage: a game must validate, and a
bot must be able to get somewhere in it. Data that cannot clear that bar does
not go in, and a model that cannot clear it has not improved.

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

**Worth nothing, or worse**

- **ROMs and binaries.** A model cannot learn this JSON format from a Game
  Boy ROM. Extracting tilemaps from one is a data-engineering project in its
  own right, and the output is somebody else's level design.
- **Screenshots and video.** Same problem, more of it.
- **Other people's levels, redrawn.** Fine for you at home, a licensing
  problem the day it ships. Original layouts and CC0 sources stay clean.

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
```

Train. Sized for a 24GB card: 4-bit base, LoRA adapters, gradient
checkpointing. A few thousand examples is a couple of hours, not a cluster.

```bash
pip install "transformers>=4.44" peft trl bitsandbytes accelerate datasets
python3 tools/train_lora.py --data data/games.jsonl --extra data/imported.jsonl \
                            --out runs/neojutsu-v1
```

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
