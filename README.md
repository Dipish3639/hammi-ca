# hammi.ca

The front door at hammi.ca, in the House Edge logo's colours and style: 8-bit pixel type on a dark navy screen with CRT scanlines, cream text with hard dark outlines, and red accents. A pixel title screen over a drifting starfield, and the games shown as pixel panels on a "Select game" screen. Insert coin, Press start and hovering a game make little 8-bit sounds (Sound on/off in the top bar), and the 1UP score ticks up as you poke around. Try the Konami code.

It is one static file (`index.html`) with no build step and no dependencies besides two Google Fonts (Press Start 2P and VT323).

## Run it locally

```
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Put it on hammi.ca with GitHub Pages

1. In this repo, go to Settings, then Pages, and set the source to the `main` branch, root folder.
2. At your DNS provider, point the apex domain `hammi.ca` at GitHub with four `A` records:
   `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`.
3. Optionally add a `CNAME` record for `www` pointing to `dipish3639.github.io`.
4. Back in Settings, then Pages, wait for the DNS check to pass and turn on Enforce HTTPS.

The `CNAME` file in this repo tells GitHub Pages which domain to serve.

## Adding or editing a game

Each game is one `<li>` inside `<ul class="games">` in `index.html`. To add one, copy a whole `<li>` and change the name in the red band, the image in the screen and the description. If the game has a page or download, make the panel an `<a class="card" href="...">` (instead of a `<div class="card">`) and change the last line to say what the link does. Put images in `img/`. The screen is 4:3 and fits the image inside it without cropping, so logos on a transparent background look best.

## Changing it

- Colors are the custom properties at the top of the stylesheet.
- The sounds are the note lists (`COIN`, `START`, `HOVER`, `ONEUP`) in the script: each entry is a frequency and a length in seconds.
- Animations (flicker, blinking text and the stars) all stop for visitors who ask for reduced motion.
