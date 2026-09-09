"""A chip filter has to keep light things light.

The Game Boy's four colours are separated by nothing but brightness, so a
pixel's brightness is the only thing that can say which of them it belongs
to. Matching on raw colour distance instead sent the studio's own cyan to the
second-darkest green - a hero came out darker than the ground he stood on,
and one in eight generated games was thrown out for being unreadable. So:
brightness order in, brightness order out, on every chip that is a ramp; and
the colour chips keep the distance match that suits them.
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

with sync_playwright() as pw:
    b = pw.chromium.launch()
    page = b.new_page()
    err = []
    page.on('pageerror', lambda e: err.append(str(e)))
    page.goto(f'http://127.0.0.1:{port}/game.html')
    page.wait_for_function('!!window.NeoPalette', timeout=20000)

    report['chips'] = page.evaluate("""() => {
      const lum = c => c[0]*0.299 + c[1]*0.587 + c[2]*0.114;
      const out = {};
      for (const key of Object.keys(NeoPalette.PALETTES)) {
        const pal = NeoPalette.paletteRGB(key);
        const ls = pal.map(lum).sort((a,b) => a-b);
        let gap = Infinity;
        for (let i = 1; i < ls.length; i++) gap = Math.min(gap, ls[i] - ls[i-1]);
        // Push a ramp of greys through the filter and see what comes back.
        const cv = document.createElement('canvas'); cv.width = 16; cv.height = 1;
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        for (let i = 0; i < 16; i++) {
          const v = Math.round(i * 255 / 15);
          ctx.fillStyle = `rgb(${v},${v},${v})`; ctx.fillRect(i, 0, 1, 1);
        }
        NeoPalette.snap(ctx, 16, 1, { chip: key, dither: 'none' });
        const d = ctx.getImageData(0, 0, 16, 1).data;
        const got = [];
        for (let i = 0; i < 16; i++) got.push(Math.round(lum([d[i*4], d[i*4+1], d[i*4+2]])));
        let monotonic = true;
        for (let i = 1; i < got.length; i++) if (got[i] < got[i-1]) monotonic = false;
        out[key] = { minGap: Math.round(gap * 10) / 10, monotonic, ramp: got };
      }
      return out;
    }""")

    # A grey ramp must never come back out of order on any chip.
    for chip, c in report['chips'].items():
        if not c['monotonic']:
            issues.append(f'{chip}: a grey ramp came back out of order - {c["ramp"]}')

    # And on the Game Boy specifically, bright things must stay bright.
    report['bright'] = page.evaluate("""() => {
      const lum = c => c[0]*0.299 + c[1]*0.587 + c[2]*0.114;
      const pal = NeoPalette.paletteRGB('gameboy');
      const lightest = Math.max(...pal.map(lum)), darkest = Math.min(...pal.map(lum));
      const cv = document.createElement('canvas'); cv.width = 4; cv.height = 1;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      // the studio's own colours, which is where this went wrong
      const inks = ['#2ef2ff', '#ff2e88', '#ffd23f', '#0a0714'];
      inks.forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(i, 0, 1, 1); });
      NeoPalette.snap(ctx, 4, 1, { chip: 'gameboy', dither: 'none' });
      const d = ctx.getImageData(0, 0, 4, 1).data;
      const out = {};
      inks.forEach((c, i) => { out[c] = Math.round(lum([d[i*4], d[i*4+1], d[i*4+2]])); });
      return { out, lightest: Math.round(lightest), darkest: Math.round(darkest) };
    }""")
    br = report['bright']
    for ink, got in br['out'].items():
        if ink == '#0a0714':
            if got != br['darkest']:
                issues.append(f'near-black {ink} came back at {got}, not the darkest shade')
        elif got <= (br['lightest'] + br['darkest']) / 2:
            issues.append(f'the bright ink {ink} came back at {got}, in the dark half of the palette')

    if err:
        issues.append(f'page errors: {err[:3]}')
    b.close()

print(json.dumps({'report': report, 'issues': issues}, indent=2))
print('\nThe chip filter keeps light things light.' if not issues else f'\n{len(issues)} issue(s).')
sys.exit(1 if issues else 0)
