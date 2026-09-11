/* Turn a typed request into the conditions the model actually has.
 *
 * "final boss", "peaceful forest, 64bpm, no drums", "sad ending in C minor".
 *
 * This is not a text encoder and does not pretend to be one. The model has
 * never seen a word; it conditions on eight discrete fields. This reads a
 * sentence and fills those fields in, and the caller is expected to SHOW what
 * it understood -- a prompt box that silently ignores half of what you typed
 * is worse than no prompt box, because you cannot tell which half.
 *
 * Scene vocabulary is deliberately the same as pipeline/scenes.py, which is
 * where the training labels came from. If the two drift, the box will accept
 * words the model was never taught.
 */
(function (global) {
  "use strict";

  // scene -> the words someone might type for it. First match wins, and the
  // list is ordered so "final boss" beats "battle".
  var SCENES = [
    ["boss",      ["final boss", "last boss", "boss fight", "boss battle", "boss", "showdown", "final battle"]],
    ["victory",   ["victory", "fanfare", "level clear", "stage clear", "you win", "triumph", "win"]],
    ["gameover",  ["game over", "gameover", "death", "defeat", "you died", "lose", "continue"]],
    ["ending",    ["ending", "credits", "epilogue", "staff roll", "finale", "closing"]],
    ["title",     ["title", "title screen", "opening", "intro", "menu screen", "main theme", "prologue"]],
    ["battle",    ["battle", "combat", "fight", "encounter", "war", "duel", "versus"]],
    ["chase",     ["chase", "escape", "race", "racing", "pursuit", "speed", "rush"]],
    ["menu",      ["menu", "shop", "store", "pause", "select", "options", "inventory", "equip"]],
    ["town",      ["town", "village", "city", "inn", "castle", "palace", "market", "home", "hub"]],
    ["dungeon",   ["dungeon", "cave", "cavern", "labyrinth", "maze", "tower", "temple", "ruins", "crypt", "underground"]],
    ["forest",    ["forest", "woods", "jungle", "garden", "grassland", "meadow", "nature", "tree"]],
    ["water",     ["water", "ocean", "sea", "underwater", "beach", "river", "lake", "aquatic", "marine"]],
    ["ice",       ["ice", "snow", "frozen", "winter", "glacier", "blizzard", "frost", "arctic"]],
    ["fire",      ["fire", "lava", "volcano", "magma", "flame", "desert", "inferno", "burning"]],
    ["sky",       ["sky", "cloud", "space", "heaven", "air", "flight", "moon", "cosmic", "galaxy", "stars"]],
    ["mystery",   ["mystery", "puzzle", "secret", "hidden", "horror", "spooky", "haunted", "eerie", "creepy", "ghost", "night"]],
    ["sad",       ["sad", "sorrow", "tearful", "lament", "requiem", "melancholy", "mournful", "grief", "farewell"]],
    ["overworld", ["overworld", "world map", "field", "map", "travel", "journey", "route", "adventure", "exploring", "exploration"]],
    ["stage",     ["stage", "level", "area", "zone", "round", "act", "platform", "platformer"]]
  ];

  // A scene implies a feel. These are starting points only: anything the text
  // states outright wins over them.
  var SCENE_FEEL = {
    boss:     {mood: "boss",  scale: "minor", bpm: 170, drums: "yes"},
    battle:   {mood: "boss",  scale: "minor", bpm: 160, drums: "yes"},
    chase:    {mood: "boss",  scale: "minor", bpm: 175, drums: "yes"},
    gameover: {mood: "dark",  scale: "minor", bpm: 90,  drums: null},
    sad:      {mood: "dark",  scale: "minor", bpm: 85,  drums: "no"},
    mystery:  {mood: "dark",  scale: "minor", bpm: 100, drums: null},
    dungeon:  {mood: "dark",  scale: "minor", bpm: 110, drums: null},
    ice:      {mood: "chill", scale: "minor", bpm: 100, drums: null},
    water:    {mood: "chill", scale: "major", bpm: 100, drums: null},
    forest:   {mood: "chill", scale: "major", bpm: 105, drums: null},
    sky:      {mood: "chill", scale: "major", bpm: 110, drums: null},
    town:     {mood: "chill", scale: "major", bpm: 115, drums: null},
    menu:     {mood: "title", scale: "major", bpm: 110, drums: "no"},
    title:    {mood: "title", scale: "minor", bpm: 130, drums: null},
    ending:   {mood: "title", scale: "major", bpm: 95,  drums: null},
    victory:  {mood: "stage", scale: "major", bpm: 150, drums: "yes"},
    overworld:{mood: "stage", scale: "major", bpm: 130, drums: null},
    stage:    {mood: "stage", scale: null,    bpm: 145, drums: "yes"},
    fire:     {mood: "stage", scale: "minor", bpm: 150, drums: "yes"}
  };

  var MOODS = [
    ["boss",  ["intense", "epic", "furious", "aggressive", "frantic", "urgent", "heavy"]],
    ["dark",  ["dark", "ominous", "sinister", "menacing", "grim", "tense", "moody", "sombre", "somber"]],
    ["chill", ["peaceful", "calm", "gentle", "relaxed", "serene", "quiet", "soft", "tranquil", "chill", "ambient", "sleepy"]],
    ["title", ["triumphant", "grand", "heroic", "noble", "majestic", "hopeful", "uplifting"]],
    ["stage", ["upbeat", "bouncy", "playful", "cheerful", "happy", "bright", "energetic", "catchy", "fun"]]
  ];

  var CHIPS = [
    ["nes",     ["nes", "famicom", "2a03", "nintendo"]],
    ["gameboy", ["game boy", "gameboy", "gb", "dmg"]],
    ["genesis", ["genesis", "mega drive", "megadrive", "ym2612", "sega"]],
    ["c64",     ["c64", "commodore", "sid"]]
  ];

  var NOTES = ["c", "c#", "d", "d#", "e", "f", "f#", "g", "g#", "a", "a#", "b"];
  var FLAT = {db: "C#", eb: "D#", gb: "F#", ab: "G#", bb: "A#"};
  var LEGAL_BARS = [2, 4, 8, 16, 32];

  function findFirst(table, text) {
    var best = null, at = Infinity;
    for (var i = 0; i < table.length; i++) {
      var name = table[i][0], words = table[i][1];
      for (var j = 0; j < words.length; j++) {
        var k = text.indexOf(words[j]);
        // whole words only: "sea" must not match "season", "air" not "chair"
        if (k < 0) continue;
        var before = k === 0 ? " " : text[k - 1];
        var after = text[k + words[j].length] || " ";
        if (/[a-z0-9]/.test(before) || /[a-z0-9]/.test(after)) continue;
        if (k < at) { at = k; best = name; }
      }
    }
    return best;
  }

  function parse(text) {
    var t = " " + String(text || "").toLowerCase().replace(/[^a-z0-9#\s]/g, " ")
              .replace(/\s+/g, " ") + " ";
    var out = {scene: null, mood: null, key: null, scale: null,
               bpm: null, bars: null, drums: null, chip: null, matched: []};
    if (!t.trim()) return out;

    out.scene = findFirst(SCENES, t);
    if (out.scene) out.matched.push(out.scene);
    out.chip = findFirst(CHIPS, t);

    var feel = out.scene ? SCENE_FEEL[out.scene] : null;

    // explicit wins over implied, always
    var mood = findFirst(MOODS, t);
    out.mood = mood || (feel && feel.mood) || null;
    if (mood) out.matched.push(mood);

    if (/\bminor\b|\bsad\b|\bdark\b/.test(t)) out.scale = "minor";
    else if (/\bmajor\b|\bhappy\b|\bbright\b/.test(t)) out.scale = "major";
    else if (/\bdorian\b/.test(t)) out.scale = "dorian";
    else if (/\bphrygian\b/.test(t)) out.scale = "phrygian";
    else if (/\bpentatonic\b|\bpent\b/.test(t)) out.scale = "pent";
    else out.scale = (feel && feel.scale) || null;

    // "in A minor", "c# major", "key of F"
    var km = t.match(/\b(?:in|key of)\s+([a-g])\s*(#|sharp|b|flat)?\b/) ||
             t.match(/\b([a-g])\s*(#|sharp|b|flat)?\s+(?:minor|major|dorian|phrygian)\b/);
    if (km) {
      var n = km[1], acc = km[2] || "";
      if (acc === "b" || acc === "flat") {
        out.key = FLAT[n + "b"] || n.toUpperCase();
      } else {
        out.key = n.toUpperCase() + (acc ? "#" : "");
      }
      if (NOTES.indexOf(out.key.toLowerCase()) < 0) out.key = null;
    }

    var bm = t.match(/\b(\d{2,3})\s*(?:bpm|beats)\b/) || t.match(/\bbpm\s*(\d{2,3})\b/);
    if (bm) out.bpm = parseInt(bm[1], 10);
    else if (/\bvery fast\b|\bfrantic\b|\bbreakneck\b/.test(t)) out.bpm = 190;
    else if (/\bfast\b|\bquick\b|\bupbeat\b|\bdriving\b/.test(t)) out.bpm = 165;
    else if (/\bvery slow\b|\bglacial\b/.test(t)) out.bpm = 80;
    else if (/\bslow\b|\brelaxed\b|\bgentle\b/.test(t)) out.bpm = 95;
    else out.bpm = (feel && feel.bpm) || null;

    var barm = t.match(/\b(\d{1,2})\s*bars?\b/);
    if (barm) {
      var want = parseInt(barm[1], 10);
      out.bars = LEGAL_BARS.reduce(function (a, b) {
        return Math.abs(b - want) < Math.abs(a - want) ? b : a;
      });
    } else if (/\blong\b|\bextended\b/.test(t)) out.bars = 16;
    else if (/\bshort\b|\bjingle\b|\bsting\b|\bbrief\b/.test(t)) out.bars = 4;

    if (/\bno drums\b|\bdrumless\b|\bwithout drums\b|\bno percussion\b|\bnothing on the noise/.test(t)) {
      out.drums = "no";
    } else if (/\bdrums\b|\bpercussion\b|\bbeat\b|\bdrum\b/.test(t)) {
      out.drums = "yes";
    } else {
      out.drums = feel ? feel.drums : null;
    }

    // The model was trained on 80-220 bpm and the Studio's slider matches, so
    // a request for 64 cannot be honoured. Clamp it, but record what was asked
    // for: quietly returning 80 to someone who typed 64 is the kind of small
    // lie that makes a prompt box untrustworthy.
    if (out.bpm != null) {
      var want = out.bpm;
      out.bpm = Math.max(80, Math.min(220, want));
      if (out.bpm !== want) out.bpmRequested = want;
    }

    return out;
  }

  /* A short human-readable line of what was understood, for showing back. */
  function describe(p) {
    var bits = [];
    if (p.scene) bits.push(p.scene);
    if (p.mood && p.mood !== p.scene) bits.push(p.mood);
    if (p.key || p.scale) bits.push([p.key, p.scale].filter(Boolean).join(" "));
    if (p.bpm) {
      bits.push(p.bpmRequested
        ? p.bpm + " bpm (" + p.bpmRequested + " is outside the model's 80–220)"
        : p.bpm + " bpm");
    }
    if (p.bars) bits.push(p.bars + " bars");
    if (p.drums === "no") bits.push("no drums");
    else if (p.drums === "yes") bits.push("drums");
    if (p.chip) bits.push(p.chip);
    return bits.length ? bits.join(" · ") : "nothing recognised — the model will choose";
  }

  global.OnjutsuPrompt = {parse: parse, describe: describe,
    scenes: SCENES.map(function (s) { return s[0]; })};
})(typeof self !== "undefined" ? self : this);
