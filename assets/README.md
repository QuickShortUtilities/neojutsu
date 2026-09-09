# Art

## `1bit-pack.png` — Kenney "1-Bit Pack"

A 49×22 grid of 16px cells, 1078 sprites: terrain, buildings, furniture,
characters, monsters, animals, weapons, items, UI icons and a full font.

Every pixel is the same near-white ink on transparency. That is the reason
this pack was chosen over a colour one: a silhouette can be tinted at draw
time, so one drawing serves a Game Boy, a C64 and a Genesis palette without
being redrawn per machine.

The file here is the source of record for attribution. The game itself does
not load it — `game-sprites.js` carries the same PNG inlined as a data URI,
because a packaged game is a single HTML file sent to a friend and a
`file://` page cannot fetch a sibling image.

Licence: CC0 (public domain). See `1bit-pack-LICENSE.txt`. Attribution is not
required but is offered here anyway: art by Kenney (kenney.nl).
