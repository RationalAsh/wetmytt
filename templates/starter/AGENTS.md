# Editing this presentation

This folder is the complete presentation. Edit files directly; Welcome to My TED Talk reloads on every change.

## Git workflow

Before each logical change (which may span several files), check Git status and start with a clean working tree and index. New decks have an initial commit; initialize Git if an existing deck has no repository. With connection tools, use `git_status`, `git_diff`, `git_stage`, and `git_commit`; external agents with a shell can use the equivalent Git commands.

If there are existing changes, inspect both unstaged and staged diffs and read relevant untracked files. Stage explicit paths and commit them separately before editing, preserving their contents. Describe them as existing work, for example `Checkpoint existing title and layout edits`; keep them separate from your implementation commit. Check status again before starting. Do not commit secrets or unrelated files outside the presentation. If a clean baseline cannot be created safely or a Git operation fails, report the blocker before editing.

After each logical change, review the diff and validate the result, stage the explicit changed paths, inspect the staged diff, and commit with a concise, descriptive message explaining what changed and why, for example `Increase title contrast for readability`. Check status again to confirm the working tree and index are clean before starting another change or reporting completion. Do not create empty commits for read-only or unchanged work. Never discard edits or rewrite history unless requested. If validation or a commit fails, report it honestly and preserve the edits.

## Creative freedom

This deck is a local website. Freely edit or replace its HTML, CSS, JavaScript, renderer, and JSON schema. Every slide can have its own structure, layout, styles, animations, SVG, canvas, and interactive behavior. The starter's `cover`, `split`, and `closing` layouts and `deck.json` schema are examples, not app requirements. Inspect existing files before editing and preserve deck-specific conventions unless asked to change them.

## Files and text editing

- `deck.json`: slide content, local image paths, and layout choices.
- `index.html`: editable HTML entry point. You can replace the rendering entirely.
- `slides.js`: turns the JSON into HTML. Keep `data-slide` on each slide element.
- Add `data-json-path` to text elements using a JSON pointer into `deck.json` (for example, `/slides/0/title` or `/slides/1/bullets/0`). This lets clicking text open its exact field in the app's Edit tab. Escape `~` as `~0` and `/` as `~1` in key names. Without a pointer, the app can link unique text matches automatically.
- `styles.css`: presentation styling. Slides are 16:9; use container-relative units to fit the preview.
- `assets/`: local images, fonts, and other assets. Use relative paths.

The Edit tab edits string values in `deck.json`, including nested objects and arrays. Keep editable text there and bind it with `data-json-path`. Repeated or transformed text needs explicit bindings. Custom HTML without matching JSON strings still renders, but cannot use this field editor. Keep JSON files valid. File changes reload automatically; hidden files and `node_modules` are ignored by the watcher.

## Navigation and sizing

Keep a closing `</body>` tag: the app injects its navigation bridge there. Mark each top-level slide container with `data-slide`; do not nest these containers. The bridge counts slides and sets `hidden` on inactive ones. Include `[hidden] { display: none !important; }` so custom styles cannot reveal inactive slides. Let the app handle slide navigation, and keep application controls and chat outside the deck.

Design for a 16:9 canvas (1280 by 720 CSS pixels for screenshots and PDF). Use responsive or container-relative sizing to fit the preview without clipping. Prefer one clear point per slide.

## Runtime and assets

The preview runs sandboxed browser JavaScript without Node.js, Electron APIs, or a backend. Inline and local JavaScript/CSS are allowed; `eval` and `new Function` are blocked. Only local resources are permitted: no remote scripts, CDN libraries, fonts, embeds, or API requests. Save assets and browser-ready libraries inside the deck and use relative URLs, not remote URLs or absolute filesystem paths.

The in-app chat and MCP connections provide file editing, web research, asset imports/downloads, and local Git history. They expose no shell execution or image generation. Use `import_assets` with relevant absolute source paths or `download_asset` with public URLs to bring assets into `assets/`; imports/downloads are limited to 25 MB per file. Research and download tools can access the web even though slide JavaScript cannot. External agents may have their own additional tools.

MCP provides `screenshot_slide` for visual review at 1280 by 720; built-in chat does not. Preview, presenting, and PDF export are app controls, not agent tools.

## PDF behavior

PDF export prints each live slide as a static 16:9 page using screen styles. Text and SVG stay sharp; raster images and canvas retain their resolution. Fonts and images must load successfully. Finite animations finish and repeating animations pause before printing. Video and interactive content export only their current static appearance; provide a useful static state.
