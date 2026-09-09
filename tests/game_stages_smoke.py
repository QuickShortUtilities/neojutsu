"""A game is a run of stages, not one room.

What matters is that the run holds together: you keep what you earned, the
room does not, the last stage ends the game rather than looping, and a run
whose third stage is broken is refused before anyone plays the first.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json, sys
ROOT = Path('/Users/christophercohen/Documents/GitHub/neojutsu')
report = {}; issues = []

RUN = """() => {
  const t = k => JSON.parse(JSON.stringify(window.NeoGameTemplates[k]));
  const a = t('platformer'), c = t('ice'), d = t('tower');
  const stage = (name, s, cut) => ({ name, level: s.level, entities: s.entities,
                                     props: s.props, start: s.start, rules: { collect: 0 },
                                     ...(cut ? { cut } : {}) });
  return { name: 'A run', mode: 'platform', seed: 'run',
           sky0: a.sky0, sky1: a.sky1, player: a.player, lives: 5,
           levels: [stage('Meadow', a, 'HERE WE GO'), stage('Ice', c), stage('Tower', d)] };
}"""

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    page = b.new_context(viewport={"width": 1200, "height": 900}).new_page()
    err = []; page.on('pageerror', lambda e: err.append(str(e)))
    page.goto(ROOT.as_uri() + '/game.html'); page.wait_for_timeout(1700)

    # a single-level game is a run of one, and behaves as it always did
    report['solo'] = page.evaluate("""() => {
      const s = JSON.parse(JSON.stringify(window.NeoGameTemplates.platformer));
      const cv = document.createElement('canvas'); cv.width = 160; cv.height = 144;
      const g = window.NeoGame.create(cv, s, { hud: false });
      g.input.right = true; for (let i = 0; i < 120; i++) g.tick(1/60);
      return { stages: g.stages, stage: g.stage, state: g.state };
    }""")
    if report['solo']['stages'] != 1:
        issues.append(f"a one-level game reports {report['solo']['stages']} stages")

    # the run: advance by reaching each goal, and keep what was earned
    report['run'] = page.evaluate("""(mk) => {
      const run = (new Function('return ' + mk))()();
      const cv = document.createElement('canvas'); cv.width = 160; cv.height = 144;
      const g = window.NeoGame.create(cv, JSON.parse(JSON.stringify(run)), { hud: true });
      const trail = [];
      for (let n = 0; n < 3; n++) {
        const goal = (run.levels[g.stage].entities || []).find(e => e.type === 'goal');
        const before = { stage: g.stage, lives: g.lives, score: g.score };
        if (goal) { g.player.x = goal.x; g.player.y = goal.y; g.tick(1/60); }
        const atCut = { state: g.state, stage: g.stage };
        // the card must hold the simulation still
        const px = g.player.x;
        g.tick(0.5);
        const heldStill = Math.abs(g.player.x - px) < 0.01;
        for (let i = 0; i < 200; i++) g.tick(1/60);
        trail.push({ before, atCut, heldStill, after: { stage: g.stage, state: g.state, lives: g.lives } });
      }
      return { stages: g.stages, trail, finalState: g.state };
    }""", RUN)
    r = report['run']
    if r['stages'] != 3: issues.append(f"run has {r['stages']} stages, expected 3")
    for i, hop in enumerate(r['trail']):
        last = i == len(r['trail']) - 1
        if not last:
            if hop['atCut']['state'] != 'cut':
                issues.append(f"stage {i+1} did not show a card, went to {hop['atCut']['state']}")
            if not hop['heldStill']:
                issues.append(f"the card after stage {i+1} did not hold the game still")
            if hop['after']['stage'] != i + 1:
                issues.append(f"after stage {i+1} the run is on stage {hop['after']['stage']+1}")
        else:
            if hop['atCut']['state'] != 'won':
                issues.append(f"the last stage did not end the game ({hop['atCut']['state']})")
        if hop['after']['lives'] != 5:
            issues.append(f"lives changed across stage {i+1}: {hop['after']['lives']}")

    # what you earn carries; what the room holds does not
    report['carry'] = page.evaluate("""(mk) => {
      const run = (new Function('return ' + mk))()();
      const cv = document.createElement('canvas'); cv.width = 160; cv.height = 144;
      const g = window.NeoGame.create(cv, JSON.parse(JSON.stringify(run)), { hud: false });
      const coin = (run.levels[0].entities || []).find(e => e.type === 'coin');
      if (coin) { g.player.x = coin.x; g.player.y = coin.y; g.tick(1/60); }
      const gotOne = g.score;
      // The top rows of two different levels are both empty sky, so a
      // prefix proves nothing. Sum the whole map.
      const sum = t => { let n = 0; for (let i = 0; i < t.length; i++) n += t[i] * (i + 1); return n; };
      const tilesA = [g.level.w, g.level.h, sum(g.level.tiles)].join(',');
      const goal = (run.levels[0].entities || []).find(e => e.type === 'goal');
      g.player.x = goal.x; g.player.y = goal.y; g.tick(1/60);
      for (let i = 0; i < 200; i++) g.tick(1/60);
      return { gotOne, keptScore: g.score, stage: g.stage,
               levelChanged: [g.level.w, g.level.h, sum(g.level.tiles)].join(',') !== tilesA };
    }""", RUN)
    c = report['carry']
    if c['gotOne'] < 1: issues.append('collecting a coin scored nothing')
    if c['keptScore'] < c['gotOne']: issues.append('score was lost crossing a stage')
    if not c['levelChanged']: issues.append('the level did not change between stages')

    # a run is only as sound as its worst stage
    report['validate'] = page.evaluate("""(mk) => {
      const base = () => (new Function('return ' + mk))()();
      const out = {};
      out.goodOk = window.NeoGame.validate(base()).ok;
      let s = base(); s.levels[2].level = { w: 0, h: 0, tiles: '' };
      const broken = window.NeoGame.validate(s);
      out.brokenOk = broken.ok;
      out.namesStage = broken.errors.some(e => e.indexOf('stage 3') === 0);
      s = base(); s.levels = []; out.emptyOk = window.NeoGame.validate(s).ok;
      s = base(); s.levels[1].cut = 42; out.badCutOk = window.NeoGame.validate(s).ok;
      return out;
    }""", RUN)
    v = report['validate']
    if not v['goodOk']: issues.append('a sound run was refused')
    if v['brokenOk']: issues.append('a run with a broken third stage was accepted')
    if not v['namesStage']: issues.append('the error does not say which stage is broken')
    if v['emptyOk']: issues.append('a run with no stages was accepted')
    if v['badCutOk']: issues.append('a cut card that is not text was accepted')

    if err: issues.append(f'page errors: {err[:3]}')
    b.close()

print(json.dumps({'report': report, 'issues': issues}, indent=2))
print('\nA run holds together.' if not issues else f'\n{len(issues)} issue(s).')
sys.exit(1 if issues else 0)
