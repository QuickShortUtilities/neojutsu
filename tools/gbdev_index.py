#!/usr/bin/env python3
"""Mine the Game Boy homebrew database for projects we can import.

gbdev/database is the community's index of Game Boy homebrew - about 1360
entries, of which some record where their source lives and under what
licence. It is the best map of the territory that exists.

It is a map, not a treasure chest. Most entries are C or assembly homebrew
with no GB Studio project inside, and nothing in the index says which is
which, so the only honest way to find out is to look. This clones the index
without its ROMs and screenshots, pulls out every repository with a licence
that allows reuse, and reports what is there.

    python3 tools/gbdev_index.py                  # list candidates
    python3 tools/gbdev_index.py --probe 30       # download and check them
"""
import argparse, glob, json, shutil, subprocess, sys, tempfile, zipfile, io
from pathlib import Path
from collections import Counter

ROOT = Path(__file__).resolve().parents[1]
DB = 'https://github.com/gbdev/database.git'
OK = {'MIT', 'Apache-2.0', 'BSD-3-Clause', 'BSD-2-Clause', 'CC0-1.0', 'Unlicense',
      'Zlib', 'ZLib', 'MPL-2.0', 'GPL-3.0', 'GPL-3.0-only', 'GPL-3.0-or-later',
      'GPL-2.0', 'AGPL-3.0', 'CC-BY-4.0', 'CC-BY-SA 4.0', 'CC-BY-SA-4.0'}


def pull_index(dest):
    """The metadata only: no ROMs, no screenshots. The full repository is
    close to a gigabyte and none of that weight is useful here."""
    if (dest / '.git').exists():
        subprocess.run(['git', '-C', str(dest), 'fetch', '--depth', '1'], capture_output=True)
    else:
        subprocess.run(['git', 'clone', '--filter=blob:none', '--no-checkout', '--depth', '1',
                        DB, str(dest)], capture_output=True, timeout=300)
        subprocess.run(['git', '-C', str(dest), 'sparse-checkout', 'init', '--no-cone'],
                       capture_output=True)
        subprocess.run(['git', '-C', str(dest), 'sparse-checkout', 'set', '/entries/*/game.json'],
                       capture_output=True)
        subprocess.run(['git', '-C', str(dest), 'checkout', 'HEAD'], capture_output=True, timeout=300)
    return sorted(dest.glob('entries/*/game.json'))


def candidates(files, any_licence=False):
    out = []
    for f in files:
        try:
            d = json.loads(f.read_text(encoding='utf-8'))
        except Exception:
            continue
        repo = d.get('repository')
        lic = d.get('license') or d.get('gameLicense')
        if not repo or 'github.com' not in repo:
            continue
        # The licence decides what you may ship, not what you may read. For a
        # model that stays on your own machine it is a filter you can drop -
        # but it is recorded either way, so the question can be answered later
        # rather than guessed at.
        if not any_licence and lic not in OK:
            continue
        name = repo.rstrip('/').split('github.com/')[-1]
        if name.endswith('.git'):
            name = name[:-4]
        if name.count('/') != 1:
            continue
        out.append({'slug': d.get('slug'), 'title': d.get('title'), 'repo': name,
                    'licence': lic or 'unstated', 'tags': d.get('tags') or []})
    return out


def has_project(repo):
    """Download and look. Without a GitHub token there is no cheap way to ask
    what is in a repository, and guessing from the description is how you end
    up importing nothing."""
    for branch in ('main', 'master'):
        url = f'https://codeload.github.com/{repo}/zip/refs/heads/{branch}'
        r = subprocess.run(['curl', '-sSL', '--fail', '--max-time', '90', url],
                           capture_output=True, timeout=120)
        if r.returncode != 0 or not r.stdout:
            continue
        try:
            with zipfile.ZipFile(io.BytesIO(r.stdout)) as z:
                names = z.namelist()
        except Exception:
            continue
        proj = [n for n in names if n.endswith('.gbsproj')]
        return {'branch': branch, 'gbsproj': len(proj), 'files': len(names)}
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', default='~/.cache/gbdev-index')
    ap.add_argument('--probe', type=int, default=0,
                    help='download this many candidates and check for a project file')
    ap.add_argument('--any-licence', action='store_true',
                    help='every repository, not only the ones licensed for reuse')
    ap.add_argument('--json', default='')
    args = ap.parse_args()

    dest = Path(args.cache).expanduser()
    dest.parent.mkdir(parents=True, exist_ok=True)
    print('pulling the index …', file=sys.stderr)
    files = pull_index(dest)
    print(f'{len(files)} entries', file=sys.stderr)

    cand = candidates(files, args.any_licence)
    lic = Counter(c['licence'] for c in cand)
    how = 'any licence' if args.any_licence else 'a licence that allows reuse'
    print(f'\n{len(cand)} with a GitHub repository and {how}')
    print('  licences:', dict(lic.most_common(8)))

    if not args.probe:
        for c in cand[:40]:
            print(f"  {c['licence']:<18} {c['repo']:<44} {(c['title'] or '')[:32]}")
        print('\nRun with --probe N to download and see which carry a GB Studio project.')
        return 0

    usable = []
    for c in cand[:args.probe]:
        print(f"  {c['repo']} …", end=' ', flush=True, file=sys.stderr)
        info = has_project(c['repo'])
        if not info:
            print('could not fetch', file=sys.stderr); continue
        if not info['gbsproj']:
            print(f"no project ({info['files']} files)", file=sys.stderr); continue
        c.update(info)
        usable.append(c)
        print(f"GB STUDIO · {info['gbsproj']} project file(s)", file=sys.stderr)

    print(f'\n{len(usable)} of {min(args.probe, len(cand))} carry a GB Studio project\n')
    for c in usable:
        print("    {'name': %r, 'repo': %r, 'branch': %r,\n"
              "     'licence': %r, 'original': True,\n"
              "     'what': %r}," % (c['slug'], c['repo'], c['branch'], c['licence'],
                                     (c['title'] or 'a Game Boy homebrew')[:70]))
    if args.json:
        Path(args.json).write_text(json.dumps(usable, indent=2), encoding='utf-8')
    return 0


if __name__ == '__main__':
    sys.exit(main())
