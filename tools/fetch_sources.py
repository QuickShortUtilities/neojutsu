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
    # GB Compo entries and other published games. Fetching does not touch the
    # rate-limited API, so these are taken on their licence and the importer
    # reports which ones actually carry a project.
    {'name': 'potion-panic', 'repo': 'DevEd2/potion-panic', 'branch': 'main',
     'licence': 'MIT', 'original': True, 'what': 'single-screen platformer, GBCompo 2025'},
    {'name': 'hunters-heart', 'repo': 'gbcompo25/A-Hunters-Heart-Demo-gbcompo25', 'branch': 'main',
     'licence': 'CC0-1.0', 'original': True, 'what': 'GBCompo 2025 demo'},
    {'name': 'millennium-gun', 'repo': 'gbcompo25/millennium-gun-gbcompo25', 'branch': 'main',
     'licence': '0BSD', 'original': True, 'what': 'GBCompo 2025 entry'},
    {'name': 'enkidu', 'repo': 'gbcompo25/Enkidu-gbcompo25', 'branch': 'main',
     'licence': 'GPL-3.0', 'original': True, 'what': 'GBCompo 2025 entry'},
    {'name': 'dig-game', 'repo': 'Les-Wet/dig-game', 'branch': 'main',
     'licence': 'GPL-3.0', 'original': True, 'what': 'GBCompo 2025 entry'},
    {'name': 'station-333', 'repo': 'factorialunar/station-333', 'branch': 'main',
     'licence': 'GPL-3.0', 'original': True, 'what': 'a small RPG adventure'},
    {'name': 'st-kk-rpg', 'repo': 'DylanAVC/st-kk-rpg', 'branch': 'main',
     'licence': 'Apache-2.0', 'original': True, 'what': 'an RPG made with GB Studio'},
    {'name': 'back-on-mountain', 'repo': 'Varanslash/Back-On-Mountain', 'branch': 'main',
     'licence': 'MIT', 'original': True, 'what': 'a Game Boy Color game'},
    {'name': 'creek-town', 'repo': 'thejohncotton/Creek-Town', 'branch': 'main',
     'licence': 'MIT', 'original': True, 'what': 'an open source GB Studio game'},
    {'name': 'grind-boy', 'repo': 'Shellywell123/Grind-Boy.gb', 'branch': 'main',
     'licence': 'GPL-3.0', 'original': True, 'what': 'homebrew skateboarding game'},
    {'name': 'gbstudio-test', 'repo': 'bohdanhor/GameDev-GB-Studio-Test', 'branch': 'main',
     'licence': 'MIT', 'original': True, 'what': 'a demo game'},
    # Found by tools/gbdev_index.py, which mines the community's homebrew
    # index for repositories and then downloads each one to see whether it
    # actually holds a GB Studio project. 9 of 58 permissively licensed
    # repositories did. Share-alike licences are marked.
    {'name': '5-mazes', 'repo': 'godai78/5-Mazes', 'branch': 'main',
     'licence': 'CC-BY-SA 4.0', 'original': True,
     'what': '5 mazes (share-alike)'},
    {'name': '5-mazes-master-levels', 'repo': 'godai78/5-mazes-Master-levels', 'branch': 'main',
     'licence': 'CC-BY-SA 4.0', 'original': True,
     'what': '5 mazes: Master levels (share-alike)'},
    {'name': '5-more-mazes', 'repo': 'godai78/5-more-mazes', 'branch': 'main',
     'licence': 'CC-BY-SA 4.0', 'original': True,
     'what': '5 more mazes (share-alike)'},
    {'name': 'dusky-dungeon', 'repo': 'inverted-hat/duskyDungeon', 'branch': 'master',
     'licence': 'MIT', 'original': True,
     'what': 'Dusky Dungeon'},
    {'name': 'europa-rescue', 'repo': 'godai78/europa', 'branch': 'main',
     'licence': 'CC-BY-SA 4.0', 'original': True,
     'what': 'Europa rescue! (share-alike)'},
    {'name': 'labirinth', 'repo': 'godai78/labirinth', 'branch': 'main',
     'licence': 'CC-BY-SA 4.0', 'original': True,
     'what': 'Labirinth (share-alike)'},
    {'name': 'postie', 'repo': 'inverted-hat/postie', 'branch': 'main',
     'licence': 'MIT', 'original': True,
     'what': 'Postie'},
    {'name': 'zone-booth_pizza-palace', 'repo': 'kinostl/Pizza-Palace', 'branch': 'main',
     'licence': 'GPL-3.0-only', 'original': True,
     'what': 'Pizza Palace'},
    # From the wider sweep with the licence filter off: personal research,
    # so the licence gates nothing here - but it is recorded per source so
    # the set can be filtered later rather than re-derived.
    {'name': 'dawn-will-come', 'repo': 'eishiya/DawnWillCome', 'branch': 'master',
     'licence': 'MIT / CC-BY-4.0 (Assets)', 'original': True,
     'what': 'Dawn Will Come'},
    {'name': 'grimmrobegames__abducted', 'repo': 'mrmmaclean/Abducted', 'branch': 'main',
     'licence': 'unstated', 'original': True,
     'what': 'Abducted'},
    {'name': 'pearacidic__monster-orc-arina-a-game-boy-tool', 'repo': 'pearacidic/monster_orcarina', 'branch': 'main',
     'licence': 'unstated', 'original': True,
     'what': 'Monster Orc-arina'},
    {'name': 'pixelloren__third-grade-noir', 'repo': 'pixelloren2/Third-Grade-Noir', 'branch': 'main',
     'licence': 'unstated', 'original': True,
     'what': 'Third Grade Noir'},
    {'name': 'timespacewarrior__temporal-light-jem-of-twilight', 'repo': 'SpaceTimeWarrior/temporal-light-Jem-of-Twilight', 'branch': 'main',
     'licence': 'unstated', 'original': True,
     'what': 'Temporal Light-Jem of Twilight gamejam demo'},
    {'name': 'untitled-gb-game', 'repo': 'chrismaltby/untitled-gb-game', 'branch': 'master',
     'licence': 'MIT', 'original': False,
     'what': '52 scenes; layouts recreate a commercial game, so private use only'},
]


