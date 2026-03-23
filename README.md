# Whom Should I Root For?

Static web app for comparing a submission against a benchmark submission and
answering the practical question: for each remaining NCAA tournament game, who
should I root for?

The app is intentionally no-build:

- `index.html`
- `src/main.js`
- `src/engine.js`
- `styles/site.css`

Data is generated from the main modeling repo with:

```bash
uv run python scripts/build_data.py
```

That command reads the current 2026 bracket metadata, resolved results, and
default submissions from `/Users/aburkard/fun/madness_pyro` by default and
writes a small app-friendly bundle into `data/`.

To serve locally:

```bash
python3 -m http.server 4173
```

Then open <http://localhost:4173>.
