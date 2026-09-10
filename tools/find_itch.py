#!/usr/bin/env python3
"""Go looking for GB Studio projects the way a person would: through the jams.

`find_sources.py` searches GitHub, which finds a repository only if somebody
tagged it. Most jam entries are called `my-jam-game`, carry no topic at all,
and are invisible to that search - so the largest gathering of Game Boy games
made in the last five years was not in the corpus.

The jams are on itch.io, and an itch page carries two things worth having:
a link to the source, and a description somebody wrote for a human being.
The second matters as much as the first. Every prompt in the generated half
of the corpus came out of a vocabulary we wrote ourselves, so the model has
never read a game described the way a stranger would describe it.

    python3 tools/find_itch.py                       # the Game Boy jams
    python3 tools/find_itch.py --jams gbcompo23      # one of them
    python3 tools/find_itch.py --no-probe            # skip the GitHub checks

Pages are cached under data/itch-cache/, so a second run costs nothing and
re-running after a change is free. It asks for one page a second: this is
somebody's server and there is no hurry.
"""
import argparse, html, json, re, shutil, subprocess, sys, tempfile, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import find_sources as GH                                   # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / 'data' / 'itch-cache'
UA = 'neojutsu-corpus/1.0 (+https://neojutsu.com; gathering GB Studio sources)'

# The Game Boy jams. GBCompo asks for a ROM and offers extra prizes for open
# source; GBJAM asks only that it look and feel like a Game Boy, so most of
# its entries are made in other engines - worth reading for descriptions even
# where there is no project file to import.
JAMS = ['gbcompo21', 'gbcompo23', 'gbcompo25', 'gbjam-11', 'gbjam-12', 'gbjam-13']

# And the tags, which are a wider net than the jams by a long way. A jam is
# one summer; a tag is everybody who has ever ticked the box. GBJAM in
# particular accepts any engine, so most of its entries are not GB Studio at
# all, while everything under `tag-gbstudio` says it is.
# Ordered by how likely a game under one is to be a game we can read. A game
# tagged `gameboy-rom` has produced a ROM, so it was built in GB Studio or
# GBDK; `gameboy` takes in everything that merely looks like one, which is
# most of the tag and worth reading anyway for how it describes itself.
TAGS = ['gbstudio', 'gb-studio', 'gameboy-rom', 'gbdk', 'homebrew', 'gameboy']

FORGE = re.compile(r'https?://(?:www\.)?(github\.com|gitlab\.com|codeberg\.org|git\.sr\.ht)/'
                   r'([A-Za-z0-9._-]+)/([A-Za-z0-9._-]+)')
# Links that are on every page and are nobody's source.
NOT_SOURCE = ('/topics/', '/orgs/', '/sponsors/', 'github.com/itchio',
              'github.io', '/gb-studio-community-assets')


def fetch(url, pause):
    """One page, cached. The cache is the whole politeness story: a re-run of
    a four-hundred-page crawl should cost the server nothing at all."""
    CACHE.mkdir(parents=True, exist_ok=True)
    key = re.sub(r'[^A-Za-z0-9]+', '_', url)[-120:]
    hit = CACHE / f'{key}.html'
    if hit.exists():
        return hit.read_text(encoding='utf-8', errors='replace')
    r = subprocess.run(['curl', '-sSL', '--max-time', '40', '-A', UA, url],
                       capture_output=True, timeout=90)
    body = r.stdout.decode('utf-8', 'replace')
    hit.write_text(body, encoding='utf-8')
    time.sleep(pause)
    return body


def tag_games(tag, pause, pages):
    """Every game under a tag, page by page, until itch runs out of them.

    The grid renders from a JSON feed that hands back a lump of HTML, so the
    game links are read out of that rather than out of a tidy list. It stops
    on the first empty page: there is no count to ask for.
    """
    out = []
    for page in range(1, pages + 1):
        body = fetch(f'https://itch.io/games/tag-{tag}?page={page}&format=json', pause)
        try:
            html_lump = json.loads(body).get('content') or ''
        except Exception:
            break
        # Read the anchor, then look inside it. itch does not write these
        # attributes in a fixed order - on some pages the href comes first and
        # on others the class does - and a pattern that assumed one order
        # stopped dead on page six of a listing that ran for dozens more,
        # reporting the tag as nearly empty.
        found = []
        for tag_html in re.findall(r'<a\b[^>]*class="[^"]*thumb_link[^"]*"[^>]*>', html_lump):
            href = re.search(r'href="([^"]+)"', tag_html)
            if href:
                found.append(href.group(1).replace('\\/', '/'))
        if not found:
            break
        titles = re.findall(r'class="title game_link"[^>]*>([^<]*)<', html_lump)
        for i, u in enumerate(found):
            out.append({'game': {'url': u, 'title': (titles[i] if i < len(titles) else ''),
                                 'user': {}, 'short_text': '', 'platforms': []}})
    return out


