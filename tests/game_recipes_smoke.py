"""The script area: recipes, the rule builder, and what the generator writes.

A recipe that does not compile is worse than no recipe, and two recipes that
both use `on tick` must end up as one event rather than one replacing the other.
The builder has to emit something valid whatever the menus are set to.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json, sys, itertools
ROOT=Path('/Users/christophercohen/Documents/GitHub/neojutsu')
report={}; issues=[]

RUNS = """(code)=>{
  const cv=document.createElement('canvas'); cv.width=160; cv.height=96;
  const rows=[]; for(let y=0;y<18;y++){let r='';for(let x=0;x<40;x++) r+= (y>=15?'1':'0'); rows.push(r);}
  const g=window.NeoGame.create(cv,{mode:'platform',seed:'t',start:{x:16,y:100},lives:3,
    level:{w:40,h:18,tiles:rows.join('\\n')},
    entities:[{type:'coin',x:60,y:112},{type:'walker',x:100,y:110},{type:'goal',x:300,y:104}],
    rules:{collect:1}, script:code},{hud:false});
  for(let i=0;i<420;i++) g.tick(1/60);
  return {fault:g.scriptFault, state:g.state};
}"""

with sync_playwright() as p:
    b=p.chromium.launch(headless=True)
    page=b.new_context(viewport={"width":1512,"height":1250}).new_page()
    err=[]; page.on('pageerror',lambda e:err.append(str(e)))
    page.goto(ROOT.as_uri()+'/game.html'); page.wait_for_timeout(400)
    page.evaluate("localStorage.clear()"); page.reload(); page.wait_for_timeout(1300)
    if err: issues.append(f'load errors: {err[:2]}')

    # --- every recipe compiles and survives being played ---
    recipes = page.evaluate("()=>window.NeoRecipes.list.map(r=>({id:r.id,name:r.name,code:r.code}))")
    report['recipes'] = len(recipes)
    if len(recipes) < 12: issues.append(f'only {len(recipes)} recipes')
    for r in recipes:
        c = page.evaluate("(c)=>window.NeoScript.compile(c).errors", r['code'])
        if c: issues.append(f"recipe {r['id']} does not compile: {c[:2]}")
        run = page.evaluate(RUNS, r['code'])
        if run['fault']: issues.append(f"recipe {r['id']} faults when played: {run['fault']}")
    report['all_recipes_run'] = True

    # --- any pair merges into valid script with one block per event ---
    ids = [r['id'] for r in recipes]
    pairs = list(itertools.combinations(ids, 2))
    bad_pairs = page.evaluate("""(pairs)=>{
      const out=[];
      for (const [a,b] of pairs) {
        const m = window.NeoRecipes.merge([window.NeoRecipes.byId(a).code, window.NeoRecipes.byId(b).code]);
        const c = window.NeoScript.compile(m);
        const dupTick = (m.match(/^on tick$/gm)||[]).length > 1;
        const dupStart = (m.match(/^on start$/gm)||[]).length > 1;
        if (c.errors.length || dupTick || dupStart) out.push([a,b,c.errors.slice(0,1),dupTick,dupStart]);
      }
      return out;}""", pairs)
    report['pairs_checked'] = len(pairs)
    if bad_pairs: issues.append(f'{len(bad_pairs)} recipe pairs merge badly, e.g. {bad_pairs[:2]}')

    # --- the builder emits valid script for every combination of menus ---
    combos = page.evaluate("""()=>{
      const ev=[...document.getElementById('b-event').options].map(o=>o.value);
      const what=[...document.getElementById('b-what').options].map(o=>o.value);
      const act=[...document.getElementById('b-do').options].map(o=>o.value);
      const set=(id,v)=>{const e=document.getElementById(id); e.value=v; e.dispatchEvent(new Event('change',{bubbles:true}));};
      const bad=[]; let n=0;
      for (const e of ev) for (const w of what) for (const a of act) {
        set('b-event',e); set('b-what',w); set('b-do',a);
        document.getElementById('b-add').click();
        n++;
        const c = window.NeoScript.compile(document.getElementById('g-script').value);
        if (c.errors.length) bad.push([e,w,a,c.errors.slice(0,1)]);
        document.getElementById('g-script').value='';
      }
      return {n, bad};}""")
    report['builder_combinations'] = combos['n']
    if combos['bad']: issues.append(f"builder produced invalid script for {len(combos['bad'])} combinations, e.g. {combos['bad'][:2]}")

    # --- generated games get real rules, not just a greeting ---
    gen = page.evaluate("""()=>{
      const out=[];
      const prompts=['a hard volcano level','a timed run through ruins','a boss arena',
                     'an easy cave with a key and a door','a tall tower to climb','a sky level'];
      for (const p of prompts) {
        const g = window.NeoGameGen.generateValid(p);
        const c = window.NeoScript.compile(g.spec.script||'');
        const acts = Object.values(c.events || {}).reduce((n, b) => n + (b||[]).length, 0);
        out.push({p, events:Object.keys(c.events), errors:c.errors.length, acts,
                  lines:(g.spec.script||'').split('\\n').length});
      }
      return out;}""")
    report['generated_scripts'] = [{'prompt': g['p'][:26], 'events': g['events'],
                                    'statements': g['acts'], 'lines': g['lines']} for g in gen]
    for g in gen:
        if g['errors']: issues.append(f"generated script for {g['p']!r} does not compile")
        # Length is not the property worth asserting: the generator picks its
        # rules at random, so a short script is a fair outcome and this failed
        # about one run in four for no fault of the code. What matters is that
        # a generated game has logic in it at all.
        if not g['events']: issues.append(f"generated script for {g['p']!r} has no events")
        elif g['acts'] < 2: issues.append(f"generated script for {g['p']!r} does almost nothing ({g['acts']} statements)")
    variety = {tuple(sorted(g['events'])) for g in gen}
    report['distinct_event_sets'] = len(variety)
    if len(variety) < 2: issues.append('every generated script uses the same events')

    # --- clicking a recipe in the UI actually inserts it ---
    page.evaluate("()=>{document.getElementById('g-script').value='';}")
    page.locator('.recipe').first.click(); page.wait_for_timeout(500)
    after = page.eval_on_selector('#g-script','e=>e.value')
    report['click_inserts'] = len(after) > 20
    if len(after) < 20: issues.append('clicking a recipe inserted nothing')
    page.locator('.recipe').nth(3).click(); page.wait_for_timeout(500)
    merged = page.eval_on_selector('#g-script','e=>e.value')
    if len(merged) <= len(after): issues.append('a second recipe did not merge in')
    c = page.evaluate("(c)=>window.NeoScript.compile(c).errors", merged)
    if c: issues.append(f'two recipes clicked in the UI produced invalid script: {c[:2]}')

    if err: issues.append(f'errors: {err[:3]}')
    b.close()

print(json.dumps({'report':report,'issues':issues}, indent=2)[:2600])
if issues: print('\nFAILED'); sys.exit(1)
print('\nThe script area holds up.')
