# Static thumbnail rendering

The filmstrip lazily captures 320 × 180 PNGs in an isolated 1280 × 720 browser. One renderer serves the settled content revision. Captures run serially, with a 16 MiB image LRU in the main process. Closing the project or window, editing files, and replacing a revision release its renderer and cache.

Each observed file change immediately invalidates pending captures and removes old thumbnails. Replacement requests wait for 250 ms without another change and for the reloaded preview's slide manifest. Project generation, content revision, slide identity, and a navigation request token are checked before publishing a result. Shared assets invalidate the entire revision. This settling period does not freeze files; immutable snapshots remain a possible follow-up for mixed-file reads.

Give slides a unique `data-slide-id` or HTML `id` to provide persistent identity. Duplicate or absent IDs fall back to an index scoped to the current revision. Identity never permits reusing an image across revisions.

## Deck hook

The hidden renderer loads `index.html?context=thumbnail&contentRevision=…`. Code that runs before the injected bridge can read those query parameters. Once installed, the bridge exposes `window.wetmyttContext` and `document.documentElement.dataset.wetmyttContext`, both set to `thumbnail` in this renderer and `presentation` in the visible preview.

A deck can define this optional function before or after the bridge loads:

```js
window.wetmyttPrepareThumbnail = async ({ slide, index, id, revision, context }) => {
  // slide is the active container, index is zero-based, and id is namespaced:
  // "id:<persistent ID>" or "index:<revision>:<index>".
  slide.querySelectorAll('.fragment').forEach(element => {
    element.style.opacity = '1';
  });
  await drawStaticChart(slide);
  const video = slide.querySelector('video');
  if (video) { video.pause(); video.poster = 'assets/video-poster.png'; }
};
```

The hook runs after correlated navigation and before asset and animation preparation. It can await custom timers, paint a canvas, reveal click-driven content, or select a video poster. It runs only for thumbnails; PDF and presentation playback retain their behavior. Hooks should be repeatable because cache eviction or renderer recovery can revisit a slide.

Default preparation makes images eager, decodes image and CSS assets, waits for fonts, finishes finite animations (including delays), and pauses infinite animations at time zero. Up to four animation/paint passes allow completion handlers to create subsequent effects. Newly revealed assets are checked again before capture.

For exits or mutually exclusive animation states, use the hook to choose a representative state. Mark elements with `data-thumbnail-animation="preserve"` to pause their animations in that chosen state instead of finishing them. Arbitrary JavaScript animation and interactive content need the hook; browser animation APIs cannot settle them automatically.

Readiness has a 10-second limit and each complete capture has a 15-second limit. A failed slide returns an individual error, resets the renderer, and leaves navigation and other captures available. Unavailable external resources remain blocked by the deck's sandbox and local resource policy.

## Diagnostics and validation

Set `WETMYTT_THUMBNAIL_TRACE=1` when launching the app to record requested, ready, and captured identities, request tokens, active indices, and output byte sizes. With `npm run test:thumbnails` it also prints fixture timings and memory. Traces contain the local project path.

The Electron fixtures check actual pixel colors, delayed entrance and infinite animations, async canvas/video preparation, failure recovery, renderer reuse, cache hits, identity mismatch, same-count reorders, insertion/deletion, cancellation, scrolling, keyboard navigation, and project close/reopen. Screenshot and PDF integration suites cover the shared preparation path. Fixture timings are diagnostics, not performance targets; representative heavy-deck CPU and memory profiling is still needed before tuning resolution, invalidation, or snapshotting.
