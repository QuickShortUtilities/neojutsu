#!/usr/bin/env python3
"""Score a trained model on the only thing that matters: does it write games
that run.

Every generation is put through the studio's validator and then played by a
bot in a real browser, which is the same bar the training data had to clear.
Results are broken down by genre, because a model that is fine at platformers
and hopeless at racers has an average that tells you nothing.

    python3 tools/eval_model.py --adapter runs/neojutsu-v1 --count 60
    python3 tools/eval_model.py --jsonl generations.jsonl        # judge a file
"""
import argparse, json, random, sys, threading, functools, http.server, socketserver
from pathlib import Path
from collections import Counter, defaultdict

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_dataset import BUILD, SYSTEM, serve, make_prompt  # noqa: E402


def generate(args, prompts):
    import torch
    from transformers import AutoTokenizer, AutoModelForCausalLM
    from peft import PeftModel
    base = args.model
    tok = AutoTokenizer.from_pretrained(args.adapter or base)
    model = AutoModelForCausalLM.from_pretrained(base, torch_dtype=torch.bfloat16, device_map='auto')
    if args.adapter:
        model = PeftModel.from_pretrained(model, args.adapter)
    model.eval()
    outs = []
    for i, prompt in enumerate(prompts, 1):
        msgs = [{'role': 'system', 'content': SYSTEM}, {'role': 'user', 'content': prompt}]
        ids = tok.apply_chat_template(msgs, add_generation_prompt=True, return_tensors='pt').to(model.device)
        with torch.no_grad():
            gen = model.generate(ids, max_new_tokens=args.max_new, do_sample=True,
                                 temperature=args.temperature, top_p=0.9,
                                 pad_token_id=tok.pad_token_id or tok.eos_token_id)
        text = tok.decode(gen[0][ids.shape[-1]:], skip_special_tokens=True).strip()
        outs.append({'prompt': prompt, 'text': text})
        print(f'\rgenerated {i}/{len(prompts)}', end='', file=sys.stderr)
    print(file=sys.stderr)
    return outs


def as_spec(text):
    """Models like to wrap JSON in prose or fences. Take the object."""
    t = text.strip()
    if t.startswith('```'):
        t = t.split('```')[1]
        if t.startswith('json'):
            t = t[4:]
    a, b = t.find('{'), t.rfind('}')
    if a < 0 or b <= a:
        return None
    try:
        return json.loads(t[a:b + 1])
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--adapter', default=None)
    ap.add_argument('--model', default='google/gemma-2-2b-it')
    ap.add_argument('--jsonl', default=None, help='judge generations already on disk')
    ap.add_argument('--count', type=int, default=60)
    ap.add_argument('--seed', default='eval')
    ap.add_argument('--temperature', type=float, default=0.8)
    ap.add_argument('--max-new', type=int, default=3072)
    ap.add_argument('--min-moved', type=int, default=24)
    ap.add_argument('--report', default='data/eval.json')
    args = ap.parse_args()

    rng = random.Random(args.seed)
    if args.jsonl:
        rows = [json.loads(l) for l in Path(args.jsonl).read_text(encoding='utf-8').splitlines() if l.strip()]
        gens = [{'prompt': r.get('prompt', ''), 'text': r.get('text', '')} for r in rows]
        wanted = [{} for _ in gens]
    else:
        pairs = [make_prompt(rng) for _ in range(args.count)]
        wanted = [w for _, w in pairs]
        gens = generate(args, [p for p, _ in pairs])

    parsed = [as_spec(g['text']) for g in gens]

    from playwright.sync_api import sync_playwright
    srv, port = serve()
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(headless=True)
            page = b.new_context(viewport={'width': 900, 'height': 700}).new_page()
            page.goto(f'http://127.0.0.1:{port}/game.html')
            page.wait_for_function('!!(window.NeoGame && window.NeoSprites && window.NeoSprites.loaded)',
                                   timeout=30000)
            CHECK = BUILD.replace('window.NeoGameGen.generateValid(prompt)',
                                  '{ spec: prompt, understood: {} }')
            verdicts = []
            for i in range(0, len(parsed), 8):
                chunk = [s if s else {} for s in parsed[i:i + 8]]
                verdicts += page.evaluate(CHECK, {'prompts': chunk})
            b.close()
    finally:
        srv.shutdown()

    by = defaultdict(lambda: Counter())
    fails = Counter()
    total = Counter()
    for spec, v, want in zip(parsed, verdicts, wanted):
        mode = (spec or {}).get('mode', 'unparsed')
        total['n'] += 1
        by[mode]['n'] += 1
        if spec is None:
            fails['not JSON'] += 1; continue
        by[mode]['json'] += 1; total['json'] += 1
        if not v.get('ok'):
            fails[(v.get('errors') or ['invalid'])[0][:44]] += 1; continue
        by[mode]['valid'] += 1; total['valid'] += 1
        if v.get('moved', 0) < args.min_moved:
            fails['unplayable'] += 1; continue
        by[mode]['playable'] += 1; total['playable'] += 1
        if want.get('mode') and spec.get('mode') != want['mode']:
            fails['wrong genre'] += 1; continue
        by[mode]['on_brief'] += 1; total['on_brief'] += 1

    n = max(1, total['n'])
    report = {
        'n': total['n'],
        'json': round(total['json'] / n, 3),
        'valid': round(total['valid'] / n, 3),
        'playable': round(total['playable'] / n, 3),
        'on_brief': round(total['on_brief'] / n, 3),
        'by_genre': {k: dict(v) for k, v in sorted(by.items())},
        'top_failures': dict(fails.most_common(8)),
    }
    Path(ROOT / args.report).parent.mkdir(parents=True, exist_ok=True)
    Path(ROOT / args.report).write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
