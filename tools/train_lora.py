#!/usr/bin/env python3
"""Fine-tune a small model to write NeoJutsu games, on one consumer GPU.

Sized for a 24GB card: 4-bit base weights, LoRA adapters, gradient
checkpointing. Nothing here needs a cluster.

    pip install "transformers>=4.44" peft trl bitsandbytes accelerate datasets
    python3 tools/train_lora.py --data data/games.jsonl --out runs/neojutsu-v1

Train one genre on its own when a genre is going wrong - the per-genre files
exist for exactly that:

    python3 tools/train_lora.py --data data/by-genre/racer.jsonl --out runs/racer

The target is JSON, not prose, so the loss is taken on the answer only. A
model that learns to echo the question back has learned nothing.
"""
import argparse, json, os
from pathlib import Path

DEFAULT_MODEL = os.environ.get('NEOJUTSU_BASE', 'google/gemma-2-2b-it')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default='data/games.jsonl')
    ap.add_argument('--extra', nargs='*', default=[],
                    help='more jsonl files to mix in, e.g. data/imported.jsonl')
    ap.add_argument('--out', default='runs/neojutsu-v1')
    ap.add_argument('--model', default=DEFAULT_MODEL)
    ap.add_argument('--epochs', type=float, default=3.0)
    ap.add_argument('--batch', type=int, default=1)
    ap.add_argument('--accum', type=int, default=16)
    ap.add_argument('--lr', type=float, default=1e-4)
    ap.add_argument('--rank', type=int, default=32)
    # The corpus is not all one size. A single room is a thousand tokens and
    # a run of eight is closer to eight thousand, so a window that fits the
    # median throws away the games that are hardest to write - which are the
    # ones worth training on.
    ap.add_argument('--maxlen', type=int, default=8192)
    ap.add_argument('--eval-frac', type=float, default=0.03)
    ap.add_argument('--drop-long', action='store_true',
                    help='leave out examples that will not fit in --maxlen, '
                         'rather than training on them cut in half')
    args = ap.parse_args()

    import torch
    from datasets import Dataset
    from transformers import AutoTokenizer, AutoModelForCausalLM, BitsAndBytesConfig
    from peft import LoraConfig
    from trl import SFTTrainer, SFTConfig

    rows = []
    for path in [args.data, *args.extra]:
        p = Path(path)
        if not p.exists():
            raise SystemExit(f'no such file: {p}')
        with p.open(encoding='utf-8') as f:
            rows += [json.loads(line) for line in f if line.strip()]
    if not rows:
        raise SystemExit('no training rows')
    print(f'{len(rows)} examples from {1 + len(args.extra)} file(s)')

    tok = AutoTokenizer.from_pretrained(args.model)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    # How long these actually are. The trainer cuts anything over
    # --maxlen and says nothing, and a game cut off mid-JSON is not a
    # shorter lesson, it is a wrong one: the model is shown an object that
    # never closes and learns that objects sometimes do not.
    def token_len(row):
        try:
            return len(tok.apply_chat_template(row['messages'], tokenize=True))
        except Exception:
            return len(tok(json.dumps(row['messages']))['input_ids'])

    lens = [token_len(r) for r in rows]
    ranked = sorted(lens)
    over = [i for i, n in enumerate(lens) if n > args.maxlen]
    print(f'tokens: median {ranked[len(ranked) // 2]}, '
          f'p95 {ranked[int(len(ranked) * 0.95)]}, max {ranked[-1]}')
    if over:
        print(f'{len(over)} of {len(rows)} examples are longer than --maxlen '
              f'{args.maxlen} and would be cut off part way through the game.')
        if args.drop_long:
            rows = [r for i, r in enumerate(rows) if i not in set(over)]
            print(f'dropped them; {len(rows)} left')
        else:
            raise SystemExit(f'raise --maxlen to {ranked[-1] + 64}, or pass '
                             f'--drop-long to leave those examples out')

    ds = Dataset.from_list(rows).shuffle(seed=7)
    cut = max(1, int(len(ds) * args.eval_frac))
    train_ds, eval_ds = ds.select(range(cut, len(ds))), ds.select(range(cut))

    quant = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type='nf4',
        bnb_4bit_use_double_quant=True,
        bnb_4bit_compute_dtype=torch.bfloat16,
    )
    model = AutoModelForCausalLM.from_pretrained(
        args.model, quantization_config=quant, torch_dtype=torch.bfloat16, device_map='auto')
    model.config.use_cache = False

    peft = LoraConfig(
        r=args.rank, lora_alpha=args.rank * 2, lora_dropout=0.05, bias='none',
        task_type='CAUSAL_LM',
        target_modules=['q_proj', 'k_proj', 'v_proj', 'o_proj',
                        'gate_proj', 'up_proj', 'down_proj'],
    )

    cfg = SFTConfig(
        output_dir=args.out,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch,
        gradient_accumulation_steps=args.accum,
        learning_rate=args.lr,
        lr_scheduler_type='cosine',
        warmup_ratio=0.03,
        logging_steps=10,
        save_strategy='epoch',
        eval_strategy='epoch',
        bf16=True,
        gradient_checkpointing=True,
        max_seq_length=args.maxlen,
        packing=False,                      # one game per example; do not splice them
        report_to=[],
        # Loss on the written game only, never on the request.
        assistant_only_loss=True,
    )

    trainer = SFTTrainer(model=model, args=cfg, train_dataset=train_ds,
                         eval_dataset=eval_ds, peft_config=peft, processing_class=tok)
    trainer.train()
    trainer.save_model(args.out)
    tok.save_pretrained(args.out)
    print(f'adapter written to {args.out}')
    print('now check it actually writes games:')
    print(f'  python3 tools/eval_model.py --adapter {args.out}')


if __name__ == '__main__':
    main()
