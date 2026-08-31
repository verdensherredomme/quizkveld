# Fonts

One file, one face: **Newsreader** by Production Type, SIL Open Font License 1.1.

- Upstream: <https://github.com/productiontype/Newsreader>
- Licence text as published: [`public/fonts/OFL.txt`](../../public/fonts/OFL.txt), served at
  `/fonts/OFL.txt` alongside the site and linked from the om-page.
- No Reserved Font Name is declared, so the subset keeps the family name.

## Why this face remains

The interface uses the system sans for headings, navigation, times and body text.
Newsreader is deliberately narrower in scope: it carries only wording quoted verbatim
from the volunteer-maintained source. The serif therefore marks a change of voice rather
than supplying a generic editorial identity.

## How the file was made

Done once, offline; the result is committed. There is no build step and no font tooling in
`package.json`.

```sh
pip install fonttools brotli

# 1. Pin the optical size and the weight: one static instance, not a variable font.
#    A variable subset of the same charset is 33 kB against 20 kB, and the site only ever
#    uses one weight.
python -m fontTools.varLib.instancer "Newsreader[opsz,wght].ttf" opsz=30 wght=500 \
  -o newsreader-500.ttf

# 2. Subset to Latin-1 plus the punctuation Norwegian typesetting needs: the guillemets the
#    source quotations use, en and em dashes, the curly apostrophe, the single guillemets
#    in the breadcrumbs.
python -m fontTools.subset newsreader-500.ttf \
  --unicodes="U+0020-007E,U+00A0-00FF,U+2010-2015,U+2018-201A,U+201C-201E,U+2022,U+2026,U+2039-203A,U+2212" \
  --layout-features="kern,liga,ccmp,locl,mark,mkmk" \
  --flavor=woff2 \
  --output-file=newsreader-500-latin.woff2
```

Result: 19 984 bytes. `æ ø å Æ Ø Å` were checked in the rendered page, not only in the
`cmap` table - "Førde", "Tromsø", "Ålesund", "Bjørkelangen", "Ås".

The file is imported from `src/styles/fonts.css`, so Vite hashes it and emits it into
`_astro/` with the base path applied. That is why it lives in `src/` and not in `public/`:
nothing has to hardcode `/quizkveld/`.

## Fallback metrics

`src/styles/fonts.css` declares a `Newsreader Fallback` face over local Georgia with
`size-adjust: 88.5%`. That number is Newsreader's x-height (0.426 em) divided by Georgia's
(0.4814 em); the ascent and descent overrides are Newsreader's own metrics divided by the
same factor. It keeps source excerpts stable while the face loads.
