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
