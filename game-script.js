/* NeoScript: a tiny language for game rules.
 *
 * Deliberately not JavaScript. There is no eval, no Function constructor, no
 * access to the page, the network, storage or the engine's internals - a script
 * can only read a fixed set of numbers and call a fixed set of actions. That is
 * what makes it safe to run a stranger's game: the worst a hostile script can
 * do is make a bad game.
 *
 * Every run is also bounded. Loops and total steps are capped, so a script
 * cannot hang the tab, and errors are reported rather than thrown.
 */
(() => {
  'use strict';

  const MAX_STEPS = 4000;      // per event, across all loops
  const MAX_DEPTH = 24;
  const EVENTS = ['start', 'tick', 'collect', 'hurt', 'kill', 'land', 'win', 'lose'];

  // Read-only facts a script may consult.
  const READS = ['score', 'keys', 'lives', 'time', 'x', 'y', 'vx', 'vy',
                 'enemies', 'coins', 'deaths', 'grounded', 'facing', 'random'];

  // Actions a script may take, with how many arguments each expects.
  // A number is an exact arity; a pair is a range, for commands that read
  // better with an optional extra - `talk "hello"` and `talk "guard" "halt"`.
  const ACTIONS = {
    message: 1, win: 0, lose: 0, open: 0, give: 1, hurt: 0, heal: 1,
    spawn: 3, tile: 3, warp: 2, push: 2, gravity: 1, speed: 1, shake: 1, print: 1,
    talk: [1, 2],
    /* Sequencing. Without a wait a script has no time in it, so nothing can
       happen after something else - no cutscene, no boss pattern, no door
       that opens a beat after the switch. */
    wait: 1,
    /* Actors. In a real game most of the script is aimed at a named thing in
       the level: move it, stop it, hide it, arm it. Every entity can carry a
       tag, and these address it. */
    move: 3, stop: 1, hide: 1, show: 1, face: 2, setsprite: 2, remove: 1,
    shoot: [1, 2],

  };

  // ---------- tokeniser ----------
  function lex(src) {
    const out = [];
    /* The skip is whitespace that is not a newline. With a plain \s* the
       prefix ate every line break before the group could match one, so the
       `\n` alternative never fired and skipNL() had nothing to skip - the
       language looked line-based but was not. A statement that may take an
       optional extra value needs the line ending to know where to stop. */
    const re = /[^\S\n]*("(?:[^"\\]|\\.)*"|>=|<=|==|!=|[-+*/%()<>]|\n|[A-Za-z_][A-Za-z_0-9]*|\d+(?:\.\d+)?|#[^\n]*)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const t = m[1];
      if (t.startsWith('#')) continue;                       // comment
      out.push({ v: t, i: m.index });
      if (re.lastIndex === m.index) re.lastIndex++;
    }
    return out;
  }

  // ---------- parser ----------
  // Statements are one per line; blocks close with `end`. Small enough to hold
  // in your head, which is the point.
  function parse(src) {
    const toks = lex(src);
    const errors = [];
    let p = 0, everyId = 0;
    const peek = () => (toks[p] ? toks[p].v : null);
    const next = () => (toks[p] ? toks[p++].v : null);
    const skipNL = () => { while (peek() === '\n') p++; };
    const expect = v => { if (peek() === v) { p++; return true; } errors.push(`expected "${v}"`); return false; };

    function primary() {
      const t = next();
      if (t === null) { errors.push('unexpected end'); return { k: 'num', v: 0 }; }
      if (t === '(') { const e = expr(); expect(')'); return e; }
      if (t === '-') return { k: 'neg', a: primary() };
      if (t === 'not') return { k: 'not', a: primary() };
      if (/^"/.test(t)) return { k: 'str', v: t.slice(1, -1).replace(/\\(.)/g, '$1') };
      if (/^\d/.test(t)) return { k: 'num', v: parseFloat(t) };
      if (/^[A-Za-z_]/.test(t)) return { k: 'var', v: t };
      errors.push(`unexpected "${t}"`);
      return { k: 'num', v: 0 };
    }
    const LEVELS = [['or'], ['and'], ['==', '!=', '<', '>', '<=', '>='], ['+', '-'], ['*', '/', '%']];
    function binary(level) {
      if (level >= LEVELS.length) return primary();
      let left = binary(level + 1);
      while (LEVELS[level].includes(peek())) {
        const op = next();
        left = { k: 'bin', op, a: left, b: binary(level + 1) };
      }
      return left;
    }
    const expr = () => binary(0);

    function block(stop) {
      const body = [];
      for (;;) {
        skipNL();
        const t = peek();
        if (t === null) break;
        if (stop.includes(t)) break;
        body.push(statement());
      }
      return body;
    }

    function statement() {
      const t = next();
      if (t === 'set') {
        const name = next();
        if (!/^[A-Za-z_]/.test(name || '')) errors.push('set needs a name');
        return { k: 'set', name, value: expr() };
      }
      if (t === 'if') {
        const cond = expr();
        const then = block(['else', 'end']);
        let other = [];
        if (peek() === 'else') { next(); other = block(['end']); }
        expect('end');
        return { k: 'if', cond, then, other };
      }
      if (t === 'while') {
        const cond = expr();
        const body = block(['end']);
        expect('end');
        return { k: 'while', cond, body };
      }
      if (t === 'every') {                     // every N seconds ... end
        const secs = expr();
        const body = block(['end']);
        expect('end');
        // The timer lives in the script's variables, not on this node, so
        // restarting the game restarts the clock too.
        return { k: 'every', secs, body, id: everyId++ };
      }
      if (t === 'do') {
        const name = peek();
        if (!name || !/^[A-Za-z_]/.test(name)) { errors.push('do needs the name of a routine'); return { k: 'noop' }; }
        next();
        return { k: 'do', name };
      }
      if (Object.prototype.hasOwnProperty.call(ACTIONS, t)) {
        const args = [];
        const want = ACTIONS[t];
        const lo = Array.isArray(want) ? want[0] : want;
        const hi = Array.isArray(want) ? want[1] : want;
        for (let i = 0; i < hi; i++) { if (peek() === '\n' || peek() === null) break; args.push(expr()); }
        if (args.length < lo || args.length > hi) {
          errors.push(lo === hi
            ? `${t} takes ${hi} value${hi === 1 ? '' : 's'}`
            : `${t} takes ${lo} or ${hi} values`);
        }
        return { k: 'call', name: t, args };
      }
      errors.push(`unknown command "${t}"`);
      while (peek() !== '\n' && peek() !== null) next();
      return { k: 'noop' };
    }

    const events = {}, routines = {};
    for (;;) {
      skipNL();
      if (peek() === null) break;
      // A routine is a piece of the game you can name and use more than once,
      // which is how a game gets built out of parts instead of one long list.
      if (peek() === 'define') {
        next();
        const name = next();
        if (!name || !/^[A-Za-z_]/.test(name)) errors.push('define needs a name');
        const body = block(['end']);
        expect('end');
        if (name) routines[name] = body;
        continue;
      }
      if (peek() !== 'on') { errors.push(`expected "on" or "define", found "${peek()}"`); next(); continue; }
      next();
      const name = next();
      if (!EVENTS.includes(name)) errors.push(`unknown event "${name}"`);
      const body = block(['end']);
      expect('end');
      (events[name] = events[name] || []).push(...body);
    }
    // A routine that is used but never written is a typo, and finding it at
    // compile time is better than finding it when the boss does not appear.
    const seen = new Set();
    (function scan(list) {
      for (const st of list || []) {
        if (!st) continue;
        if (st.k === 'do') { seen.add(st.name); if (!routines[st.name]) errors.push(`no routine called "${st.name}"`); }
        scan(st.then); scan(st.other); scan(st.body);
      }
    })([].concat(...Object.values(events), ...Object.values(routines)));
    return { events, routines, errors };
  }

  // ---------- interpreter ----------
  /* Running a script is no longer "do all of it now".

     A game needs time in it: open the gate, wait, then let the water in. So a
     firing becomes a thread that the engine steps, and `wait` suspends it
     until the clock catches up. Everything else - conditions, loops, routines
     - is the same language it was, but it can now be spread across seconds
     instead of happening in one indivisible instant. */
  function makeThread(program, event, env) {
    const body = program && program.events && program.events[event];
    if (!body || !body.length) return null;
    const routines = (program && program.routines) || {};
    const vars = env.vars;
    let steps = 0;

    const read = name => {
      if (name === 'random') return env.random();
      if (READS.includes(name)) return env.read(name);
      if (name === 'true') return 1;
      if (name === 'false') return 0;
      return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : 0;
    };

    function ev(node, depth) {
      if (++steps > MAX_STEPS) throw new RangeError('script ran too long');
      if (depth > MAX_DEPTH) throw new RangeError('script nested too deeply');
      switch (node.k) {
        case 'num': case 'str': return node.v;
        case 'var': return read(node.v);
        case 'neg': return -ev(node.a, depth + 1);
        case 'not': return ev(node.a, depth + 1) ? 0 : 1;
        case 'bin': {
          const a = ev(node.a, depth + 1);
          if (node.op === 'and') return a ? (ev(node.b, depth + 1) ? 1 : 0) : 0;
          if (node.op === 'or') return a ? 1 : (ev(node.b, depth + 1) ? 1 : 0);
          const b = ev(node.b, depth + 1);
          switch (node.op) {
            case '+': return (typeof a === 'string' || typeof b === 'string') ? String(a) + String(b) : a + b;
            case '-': return a - b; case '*': return a * b;
            case '/': return b === 0 ? 0 : a / b;
            case '%': return b === 0 ? 0 : a % b;
            case '==': return a === b ? 1 : 0; case '!=': return a !== b ? 1 : 0;
            case '<': return a < b ? 1 : 0;  case '>': return a > b ? 1 : 0;
            case '<=': return a <= b ? 1 : 0; case '>=': return a >= b ? 1 : 0;
          }
          return 0;
        }
      }
      return 0;
    }

    function* exec(list, depth) {
      for (const st of list) {
        if (++steps > MAX_STEPS) throw new RangeError('script ran too long');
        switch (st.k) {
          case 'set': vars[st.name] = ev(st.value, depth); break;
          case 'if':
            if (ev(st.cond, depth)) yield* exec(st.then, depth + 1);
            else yield* exec(st.other, depth + 1);
            break;
          case 'while': {
            let guard = 0;
            while (ev(st.cond, depth)) {
              yield* exec(st.body, depth + 1);
              if (++guard > 500) throw new RangeError('loop ran too long');
            }
            break;
          }
          case 'every': {
            // Waits a full interval before the first run. Firing at zero made
            // "every 3 seconds, flood a row" flood one before anyone had moved.
            const now = env.read('time'), gap = ev(st.secs, depth) || 1;
            const key = '__every' + st.id;
            const last = Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : 0;
            if (now - last >= gap) { vars[key] = now; yield* exec(st.body, depth + 1); }
            break;
          }
          case 'do': {
            if (depth > MAX_DEPTH) throw new RangeError('script nested too deeply');
            yield* exec(routines[st.name] || [], depth + 1);
            break;
          }
          case 'call': {
            const args = st.args.map(a => ev(a, depth));
            if (st.name === 'wait') { yield Math.max(0, Math.min(60, +args[0] || 0)); break; }
            env.act(st.name, args);
            break;
          }
        }
      }
    }

    return { gen: exec(body, 0), wait: 0, done: false, event, fault: '',
             // The step budget is per resume, so a thread that lives for a
             // minute is not starved by what it did a minute ago.
             fresh() { steps = 0; } };
  }

  // One frame of one thread. Returns whether it is still going.
  function resume(thread, dt) {
    if (!thread || thread.done) return false;
    if (thread.wait > 0) {
      thread.wait -= dt;
      if (thread.wait > 0) return true;
    }
    thread.fresh();
    try {
      const r = thread.gen.next();
      if (r.done) { thread.done = true; return false; }
      const secs = +r.value || 0;
      thread.wait = secs > 0 ? secs : 0;
      return true;
    } catch (e) {
      thread.done = true;
      thread.fault = e && e.message ? e.message : String(e);
      return false;
    }
  }

  /* The old contract: run the whole thing now. Kept because per-frame logic
     wants it and because a wait has no meaning in something that must finish
     inside one frame. Waits collapse to nothing here. */
  function run(program, event, env) {
    const t = makeThread(program, event, env);
    if (!t) return;
    for (let i = 0; i < 512; i++) {
      t.fresh();
      let r;
      try { r = t.gen.next(); }
      catch (e) { env.fault(e && e.message ? e.message : String(e)); return; }
      if (r.done) return;
    }
    env.fault('script ran too long');
  }

  const compile = src => {
    const r = parse(String(src || ''));
    return { events: r.events, routines: r.routines, errors: r.errors,
             empty: !Object.keys(r.events).length };
  };

  window.NeoScript = { compile, run, makeThread, resume, EVENTS, READS, ACTIONS, MAX_STEPS };
})();
