# data

Generated, not authored. Nothing in here is in git except this file.

```bash
python3 tools/make_dataset.py --count 3000        # games.jsonl + by-genre/ + rejects.jsonl
python3 tools/import_games.py --in ~/my-levels    # imported.jsonl
```

| file | what it is |
|---|---|
| `games.jsonl` | prompt → game pairs, chat format, every one validated and played |
| `by-genre/*.jsonl` | the same records split by mode, for training or judging one genre alone |
| `rejects.jsonl` | what was thrown out and why — read this, it is a list of blind spots |
| `imported.jsonl` | your own games, put through the same grader |
| `eval.json` | the last scorecard from `tools/eval_model.py` |

Runs are seeded, so `--seed` reproduces a dataset exactly.

See [`docs/training.md`](../docs/training.md) for what is worth collecting.
