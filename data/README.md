# data

Generated, not authored. Nothing in here is in git except this file.

```bash
python3 tools/make_dataset.py --count 3000        # games.jsonl + by-genre/ + rejects.jsonl
python3 tools/import_games.py --in ~/my-levels    # imported.jsonl
python3 tools/import_gbstudio.py --in ~/neojutsu-sources \
        --out gbs-src.jsonl --scripts gbs-src-scripts.jsonl
```

| file | what it is |
|---|---|
| `games.jsonl` | prompt → game pairs, chat format, every one validated and played |
| `by-genre/*.jsonl` | the same records split by mode, for training or judging one genre alone |
| `rejects.jsonl` | what was thrown out and why — read this, it is a list of blind spots |
| `gbs-src.jsonl` | levels read out of published GB Studio projects |
| `gbs-src-scripts.jsonl` | their event graphs, translated into our script language |
| `gbs-src-rejects.jsonl` | scenes that were not levels — mostly title cards and menus |
| `imported.jsonl` | your own games, put through the same grader |
| `eval.json` | the last scorecard from `tools/eval_model.py` |

Levels and scripts are the same chat format; the system line says which job a
record is, so one training run learns both.

Runs are seeded, so `--seed` reproduces a dataset exactly.

See [`docs/training.md`](../docs/training.md) for what is worth collecting.
