"""The panel only offers what the game can honour.

A control that does nothing is worse than a missing one, because it reads as
a promise: tick "double jump" on a falling-block game, play, and nothing
happens - not because the game is broken but because there is nobody to jump.
This walks every template, reads what the left column and the floating
windows are actually showing, and checks it against what that mode does.
"""
import json, sys, http.server, threading, functools, socketserver
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path('/Users/christophercohen/Documents/GitHub/neojutsu')
issues, report = [], {}

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
srv = socketserver.TCPServer(('127.0.0.1', 0), handler)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

# What each mode can actually honour, read off the engine rather than guessed.
CAN = {
    'platform': {'g-double', 'g-wall', 'g-dash', 'g-attack', 'g-coop'},
    'topdown':  {'g-dash', 'g-attack', 'g-aimlock', 'g-coop'},
    'racer':    {'g-dash'},
    'shmup':    {'g-attack'},
    'scramble': {'g-attack'},
    'invaders': {'g-attack'},
    'rider':    set(),
    'blocks':   set(),
}

with sync_playwright() as pw:
    b = pw.chromium.launch()
    page = b.new_page()
    err = []
    page.on('pageerror', lambda e: err.append(str(e)))
    page.goto(f'http://127.0.0.1:{port}/game.html')
    page.wait_for_function('!!(window.NeoGameGen && window.NeoSprites && window.NeoSprites.loaded)',
                           timeout=30000)

    names = page.evaluate("() => Object.keys(window.NeoGameTemplates || {})")
    if not names:
        issues.append('no templates to walk')

    seen = page.evaluate("""(ids) => {
      const $ = i => document.getElementById(i);
      const out = [];
      const ABIL = ['g-double','g-wall','g-dash','g-attack','g-aimlock','g-coop'];
      /* Whether the panel is offering this control - not whether the window
         it lives in happens to be open at this moment. Walk up only as far
         as the window body, so a shut window does not read as a hidden row. */
      const shown = el => {
        if (!el) return false;
        for (let n = el; n && !n.classList.contains('game-window-body'); n = n.parentElement)
          if (n.hidden) return false;
        return true;
      };
      for (const id of ids) {
        const sel = $('g-template');
        sel.value = id;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        const spec = window.NeoGameStudio.spec || {};
        const on = ABIL.filter(a => { const r = $(a) && $(a).closest('label'); return shown(r); });
        out.push({
          id,
          mode: (spec && spec.mode) || 'platform',
          abilities: on,
          // a window is on offer if its bar button is there to press
          bar: [...document.querySelectorAll('#g-window-bar [data-open]')]
                 .filter(b => !b.hidden).map(b => b.dataset.open),
          entities: shown($('g-entities')),
          facing: shown($('g-dir') && $('g-dir').closest('label')),
          goal: ($('g-goal').selectedOptions[0] || {}).textContent || '',
        });
      }
      return out;
    }""", names)
    report['modes'] = {}

    for row in seen:
        mode = row['mode']
        want = CAN.get(mode)
        if want is None:
            issues.append(f"{row['id']}: unknown mode {mode}")
            continue
        report['modes'].setdefault(mode, row)
        got = set(row['abilities'])
        if got != want:
            issues.append(f"{row['id']} ({mode}) offers {sorted(got)}, should offer {sorted(want)}")
        # A window of dead controls should not be on the bar at all.
        if not want and 'abilities' in row['bar']:
            issues.append(f"{row['id']} ({mode}) still offers the Abilities window")
        if want and 'abilities' not in row['bar']:
            issues.append(f"{row['id']} ({mode}) hides Abilities but has {sorted(want)}")
        bodied = mode != 'blocks'
        if ('hero' in row['bar']) != bodied:
            issues.append(f"{row['id']} ({mode}) hero window on offer: {'hero' in row['bar']}")
        if row['entities'] != bodied:
            issues.append(f"{row['id']} ({mode}) entity palette shown: {row['entities']}")
        if row['facing'] != bodied:
            issues.append(f"{row['id']} ({mode}) facing shown: {row['facing']}")
        if not row['goal'].strip():
            issues.append(f"{row['id']} ({mode}) does not say how it ends")
        # No flag stands at the end of a bike course or a scrolling shooter.
        if mode in ('rider', 'racer', 'shmup') and 'flag' in row['goal'].lower():
            issues.append(f"{row['id']} ({mode}) says {row['goal']!r}, but has no flag")

    missing = sorted(set(CAN) - set(report['modes']))
    if missing:
        issues.append(f'no template reaches: {missing}')

    # Putting a window away because this game cannot use it must not lose it:
    # go back to a game that can, and it comes back.
    report['restore'] = page.evaluate("""() => {
      const bar = () => [...document.querySelectorAll('#g-window-bar [data-open]')]
                          .filter(b => !b.hidden).map(b => b.dataset.open);
      const pick = id => { const s = document.getElementById('g-template');
                           s.value = id; s.dispatchEvent(new Event('change', {bubbles:true})); };
      const all = Object.entries(window.NeoGameTemplates || {});
      const first = all.find(([, t]) => (t.mode || 'platform') === 'platform');
      const blocky = all.find(([, t]) => t.mode === 'blocks');
      if (!first || !blocky) return { skipped: true };
      pick(first[0]);
      NeoWindows.open('abilities');
      const beforeOpen = NeoWindows.isOpen('abilities');
      pick(blocky[0]);
      const hidden = !bar().includes('abilities');
      pick(first[0]);
      return { beforeOpen, hidden, back: NeoWindows.isOpen('abilities'), bar: bar() };
    }""")
    r = report['restore']
    if not r.get('skipped'):
        if not r['beforeOpen']: issues.append('could not open the Abilities window at all')
        if not r['hidden']: issues.append('a block game still lists Abilities on the bar')
        if not r['back']: issues.append('an open window did not come back when the game could use it')

    # The pieces a maze game is built from have to be in the palette.
    report['palette'] = page.evaluate("""() => {
      const ids = [...document.querySelectorAll('#g-entities .tilebtn')]
                    .map(b => b.dataset.piece.split(':')[1]);
      return ids;
    }""")
    for want in ('dot', 'pellet', 'ghost', 'invader', 'rival'):
        if want not in report['palette']:
            issues.append(f'{want} cannot be drawn by hand')

    if err: issues.append(f'page errors: {err[:3]}')
    b.close()

print(json.dumps({'report': report, 'issues': issues}, indent=2))
print('\nThe panel only offers what the game can honour.' if not issues else f'\n{len(issues)} issue(s).')
sys.exit(1 if issues else 0)