def jam_entries(slug, pause):
    """The jam's own list of games. The page renders it from a JSON feed whose
    address carries the jam's numeric id, so the slug alone is not enough."""
    page = fetch(f'https://itch.io/jam/{slug}/entries', pause)
    m = re.search(r'"entries_url":"\\?/jam\\?/(\d+)\\?/entries\.json"', page)
    if not m:
        return []
    feed = fetch(f'https://itch.io/jam/{m.group(1)}/entries.json', pause)
    try:
        return json.loads(feed).get('jam_games') or []
    except Exception:
        return []


def strip_tags(s):
    s = re.sub(r'<(script|style)[^>]*>.*?</\1>', ' ', s, flags=re.S | re.I)
    s = re.sub(r'<br\s*/?>|</p>|</div>|</li>', '\n', s, flags=re.I)
    s = re.sub(r'<[^>]+>', ' ', s)
    return re.sub(r'[ \t]+', ' ', html.unescape(s)).strip()


def read_page(body):
    """What an itch page is worth: how it describes itself, what it was made
    with, and where the source is."""
    desc = ''
    m = re.search(r'<div class="formatted_description user_formatted">(.*?)</div>\s*(?:<div|<section)',
                  body, re.S)
    if m:
        desc = strip_tags(m.group(1))
    desc = re.sub(r'\n{3,}', '\n\n', desc)[:4000]

    tags = [t.lower() for t in re.findall(r'/games/tag-([a-z0-9-]+)', body)]
    made_with = ''
    mw = re.search(r'Made with</td>\s*<td>(.*?)</td>', body, re.S)
    if mw:
        made_with = strip_tags(mw.group(1))[:80]

    seen, links = set(), []
    for m in FORGE.finditer(body):
        url = m.group(0).rstrip('.,)"\'').removesuffix('.git')
        if any(bad in url for bad in NOT_SOURCE) or url in seen:
            continue
        seen.add(url)
        links.append(url)
    return {'description': desc, 'tags': sorted(set(tags))[:12],
            'made_with': made_with, 'links': links[:6]}


def peek(url, workdir):
    """What is in a repository, without asking GitHub's API for it.

    The API allows sixty calls an hour to anyone without a token, and there
    are more than a hundred repositories to look at - four hours of waiting to
    answer a question that takes under a second. A blobless clone fetches the
    commit and the directory listing and none of the file contents: a hundred
    and thirty kilobytes and three quarters of a second, and no quota at all.
    Any forge that speaks git answers, so GitLab and Codeberg work too.
    """
    workdir = Path(workdir)
    if workdir.exists():
        shutil.rmtree(workdir, ignore_errors=True)
    r = subprocess.run(['git', 'clone', '--filter=blob:none', '--no-checkout',
                        '--depth', '1', '-q', url, str(workdir)],
                       capture_output=True, timeout=180)
    if r.returncode != 0:
        return None
    ls = subprocess.run(['git', '-C', str(workdir), 'ls-tree', '-r', '--name-only', 'HEAD'],
                        capture_output=True, timeout=120)
    paths = ls.stdout.decode('utf-8', 'replace').splitlines()
    proj = [p for p in paths if p.endswith('.gbsproj')]
    if not proj:
        return None
    licence = '-'
    for p in paths:
        base = p.rsplit('/', 1)[-1].upper()
        if base.startswith(('LICENSE', 'LICENCE', 'COPYING')):
            # The blob is fetched on demand, which is the one place this
            # spends any bandwidth at all.
            show = subprocess.run(['git', '-C', str(workdir), 'show', f'HEAD:{p}'],
                                  capture_output=True, timeout=120)
            licence = spdx(show.stdout.decode('utf-8', 'replace')[:2000]) or licence
            if licence != '-':
                break
    return {
        'projects': proj[:2],
        'scenes': len([p for p in paths if p.endswith('scene.gbsres')]),
        'script_files': len([p for p in paths if '/scripts/' in p and p.endswith('.gbsres')]),
        'split': any(p.endswith('scene.gbsres') for p in paths),
        'licence': licence,
        'files': len(paths),
    }


# Enough of each licence to tell it apart from the others by its own words.
LICENCE_WORDS = [
    ('CC0-1.0', 'creative commons legal code' ), ('CC0-1.0', 'cc0 1.0 universal'),
    ('Unlicense', 'this is free and unencumbered software released into the public domain'),
    ('MIT', 'permission is hereby granted, free of charge'),
    ('Apache-2.0', 'apache license'), ('MPL-2.0', 'mozilla public license'),
    ('AGPL-3.0', 'gnu affero general public license'),
    ('GPL-3.0', 'gnu general public license'), ('GPL-3.0', 'version 3, 29 june 2007'),
    ('GPL-2.0', 'version 2, june 1991'),
    ('BSD-3-Clause', 'neither the name of'), ('BSD-2-Clause', 'redistribution and use in source'),
    ('CC-BY-SA-4.0', 'attribution-sharealike 4.0'), ('CC-BY-4.0', 'attribution 4.0 international'),
]


