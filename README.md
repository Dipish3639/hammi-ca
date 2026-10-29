# hammi.ca

The front door at hammi.ca, styled like an arcade: a pixel title screen over a drifting starfield and a neon grid floor, CRT scanlines across everything, and the games shown as arcade cabinets on a "Select game" screen. Insert coin, Press start and hovering a cabinet make little 8-bit sounds (Sound on/off in the top bar), and the 1UP score ticks up as you poke around. Try the Konami code.

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

Each game is one `<li>` inside `<ul class="cabinets">` in `index.html`. To add one, copy a whole `<li>` and change the marquee name, the image in the screen and the description. If the game has a page or download, make the cabinet an `<a class="cab" href="...">` (instead of a `<div class="cab">`) and change the last line to say what the link does. Add the class `cyan` to a cabinet to make it cyan instead of pink. Put images in `img/`. The screen is 4:3 and fits the image inside it without cropping, so logos on a transparent background look best.

## Changing it

- Colors are the custom properties at the top of the stylesheet.
- The sounds are the note lists (`COIN`, `START`, `HOVER`, `ONEUP`) in the script: each entry is a frequency and a length in seconds.
- Animations (flicker, blinking text, the moving floor and the stars) all stop for visitors who ask for reduced motion.
