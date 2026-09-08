# NEO術 — NeoJutsu

**New art. Old chips.**

NeoJutsu is a music model built from zero weights to compose original chiptune. It learns from ~26,000 game soundtracks across 19 consoles (NES, SNES, Game Boy, Genesis, C64, Neo-Geo, and more) and writes new tracks in the voice of the hardware.

This repository holds the website at [neojutsu.com](https://neojutsu.com).

## Site

Plain static HTML, CSS and JavaScript. No build step.

- `index.html` — the page
- `style.css` — styling
- `script.js` — four-voice Web Audio chip synth demo and visualizer

Open `index.html` in a browser, or serve the folder with any static host (GitHub Pages, Cloudflare Pages, Netlify).

## Model

The model is trained separately and is not in this repo yet.

1. **Dataset** — VGMusic transcriptions per console, NES-MDB exact rips, Lakh MIDI for pretraining. ~205k MIDI files total.
2. **Pretrain** on Lakh (general music structure).
3. **Fine-tune** on the chiptune corpus with a console tag per track.
4. **Render** through emulated sound chips.

## Status

- [x] Dataset collected and organised
- [x] Website
- [ ] Clean and tokenize
- [ ] Train
- [ ] Generator on the site


## Studio

Open `studio.html` directly or serve the repository with a static host. The studio includes:

- A session bar with title, playback, tempo and an 出 Export dialog (format, quality, range, repeats, with a live summary of what you'll get).
- MP3 at 128, 192 or 320 kbps, stereo WAV, and MIDI downloads. MP3/WAV render the same chip synth and effects used for playback, with full-pattern or selected-bar export and optional effects tails. MIDI includes volume/pan controllers; the receiving instrument determines its sound.
- **Six voices** (Pulse 1-4, Triangle, Noise) with volume, pan, mute, solo, level meters and master volume.
- A **ten-piece drum kit** on the noise voice: kick, snare, closed and open hat, low and high tom, crash, rim, cowbell and zap. Engines place fills every fourth bar. Exported to and imported from General MIDI percussion.
- Patterns up to **64 bars**. The roll shows a window of the pattern with ‹ › paging, a bars-visible zoom and a follow-playback toggle, and narrows the window automatically on small screens so steps stay tappable.
- Selected-bar looping, copying a melodic voice into another voice, and doubling patterns up to 64 bars. Copying replaces the target notes and effects and can be undone.
- Undo/redo for notes, generation, title, mixer and effects. Space plays/stops, 1–4 select voices, L toggles looping, and Cmd/Ctrl Z / Shift Z undo/redo. Arrow keys navigate voice tabs.
- Browser autosave and named saves. A valid share link takes precedence over a draft. Storage failures are shown in the UI.
- A collapsible effects/file panel and a responsive layout.
- **MIDI import**: drop any `.mid` on the roll (or use Import MIDI). The busiest melodic parts map to Pulse 1-4 (highest first) and Triangle (lowest); channel 10 becomes Noise. Quantised to 16ths, durations kept as held notes, first 64 bars. `midi-import.js` is dependency-free.
- A master **effects rack** of eight units in one chain: Equaliser, Compressor, Phaser, Flanger, Bitcrush, Reverb, Stereo width and Echo. Each opens in its own draggable window with drag-to-turn dials. 26 of the 29 dials support **motion**: a tempo-synced LFO (sine, triangle, square or saw) at 1/4 bar to 8 bars, with adjustable depth. Rack settings live in the pattern, so they save, share and export; motion runs identically in playback and in the offline MP3/WAV render.
- Per-voice **instrument** (10: pulse widths, triangle, GB wave, SID saw, FM lead/bass/bell/organ), **envelope** (hold, pluck, pad, stab), **vibrato**, **tremolo**, **slide**, **arpeggio** (stepped at 60 Hz like the hardware trick) and **echo send**. **Swing** and **bit-crush** on the master.
- Three rule engines: 型 kata-A (motif & variation), kata-B (chords & sustain), kata-C (arcade arps). Each arranges across all six voices, adding a counter-melody and a pad. The trained model plugs in as another engine.

Audio stays in the browser. `audio-export.js` loads the bundled, unmodified `vendor/lame-1.2.1.min.js` on the first MP3 export; no encoding service is used. The library is LGPL-3.0; see `vendor/README.md` and the included license files, linked from the studio footer as required.

### Browser checks

With Python 3 and Playwright installed (`python3 -m pip install playwright` and `python3 -m playwright install chromium`), run:

```sh
python3 tests/studio_smoke.py
```

The checks exercise editing/history, reload recovery, mixing, loop playback, all chip renderers, MP3 quality options, MP3 decoding, audio/MIDI downloads, corrupted storage/link handling, and mobile layout. Screenshots and exported audio are written to a temporary directory printed in the result. Tests use a fresh browser context and do not access your browser's saved sessions.