def spdx(text):
    low = ' '.join(text.lower().split())
    for name, phrase in LICENCE_WORDS:
        if phrase in low:
            return name
    return ''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--jams', nargs='*', default=JAMS)
    ap.add_argument('--tags', nargs='*', default=TAGS)
    ap.add_argument('--tag-pages', type=int, default=60,
                    help='how deep to page through each tag before giving up')
    ap.add_argument('--pause', type=float, default=1.0)
    ap.add_argument('--probe', dest='probe', action='store_true', default=True,
                    help='check each source repo for a GB Studio project (default)')
    ap.add_argument('--no-probe', dest='probe', action='store_false')
    ap.add_argument('--only-new', action='store_true',
                    help='skip repos already listed in data/itch-candidates.jsonl, '
                         'so a throttled run can be continued rather than restarted')
    ap.add_argument('--out', default='data/itch-candidates.jsonl')
    ap.add_argument('--descriptions', default='data/itch-descriptions.jsonl')
    args = ap.parse_args()

    rows, seen_games = [], set()
    sources = ([(s, 'jam', jam_entries(s, args.pause)) for s in args.jams]
               + [(t, 'tag', tag_games(t, args.pause, args.tag_pages)) for t in args.tags])
    for slug, kind, entries in sources:
        print(f'{slug} ({kind}): {len(entries)} entries', file=sys.stderr)
        for i, e in enumerate(entries, 1):
            g = e.get('game') or {}
            url = g.get('url')
            if not url or url in seen_games:
                continue
            seen_games.add(url)
            page = read_page(fetch(url, args.pause))
            rows.append({
                'jam': slug, 'title': g.get('title', ''), 'url': url,
                'author': ((g.get('user') or {}).get('name') or ''),
                'short_text': g.get('short_text') or '',
                'platforms': g.get('platforms') or [],
                **page,
            })
            print(f'\r  read {i}/{len(entries)}', end='', file=sys.stderr, flush=True)
        print(file=sys.stderr)

    # Everything with a description is worth keeping, source or not: a game
    # described in somebody's own words is the half of the pairing we cannot
    # invent for ourselves.
    dpath = ROOT / args.descriptions
    dpath.parent.mkdir(parents=True, exist_ok=True)
    with dpath.open('w', encoding='utf-8') as f:
        for r in rows:
            if not (r['short_text'] or r['description']):
                continue
            f.write(json.dumps({k: r[k] for k in
                                ('jam', 'title', 'url', 'author', 'short_text',
                                 'description', 'tags', 'made_with')},
                               ensure_ascii=False) + '\n')

    cand = [r for r in rows if r['links']]
    print(f'\n{len(rows)} entries read, {len(cand)} with a source link', file=sys.stderr)

    # A probe that ran out of budget last time should carry on rather than
    # start again: the first thirty repositories are already known.
    kept, done, work = [], set(), Path(tempfile.mkdtemp(prefix='neojutsu-peek-'))
    opath_pre = ROOT / args.out
    if args.only_new and opath_pre.exists():
        for line in opath_pre.read_text(encoding='utf-8').splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            kept.append(row); done.add(row['repo'])
        print(f'{len(done)} repositories already checked', file=sys.stderr)
    if args.probe:
        left, cap = GH.budget()
        if left is not None:
            print(f'GitHub budget: {left}/{cap}', file=sys.stderr)
        for r in cand:
            for url in r['links']:
                m = FORGE.match(url)
                if not m:
                    continue
                full = f'{m.group(2)}/{m.group(3)}'
                if full in done:
                    continue
                done.add(full)
                info = peek(url, work / 'repo')
                if not info:
                    continue
                lic = info['licence']
                blurb = f"{r['short_text']} {r['title']}".lower()
                kept.append({
                    'name': full.split('/')[-1].lower(), 'repo': full, 'clone': url,
                    'branch': 'HEAD',
                    'licence': lic, 'usable_licence': lic in GH.OK_LICENCES,
                    'original': not any(w in blurb for w in GH.RECREATION),
                    'what': (r['short_text'] or r['title'])[:80],
                    'scenes': info['scenes'], 'script_files': info['script_files'],
                    'layout': 'split' if info['split'] else 'single file',
                    'itch': r['url'], 'jam': r['jam'], 'title': r['title'],
                })
                print(f"  {full}: {info['scenes']} scenes, {info['script_files']} scripts, {lic}",
                      file=sys.stderr)
        shutil.rmtree(work, ignore_errors=True)

    opath = ROOT / args.out
    with opath.open('w', encoding='utf-8') as f:
        for k in kept:
            f.write(json.dumps(k, ensure_ascii=False) + '\n')

    usable = [k for k in kept if k['usable_licence'] and k['scenes']]
    print(json.dumps({
        'entries': len(rows), 'with_source_link': len(cand),
        'gb_studio_projects': len(kept),
        'usable_licence': len(usable),
        'scenes_available': sum(k['scenes'] for k in usable),
        'descriptions': str(dpath), 'candidates': str(opath),
    }, indent=2))


if __name__ == '__main__':
    sys.exit(main() or 0)
