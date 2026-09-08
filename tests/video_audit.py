"""Contract audit for the scene library.

Every scene has to hold up four promises: it animates, it listens to the music,
it honours the bg flag unless it genuinely cannot, and its `solid` flag matches
what it actually paints. Getting `solid` wrong is what makes layering feel
broken, so it is checked against measured transparency rather than trusted.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json, sys
ROOT=Path('/Users/christophercohen/Documents/GitHub/neojutsu')

AUDIT = """(keys) => {
  const S = window.NeoScene.SCENES, W = 160, H = 144;
  const cv = document.createElement('canvas'); cv.width=W; cv.height=H;
  const g = cv.getContext('2d', {willReadFrequently:true});
  const quiet = {level:0,bass:0,mid:0,treble:0,freq:[],wave:[]};
  const loud  = {level:.9,bass:.9,mid:.9,treble:.9,
                 freq:new Uint8Array(256).fill(200), wave:new Float32Array(512).fill(.4)};
  const sample = () => { const d=g.getImageData(0,0,W,H).data; let s=0, clear=0;
    for(let i=0;i<d.length;i+=4){ s=(s*31+d[i]+d[i+1]*3+d[i+2]*7+d[i+3]*11)|0; if(d[i+3]<8) clear++; }
    return {sig:s, clearFrac: clear/(W*H)}; };
  // Fresh state each run; scenes that integrate their own motion need several
  // steps before anything moves, so animation is steps-vs-steps, not t-vs-t.
  const run = (key, opts, env, steps) => {
    const def = S[key], st = def.init(window.NeoScene.rng('audit'), W, H, .5);
    g.clearRect(0,0,W,H);
    for (let i=0;i<steps;i++){ g.save(); def.draw(g, W, H, i/30, env, st, opts); g.restore(); }
    return sample();
  };
  const out = {};
  for (const key of keys) {
    const o = {speed:1, density:.5, step:1/30};
    const noBg   = run(key, {...o, bg:false}, quiet, 3);
    const withBg = run(key, {...o, bg:true},  quiet, 3);
    const short  = run(key, {...o, bg:true},  quiet, 1);
    const long   = run(key, {...o, bg:true},  quiet, 30);
    const q      = run(key, {...o, bg:true},  quiet, 6);
    const l      = run(key, {...o, bg:true},  loud,  6);
    out[key] = { solid: !!S[key].solid, cat: S[key].cat,
      clearFrac: +noBg.clearFrac.toFixed(3),
      bgFlagWorks: noBg.sig !== withBg.sig,
      animates: short.sig !== long.sig,
      reactive: q.sig !== l.sig };
  }
  return out;
}"""

with sync_playwright() as p:
    b=p.chromium.launch(headless=True)
    page=b.new_context().new_page()
    err=[]; page.on('pageerror',lambda e:err.append(str(e)))
    page.goto(ROOT.as_uri()+'/video.html'); page.wait_for_timeout(900)
    assert not err, err
    keys=page.evaluate("()=>Object.keys(window.NeoScene.SCENES)")
    res=page.evaluate(AUDIT, keys)
    b.close()

issues=[]
for k,v in res.items():
    if not v['animates']:  issues.append((k,'never animates'))
    if not v['reactive']:  issues.append((k,'ignores the audio envelope'))
    # A scene offered as an overlay must leave real transparency behind.
    if not v['solid'] and v['clearFrac'] < 0.35:
        issues.append((k, f"not marked solid but covers {100-v['clearFrac']*100:.0f}% of the frame"))
    # And one marked solid should not in fact be a sparse overlay.
    if v['solid'] and v['clearFrac'] > 0.80:
        issues.append((k, f"marked solid but leaves {v['clearFrac']*100:.0f}% transparent"))
    # Only a genuinely opaque scene is allowed to ignore the flag.
    if not v['bgFlagWorks'] and not v['solid']:
        issues.append((k,'ignores the bg flag but is not marked solid'))

summary = {'scenes': len(res), 'solid': sum(1 for v in res.values() if v['solid']),
           'overlays': sum(1 for v in res.values() if not v['solid']), 'issues': issues}
print(json.dumps(summary, indent=2))
if issues:
    print('\nFAILED: scene contract violations above')
    sys.exit(1)
print('\nAll scenes honour the contract.')
