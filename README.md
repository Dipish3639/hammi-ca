# hammi.ca

The front door at hammi.ca: a pond of dots that ripples and chimes where you tap. Every dot is a note from a major pentatonic scale, so any combination sounds fine.

It is one static file (`index.html`) with no build step and no dependencies besides two Google Fonts.

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
- Dot size is the `target` value in `layout()`.
