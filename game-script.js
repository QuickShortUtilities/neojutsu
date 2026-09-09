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
  const ACTIONS = {
    message: 1, win: 0, lose: 0, open: 0, give: 1, hurt: 0, heal: 1,
    spawn: 3, tile: 3, warp: 2, push: 2, gravity: 1, speed: 1, shake: 1, print: 1,
  };

  // ---------- tokeniser ----------
  function lex(src) {
    const out = [];
    const re = /\s*("(?:[^"\\]|\\.)*"|>=|<=|==|!=|[-+*/%()<>]|\n|[A-Za-z_][A-Za-z_0-9]*|\d+(?:\.\d+)?|#[^\n]*)/g;
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
      if (Object.prototype.hasOwnProperty.call(ACTIONS, t)) {
        const args = [];
        const want = ACTIONS[t];
        for (let i = 0; i < want; i++) { if (peek() === '\n' || peek() === null) break; args.push(expr()); }
        if (args.length !== want) errors.push(`${t} takes ${want} value${want === 1 ? '' : 's'}`);
        return { k: 'call', name: t, args };
      }
      errors.push(`unknown command "${t}"`);
      while (peek() !== '\n' && peek() !== null) next();
      return { k: 'noop' };
    }

    const events = {};
    for (;;) {
      skipNL();
      if (peek() === null) break;
      if (peek() !== 'on') { errors.push(`expected "on", found "${peek()}"`); next(); continue; }
      next();
      const name = next();
      if (!EVENTS.includes(name)) errors.push(`unknown event "${name}"`);
      const body = block(['end']);
      expect('end');
      (events[name] = events[name] || []).push(...body);
    }
    return { events, errors };
  }

  // ---------- interpreter ----------
  function run(program, event, env) {
    const body = program && program.events && program.events[event];
    if (!body || !body.length) return;
    let steps = 0;
    const vars = env.vars;

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

    function exec(list, depth) {
      for (const st of list) {
        if (++steps > MAX_STEPS) throw new RangeError('script ran too long');
        switch (st.k) {
          case 'set': vars[st.name] = ev(st.value, depth); break;
          case 'if':
            if (ev(st.cond, depth)) exec(st.then, depth + 1);
            else exec(st.other, depth + 1);
            break;
          case 'while': {
            let guard = 0;
            while (ev(st.cond, depth)) {
              exec(st.body, depth + 1);
              if (++guard > 500 || steps > MAX_STEPS) throw new RangeError('loop ran too long');
            }
            break;
          }
          case 'every': {
            // Waits a full interval before the first run. Firing at zero made
            // "every 3 seconds, flood a row" flood one before anyone had moved.
            const now = env.read('time'), gap = ev(st.secs, depth) || 1;
            const key = '__every' + st.id;
            const last = Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : 0;
            if (now - last >= gap) { vars[key] = now; exec(st.body, depth + 1); }
            break;
          }
          case 'call': env.act(st.name, st.args.map(a => ev(a, depth))); break;
        }
      }
    }

    try { exec(body, 0); }
    catch (e) { env.fault(e && e.message ? e.message : String(e)); }
  }

  const compile = src => {
    const r = parse(String(src || ''));
    return { events: r.events, errors: r.errors, empty: !Object.keys(r.events).length };
  };

  window.NeoScript = { compile, run, EVENTS, READS, ACTIONS, MAX_STEPS };
})();
