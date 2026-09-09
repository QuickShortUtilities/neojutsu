#!/usr/bin/env python3
"""Fetch GB Studio projects to import, so you do not have to go looking.

Each entry is a public repository with a licence that allows reuse. They are
downloaded to a folder outside the repo, because what comes out of them is
somebody else's work being converted for your own use, not something to
redistribute.

    python3 tools/fetch_sources.py                 # original work only
    python3 tools/fetch_sources.py --all           # plus fan recreations
    python3 tools/fetch_sources.py --list          # just show them

Then, in one go:

    python3 tools/import_gbstudio.py --in ~/neojutsu-sources
"""
import argparse, io, json, shutil, subprocess, ssl, sys, urllib.request, zipfile
from pathlib import Path

# `original` marks work the author designed themselves. The others are
# recreations: the repository's licence covers the author's files, but the
# level designs inside are somebody else's, so they are opt-in and are worth
# keeping to private experiments.
SOURCES = [
    # Found and verified by tools/find_sources.py. Copyleft licences are
    # marked: fine for training on your own machine, worth a thought before
    # anything built on them is shipped.
    {'name': 'gba-studio', 'repo': 'eoinjordan/GBA-Studio', 'branch': 'main',
     'licence': 'MIT', 'original': True,
     'what': '85 scenes, the largest single source found'},
    {'name': 'gb-studio-sample', 'repo': 'chrismaltby/gb-studio', 'branch': 'develop',
     'licence': 'MIT', 'original': True,
     'what': 'the sample project shipped inside GB Studio itself, 25 scenes'},
    {'name': 'unloved-blessing', 'repo': 'javier-games/jam-unloved-blessing', 'branch': 'main',
     'licence': 'GPL-3.0', 'original': True,
     'what': 'top-down stealth horror jam game, 18 scenes'},
    {'name': 'DC32BadgeGame', 'repo': 'CosmicBonBon/DC32BadgeGame', 'branch': 'main',
     'licence': 'MIT', 'original': True,
     'what': 'DEFCON 32 badge game, a complete original game'},
    {'name': 'moki-monster-kid', 'repo': 'sleepingpandagames/moki-the-monster-kid', 'branch': 'main',
     'licence': 'MPL-2.0', 'original': True,
     'what': 'GBCompo23 game jam entry'},
    {'name': 'dark-adventure', 'repo': 'thegamershollow/Dark-Adventure', 'branch': 'main',
     'licence': 'MIT', 'original': True,
     'what': 'a small original adventure'},
    {'name': 'roamer', 'repo': 'cybardev/Roamer', 'branch': 'main',
     'licence': 'GPL-3.0', 'original': True,
     'what': 'endless runner'},
    {'name': 'merry-sample', 'repo': 'chrismaltby/gbs-merry-sample-project', 'branch': 'master',
     'licence': 'MIT', 'original': True,
     'what': "sample project by GB Studio's author"},
    {'name': 'game-jam-project', 'repo': 'gabrieloakz/Game-Jam-Project', 'branch': 'main',
     'licence': 'MIT', 'original': True,
     'what': 'a game jam entry'},
    {'name': 'gbs-ci-example', 'repo': 'Pomdap/gb-studio-ci-example', 'branch': 'main',
     'licence': 'CC0-1.0', 'original': True,
     'what': 'a project template'},
    {'name': 'community-assets', 'repo': 'DeerTears/GB-Studio-Community-Assets', 'branch': 'master',
     'licence': 'MIT', 'original': True,
     'what': 'original community art, no attribution required'},
    {'name': 'untitled-gb-game', 'repo': 'chrismaltby/untitled-gb-game', 'branch': 'master',
     'licence': 'MIT', 'original': False,
     'what': '52 scenes; layouts recreate a commercial game, so private use only'},
]


def grab(entry, dest):
    url = f"https://codeload.github.com/{entry['repo']}/zip/refs/heads/{entry['branch']}"
    out = dest / entry['name']
    if out.exists():
        return 'already here'
    # Python's own SSL often has no certificate bundle on a Mac, while curl
    # always does, so curl is tried first and urllib is the fallback.
    data = None
    if shutil.which('curl'):
        try:
            r = subprocess.run(['curl', '-sSL', '--fail', '--max-time', '300', url],
                               capture_output=True, timeout=320)
            if r.returncode == 0 and r.stdout:
                data = r.stdout
        except Exception:
            data = None
    if data is None:
        try:
            with urllib.request.urlopen(url, timeout=120, context=ssl._create_unverified_context()) as r:
                data = r.read()
        except Exception as e:
            return f'could not fetch: {e}'
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            z.extractall(out)
    except Exception as e:
        return f'could not unzip: {e}'
    projects = list(out.rglob('*.gbsproj'))
    return f'{len(projects)} project file(s)' if projects else 'no .gbsproj inside'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--to', default='~/neojutsu-sources')
    ap.add_argument('--all', action='store_true', help='include fan recreations')
    ap.add_argument('--list', action='store_true')
    args = ap.parse_args()

    picked = [s for s in SOURCES if s['original'] or args.all]
    if args.list:
        for s in SOURCES:
            mark = 'original' if s['original'] else 'recreation'
            print(f"  {s['name']:<18} {s['licence']:<5} {mark:<11} {s['what']}")
            print(f"      https://github.com/{s['repo']}")
        return 0

    dest = Path(args.to).expanduser()
    dest.mkdir(parents=True, exist_ok=True)
    results = {}
    for s in picked:
        print(f"  {s['name']} …", end=' ', flush=True, file=sys.stderr)
        r = grab(s, dest)
        print(r, file=sys.stderr)
        results[s['name']] = r

    print(json.dumps({'folder': str(dest), 'fetched': results,
                      'next': f'python3 tools/import_gbstudio.py --in {dest}'}, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
