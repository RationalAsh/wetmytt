# Editing this presentation

This folder is the complete presentation. Edit files directly; Decklet reloads on every change.

- `deck.json`: slide content, local image paths, and layout choices.
- `index.html`: editable HTML entry point. You can replace the rendering entirely.
- `slides.js`: turns the JSON into HTML. Keep `data-slide` on each slide element.
- `styles.css`: presentation styling. Slides are 16:9; use container-relative units to fit the preview.
- `assets/`: local images, fonts, and other assets. Use relative paths.

Prefer one clear point per slide. Preserve valid JSON. Avoid external URLs and scripts; the preview permits local resources only. The app injects its navigation bridge at the closing body tag. Keep that tag, and do not add application controls or chat to this folder. `data-slide` elements are direct slide containers; inactive slides receive the `hidden` attribute. Respect it with `[hidden] { display: none !important; }`.
