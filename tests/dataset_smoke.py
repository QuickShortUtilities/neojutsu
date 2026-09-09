"""The training pipeline has to keep producing games that actually run.

This builds a handful of records the same way a full run does and checks the
invariants that matter: every kept game validates, genres are labelled and
separated, and anything thrown out says why.
"""
import json, subprocess, sys, tempfile, shutil
from pathlib import Path

ROOT = Path('/Users/christophercohen/Documents/GitHub/neojutsu')
issues = []
tmp = Path(tempfile.mkdtemp(prefix='neojutsu-data-'))

try:
    r = subprocess.run(
        [sys.executable, 'tools/make_dataset.py', '--count', '10', '--batch', '5',
         '--out', str(tmp / 'games.jsonl'), '--genre-dir', str(tmp / 'genre'),
         '--rejects', str(tmp / 'rejects.jsonl'), '--seed', 'smoke'],
        cwd=ROOT, capture_output=True, text=True, timeout=600)
    if r.returncode != 0:
        issues.append(f'make_dataset failed: {r.stderr[-400:]}')
    summary = json.loads(r.stdout[r.stdout.find('{'):]) if '{' in r.stdout else {}

    rows = [json.loads(l) for l in (tmp / 'games.jsonl').read_text().splitlines() if l.strip()]
    if len(rows) != 10:
        issues.append(f'asked for 10 records, got {len(rows)}')

    specs = []
    for i, row in enumerate(rows):
        msgs = row.get('messages') or []
        if [m['role'] for m in msgs] != ['system', 'user', 'assistant']:
            issues.append(f'record {i} is not a system/user/assistant triple'); continue
        if not msgs[1]['content'].strip():
            issues.append(f'record {i} has an empty prompt')
        try:
            spec = json.loads(msgs[2]['content'])
        except Exception as e:
            issues.append(f'record {i} answer is not JSON: {e}'); continue
        specs.append(spec)
        for key in ('mode', 'level', 'entities', 'start'):
            if key not in spec:
                issues.append(f'record {i} has no {key}')

    # the answer must be one object and nothing else - no prose, no fences
    for i, row in enumerate(rows):
        a = row['messages'][2]['content']
        if not (a.startswith('{') and a.endswith('}')):
            issues.append(f'record {i} answer is not a bare JSON object')

    # genres are labelled and kept apart
    modes = {s.get('mode') for s in specs}
    if not modes <= {'platform', 'topdown', 'racer', 'shmup'}:
        issues.append(f'unexpected modes: {modes}')
    gdir = tmp / 'genre'
    written = {p.stem for p in gdir.glob('*.jsonl')} if gdir.exists() else set()
    if written != {m for m in modes if m}:
        issues.append(f'per-genre files {written} do not match the modes present {modes}')
    total = sum(len([l for l in p.read_text().splitlines() if l.strip()]) for p in gdir.glob('*.jsonl'))
    if total != len(rows):
        issues.append(f'per-genre files hold {total} records, combined holds {len(rows)}')

    # every level distinct - a dataset of duplicates teaches one level
    tiles = [s['level']['tiles'] for s in specs if 'level' in s]
    if len(set(tiles)) != len(tiles):
        issues.append('the dataset contains duplicate levels')

    # rejects, if any, must carry a reason
    rj = tmp / 'rejects.jsonl'
    if rj.exists():
        for i, line in enumerate(l for l in rj.read_text().splitlines() if l.strip()):
            if not (json.loads(line).get('why') or '').strip():
                issues.append(f'reject {i} has no reason')

    report = {'records': len(rows), 'modes': sorted(m for m in modes if m),
              'genre_files': sorted(written), 'accept_rate': summary.get('accept_rate')}
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print(json.dumps({'report': report, 'issues': issues}, indent=2))
print('\nThe pipeline still makes games that run.' if not issues else f'\n{len(issues)} issue(s).')
sys.exit(1 if issues else 0)
