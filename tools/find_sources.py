#!/usr/bin/env python3
"""Go looking for GB Studio projects worth importing.

Searches GitHub, then checks each candidate for the things that actually
matter: a project file, a licence that allows reuse, and scripts inside it
rather than only art. Prints the ones that pass in the shape
fetch_sources.py wants, so a new find is a copy and paste.

    python3 tools/find_sources.py
    python3 tools/find_sources.py --queries "topic:gb-studio" --min-scripts 5

No token needed; unauthenticated search is rate limited to a handful of
requests a minute, which is why it pauses between them.
"""
import argparse, json, subprocess, sys, time

API = 'https://api.github.com'
OK_LICENCES = {'MIT', 'Apache-2.0', 'BSD-3-Clause', 'BSD-2-Clause', 'CC0-1.0',
               'Unlicense', 'MPL-2.0', 'GPL-3.0', 'GPL-2.0', 'AGPL-3.0', 'CC-BY-4.0'}

QUERIES = [
    'topic:gb-studio',
    'topic:gbstudio',
    '"gb studio" game in:name,description,readme',
    'gbstudio jam',
    'gbsproj in:readme',
    'gameboy topic:homebrew',
]

# Words that suggest a game rebuilds somebody else's, which is a different
# question from what the repository's own licence covers.
RECREATION = ('zelda', 'mario', 'pokemon', 'pokémon', 'metroid', 'kirby', 'sonic',
              'castlevania', 'demake', 'de-make', 'remake', 'recreation', 'clone',
              'link\'s awakening', 'awakening')


def get(url):
    r = subprocess.run(['curl', '-sS', '--fail', '--max-time', '40',
                        '-H', 'Accept: application/vnd.github+json', url],
                       capture_output=True, timeout=60)
    if r.returncode != 0:
        return None
    try:
        return json.loads(r.stdout)
    except Exception:
        return None


def looks_recreated(repo):
    text = ' '.join([repo.get('full_name', ''), repo.get('description') or '',
                     ' '.join(repo.get('topics') or [])]).lower()
    return any(w in text for w in RECREATION)


def inspect(full_name):
    """What is actually in there: project files, scenes, and script density."""
    tree = get(f'{API}/repos/{full_name}/git/trees/HEAD?recursive=1')
    if not tree or 'tree' not in tree:
        return None
    paths = [t['path'] for t in tree['tree']]
    proj = [p for p in paths if p.endswith('.gbsproj')]
    if not proj:
        return None
    scenes = [p for p in paths if p.endswith('scene.gbsres')]
    scripts = [p for p in paths if '/scripts/' in p and p.endswith('.gbsres')]
    return {'projects': proj[:2], 'scenes': len(scenes), 'script_files': len(scripts),
            'split': bool(scenes), 'truncated': tree.get('truncated', False)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--queries', nargs='*', default=QUERIES)
    ap.add_argument('--per-query', type=int, default=20)
    ap.add_argument('--min-stars', type=int, default=0)
    ap.add_argument('--pause', type=float, default=2.5)
    ap.add_argument('--json', default='')
    args = ap.parse_args()

    seen, found = set(), []
    for q in args.queries:
        url = f'{API}/search/repositories?q={q.replace(" ", "+")}&sort=stars&per_page={args.per_query}'
        d = get(url)
        time.sleep(args.pause)
        if not d or 'items' not in d:
            print(f'  ({q}: no results or rate limited)', file=sys.stderr)
            continue
        for r in d['items']:
            name = r['full_name']
            if name in seen or r['stargazers_count'] < args.min_stars:
                continue
            seen.add(name)
            lic = (r.get('license') or {}).get('spdx_id') or '-'
            if lic not in OK_LICENCES:
                continue
            print(f'  checking {name} …', end=' ', flush=True, file=sys.stderr)
            info = inspect(name)
            time.sleep(args.pause)
            if not info:
                print('no project file', file=sys.stderr)
                continue
            entry = {
                'name': name.split('/')[-1].lower(),
                'repo': name,
                'branch': r.get('default_branch') or 'main',
                'licence': lic,
                'original': not looks_recreated(r),
                'what': (r.get('description') or 'a GB Studio project')[:80],
                'stars': r['stargazers_count'],
                'scenes': info['scenes'],
                'layout': 'split' if info['split'] else 'single file',
            }
            found.append(entry)
            print(f"ok · {lic} · {info['scenes']} scenes · "
                  f"{'original' if entry['original'] else 'recreation'}", file=sys.stderr)

    found.sort(key=lambda e: (-e['original'], -e['stars']))
    print(f'\n{len(found)} usable project(s)\n')
    for e in found:
        mark = 'original' if e['original'] else 'RECREATION'
        print(f"  {e['stars']:>4}*  {e['licence']:<12} {mark:<11} {e['repo']}")
        print(f"        {e['what']}")
    print('\nPaste into SOURCES in tools/fetch_sources.py:\n')
    for e in found:
        print("    {'name': %r, 'repo': %r, 'branch': %r,\n"
              "     'licence': %r, 'original': %s,\n"
              "     'what': %r}," % (e['name'], e['repo'], e['branch'],
                                     e['licence'], e['original'], e['what']))
    if args.json:
        with open(args.json, 'w', encoding='utf-8') as f:
            json.dump(found, f, indent=2)
    return 0


if __name__ == '__main__':
    sys.exit(main())