def grab(entry, dest):
    # Whatever the default branch is called. A repository found automatically
    # does not come with that name attached, and asking for a branch called
    # "HEAD" is a 404 - which is how six projects found in one afternoon were
    # reported as missing when every one of them was there. codeload
    # understands zip/HEAD and hands back whatever the default is, so that is
    # tried first, and a named branch only when one is known.
    branch = entry.get('branch') or 'HEAD'
    urls = [f"https://codeload.github.com/{entry['repo']}/zip/HEAD"] if branch == 'HEAD' else [
        f"https://codeload.github.com/{entry['repo']}/zip/refs/heads/{branch}",
        f"https://codeload.github.com/{entry['repo']}/zip/HEAD",
    ]
    out = dest / entry['name']
    if out.exists():
        return 'already here'
    # Python's own SSL often has no certificate bundle on a Mac, while curl
    # always does, so curl is tried first and urllib is the fallback.
    data, why = None, 'no url tried'
    for url in urls:
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
                with urllib.request.urlopen(url, timeout=120,
                                            context=ssl._create_unverified_context()) as r:
                    data = r.read()
            except Exception as e:
                why = str(e)
        if data is not None:
            break
    if data is None:
        return f'could not fetch: {why}'
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
    ap.add_argument('--also', default='',
                    help='a jsonl of candidates from tools/find_itch.py, merged in '
                         'so a new find does not have to be pasted into this file')
    ap.add_argument('--min-scenes', type=int, default=6,
                    help='ignore candidates with fewer rooms than this in them')
    args = ap.parse_args()

    sources = list(SOURCES)
    if args.also:
        known = {s['repo'] for s in SOURCES}
        path = Path(args.also).expanduser()
        added = 0
        for line in path.read_text(encoding='utf-8').splitlines():
            if not line.strip():
                continue
            c = json.loads(line)
            # The two questions worth asking of anything found automatically:
            # may it be reused, and is there enough in it to be worth the trip.
            if c['repo'] in known or not c.get('usable_licence') or not c.get('original'):
                continue
            if c.get('scenes', 0) < args.min_scenes:
                continue
            known.add(c['repo'])
            sources.append({'name': c['name'], 'repo': c['repo'],
                            'branch': c.get('branch') or 'HEAD',
                            'licence': c['licence'], 'original': True,
                            'what': c.get('what') or 'found on itch.io'})
            added += 1
        print(f'{added} candidate(s) merged from {path}', file=sys.stderr)

    picked = [s for s in sources if s['original'] or args.all]
    if args.list:
        for s in sources:
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
