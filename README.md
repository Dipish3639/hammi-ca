# hammi.ca

The front door at hammi.ca: a blurred pond fills the whole background, ripples behind your pointer anywhere on the page, and chimes where you tap. Notes come from a major pentatonic scale (left to right climbs the scale, higher up the pond is higher pitched), so any combination sounds fine.

The water is a real wave simulation: each frame solves the 2D wave equation on a small grid, then shades it with refraction of the pond floor, a sun glint and a sky reflection. It is one static file (`index.html`) with no build step and no dependencies besides two Google Fonts.

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

## Changing it

- Colors are the five custom properties at the top of the stylesheet.
- The scale is the `SEMITONES` array in the script. Swap in `[0, 3, 5, 7, 10]` for a minor pentatonic.
- `--blur` at the top of the stylesheet sets how soft the water background is (set it to `0px` for sharp water).
- The page is one screen and sets `touch-action: none` on `body` so finger drags ripple the water. If you add enough content to scroll, remove that line.
- The water look is the block of constants under "water look: tweak these" in the script:
  - `DAMPING` is how long ripples last (closer to 1 lasts longer).
  - `STEPS_PER_FRAME` is how fast waves travel.
  - `REFRACT` and `SLOPE` control how much ripples bend the floor and how steep they look.
  - `SPEC_POWER` sets how tight the sun glints are.
- The pond floor (colors and the soft light patches) is built in `buildFloor()`.
