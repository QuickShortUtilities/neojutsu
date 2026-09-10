#!/usr/bin/env python3
"""What people call their games, and how much of it we do not understand.

Every prompt in the generated corpus was built from a vocabulary we wrote,
so the generator has only ever been asked for things it already knew the
words for. That is a closed loop: it cannot tell us what a stranger would
type, and the corpus cannot teach a model to handle it.

`find_itch.py` collects how a thousand real Game Boy games describe
themselves. This runs those descriptions past `NeoGameGen.read()` - the same
function the box in the studio uses - and reports the words that come up
often and change nothing.

    python3 tools/vocab_gap.py
    python3 tools/vocab_gap.py --top 60

A word here is not automatically worth supporting. Some are about art, or
music, or a story, and this engine has nothing to say about those. The list
is a place to look, not a list of jobs.
"""
import argparse, json, re, sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_dataset import serve                          # noqa: E402

ROOT = Path(__file__).resolve().parents[1]

# Words that say nothing about what a game is. Kept short on purpose: the
# point is to see what is there, not to tidy it into what we expected.
DULL = set('''a an the and or but if then than that this these those of in on at to for with by
from up down out over under again very just too also as is are was were be been being am
it its it's you your we our they their he she his her him them i me my mine
game games play playing player made make making made using used use new now more most some any
all not no yes can will would could should may might must do does did done have has had
here there where when what which who whom whose why how one two three four five six seven eight
nine ten first second next last own same other another each every both few many much lot lots
about after before between into through during without within along across behind beyond
get got go goes going come comes came take takes took give gives gave
like well back even still way ways thing things time times day days year years
free full short long small big little new old best good great fun really please thanks thank
version demo jam entry submission compo release build download itch link click here follow
music sound art sprite sprites pixel graphics font tileset palette colour color
english language update updates bug fixes fix support patreon twitter discord
gb gbc gameboy game-boy boy rom emulator hardware cartridge nintendo
'''.split())

WORD = re.compile(r"[a-z][a-z'-]{2,}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='src', default='data/itch-descriptions.jsonl')
    ap.add_argument('--top', type=int, default=40)
    ap.add_argument('--min-count', type=int, default=4)
    ap.add_argument('--out', default='data/vocab-gap.json')
    args = ap.parse_args()

    path = ROOT / args.src
    if not path.exists():
        print(f'no descriptions at {path}. Run tools/find_itch.py first.', file=sys.stderr)
        return 2
    rows = [json.loads(l) for l in path.read_text(encoding='utf-8').splitlines() if l.strip()]

    # The short line under the title is the one people write carefully; the
    # long body is mostly credits and where to buy a cartridge.
    counts, tag_counts = Counter(), Counter()
    for r in rows:
        text = f"{r.get('short_text','')} {r.get('title','')}".lower()
        counts.update(w for w in WORD.findall(text) if w not in DULL)
        tag_counts.update(r.get('tags') or [])
    common = [(w, n) for w, n in counts.most_common(600) if n >= args.min_count]

    from playwright.sync_api import sync_playwright
    srv, port = serve()
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(headless=True)
            page = b.new_context(viewport={'width': 900, 'height': 700}).new_page()
            page.goto(f'http://127.0.0.1:{port}/game.html')
            page.wait_for_function('!!(window.NeoGameGen)', timeout=30000)
            # A word is understood if putting it in a description changes what
            # the reader decides. Compared against a bare description, so a
            # word that only agrees with the default counts as understood.
            heard = page.evaluate("""(words) => {
              const base = JSON.stringify(NeoGameGen.read('a game'));
              const out = {};
              for (const w of words) {
                const said = NeoGameGen.read('a game ' + w);
                out[w] = JSON.stringify(said) !== base;
              }
              return out;
            }""", [w for w, _ in common])
            b.close()
    finally:
        srv.shutdown()

    gap = [(w, n) for w, n in common if not heard.get(w)]
    known = [(w, n) for w, n in common if heard.get(w)]

    out = {
        'descriptions': len(rows),
        'words_considered': len(common),
        'understood': len(known),
        'not_understood': len(gap),
        'top_missing': dict(gap[:args.top]),
        'top_understood': dict(known[:12]),
        'top_tags': dict(tag_counts.most_common(30)),
    }
    (ROOT / args.out).write_text(json.dumps(out, indent=2), encoding='utf-8')
    print(json.dumps(out, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
