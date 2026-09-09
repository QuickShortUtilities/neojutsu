/* Ready-made rules.
 *
 * The script box is powerful and empty, which is a bad combination - most people
 * will not invent "on tick / every 1 / set left left - 1" from a blank page. Each
 * recipe is a working rule you can drop in and then edit, and together they show
 * most of what the language can do.
 */
(() => {
  'use strict';

  const R = [
    { id: 'timer', name: 'Countdown', kanji: '時', tags: ['timed'],
      blurb: 'Lose when the clock runs out.',
      code: `on start
  set left 45
  message "45 SECONDS"
end
on tick
  every 1
    set left left - 1
    if left == 10
      message "10 LEFT"
    end
    if left <= 0
      lose
    end
  end
end` },

    /* Needs both halves of what it says: things to kill, and a door for
       clearing them to open. A well has neither, and a course has no door,
       so it announced "CLEAR THEM ALL" and opened nothing a frame later. */
    { id: 'bossgate', name: 'Clear the room', kanji: '闘', tags: ['boss', 'fight'],
      modes: ['platform', 'topdown'],
      blurb: 'The way out stays shut until every enemy is gone.',
      code: `on start
  message "CLEAR THEM ALL"
end
on tick
  if enemies == 0
    open
    message "THE WAY IS OPEN"
  end
end
on kill
  shake 3
end` },

    { id: 'rising', name: 'Rising lava', kanji: '溶', tags: ['hazard', 'chase'], modes: ['platform'],
      blurb: 'The floor turns to lava, one row at a time.',
      code: `on start
  set row 17
  set warned 0
end
on tick
  every 3
    if warned == 0
      message "IT IS RISING"
      set warned 1
    end
    set col 0
    while col < 40
      tile col row 14
      set col col + 1
    end
    set row row - 1
  end
end` },

    // Everywhere there is something to make quicker. In a well there is not.
    { id: 'speedup', name: 'Faster as you go', kanji: '速', tags: ['pace'],
      modes: ['platform', 'topdown', 'racer', 'shmup', 'scramble', 'rider', 'invaders'],
      blurb: 'Every pickup makes you quicker.',
      code: `on collect
  set pace 80 + score * 6
  speed pace
  if score == 5
    message "PICKING UP SPEED"
  end
end` },

    { id: 'moon', name: 'Low gravity', kanji: '月', tags: ['feel'], modes: ['platform'],
      blurb: 'Floaty jumps, like somewhere smaller than here.',
      code: `on start
  gravity 260
  message "LOW GRAVITY"
end` },

    /* Spawns at fixed tiles, so it needs a level big enough to hold them -
       and a formation game has its own idea of what a wave is. */
    { id: 'waves', name: 'Enemy waves', kanji: '波', tags: ['fight'],
      modes: ['platform', 'topdown'],
      blurb: 'Something new arrives every few seconds.',
      code: `on start
  set wave 0
end
on tick
  every 6
    set wave wave + 1
    spawn "walker" 30 12
    if wave >= 2
      spawn "flyer" 24 8
    end
    message "WAVE " + wave
  end
end` },

    { id: 'sudden', name: 'Sudden death', kanji: '死', tags: ['hard'],
      blurb: 'One mistake and it is over.',
      code: `on hurt
  shake 6
  lose
end` },

    { id: 'halfway', name: 'Halfway reward', kanji: '半', tags: ['pacing'],
      blurb: 'A life back when you are half done.',
      code: `on collect
  if score == 5
    heal 1
    message "HAVE A LIFE"
  end
end` },

    { id: 'panic', name: 'Escape sequence', kanji: '逃', tags: ['drama'],
      modes: ['platform', 'topdown'],
      blurb: 'Collect the last one and everything goes wrong.',
      code: `on collect
  if score >= 10
    message "RUN"
    shake 5
    speed 120
    spawn "chaser" 4 12
  end
end` },

    { id: 'combo', name: 'Reward a streak', kanji: '連', tags: ['scoring'],
      blurb: 'Keep collecting without being hit and gain more.',
      code: `on start
  set streak 0
end
on collect
  set streak streak + 1
  if streak >= 4
    give 2
    message "STREAK"
    set streak 0
  end
end
on hurt
  set streak 0
end` },

    { id: 'guide', name: 'Talk to the player', kanji: '導', tags: ['friendly'],
      blurb: 'Say something at the start, when hurt, and near the end.',
      // Only where there is a flag to find. A maze game is cleared, not crossed.
      wins: ['goal'],
      code: `on start
  message "FIND THE FLAG"
end
on hurt
  message "TRY AGAIN"
end
on collect
  if coins == 1
    message "ONE LEFT"
  end
end` },

    // Keys and doors exist in the two modes that have rooms.
    { id: 'jailbreak', name: 'Key opens the way', kanji: '鍵', tags: ['doors'],
      modes: ['platform', 'topdown'],
      blurb: 'Doors stay shut until a key is found.',
      code: `on start
  message "FIND THE KEY"
end
on collect
  if keys >= 1
    open
    message "IT OPENS"
  end
end` },

    { id: 'nudge', name: 'Push at the top', kanji: '風', tags: ['hazard'], modes: ['platform'],
      blurb: 'Wind pushes you while you are high up.',
      code: `on tick
  every 0.5
    if y < 6
      push 40 0
    end
  end
end` },

    { id: 'sweep', name: 'Clear the board', kanji: '掃', tags: ['friendly'], wins: ['clear'],
      blurb: 'For a game you finish by leaving nothing behind.',
      code: `on start
  message "EAT THEM ALL"
end
on collect
  if coins == 1
    message "ONE LEFT"
  end
end
on hurt
  message "THEY GOT ME"
end` },

    { id: 'blink', name: 'Vanishing ground', kanji: '瞬', tags: ['hazard'], modes: ['platform'],
      blurb: 'A block appears and disappears under you.',
      code: `on start
  set solid 1
end
on tick
  every 2
    if solid == 1
      tile 20 14 0
      set solid 0
    else
      tile 20 14 1
      set solid 1
    end
  end
end` },
  ];

  const byId = id => R.find(r => r.id === id);
  /* Some recipes only make sense one way up. Low gravity has nothing to say
     to an overhead game, and ground that vanishes under you needs a body that
     can fall. A recipe with no `modes` suits every mode. */
  const fitsMode = (rec, mode) => !rec || !rec.modes || rec.modes.includes(mode);
  /* And which ending. A recipe that says "find the flag" in a game with no
     flag in it is worse than no recipe: it sends the player looking for
     something that is not there, which is the whole complaint about these
     games all being one game. `win` is 'goal' or 'clear'. */
  const fitsWin = (rec, win) => !rec || !rec.wins || rec.wins.includes(win || 'goal');
  const forTags = tags => R.filter(r => r.tags.some(t => tags.includes(t)));

  // Joining scripts means merging their events, so two recipes that both use
  // `on tick` do not silently cancel each other out.
  function merge(scripts) {
    const events = {};
    for (const src of scripts) {
      const re = /on\s+(\w+)\s*\n([\s\S]*?)\nend\s*(?=on\s|\s*$)/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        (events[m[1]] = events[m[1]] || []).push(m[2].replace(/\s+$/, ''));
      }
    }
    return Object.entries(events)
      .map(([name, bodies]) => `on ${name}\n${bodies.join('\n')}\nend`)
      .join('\n\n');
  }

  window.NeoRecipes = { list: R, byId, forTags, merge, fitsMode, fitsWin };
})();
