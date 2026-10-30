# Slide management

New decks support Duplicate, Delete, Move earlier, and Move later in each thumbnail's menu. Delete asks for confirmation and keeps at least one slide. Duplicate selects the new copy, inserted after the original; image and other asset paths remain shared. Moving slides preserves the current selection.

Save or discard text drafts before managing slides. Controls also pause during built-in AI requests, PDF exports, and preview reloads. Conflicting disk changes are rejected; wait for the preview to reload and try again. There is no structural Undo in this version.

## Opt in an existing JSON deck

Existing decks are never automatically converted. An agent or author can update a compatible renderer and JSON together:

```json
{
  "wetmytt": { "slideManagement": 1 },
  "title": "My talk",
  "slides": [
    { "id": "a1e3e92a-1519-4d13-a38c-d94f267c4071", "title": "Opening" },
    { "id": "a536ec70-4b9a-40fe-9943-13e72dd02ca8", "title": "Closing" }
  ]
}
```

Assign every slide a unique, nonempty string ID, preferably generated with Node's `crypto.randomUUID()`. Preserve it when editing or moving that slide; generate a new ID for each duplicate. The array order determines presentation order. Do not derive IDs from position or title.

Render exactly one top-level slide container for each array entry, in array order:

```js
deck.slides.forEach((slide, index) => {
  const section = document.createElement('section');
  section.dataset.slide = '';
  section.dataset.slideId = slide.id;
  // Render content and rebuild index-based data-json-path bindings here.
  container.append(section);
});
```

Do not nest `[data-slide]` elements. All slide content and layout needed for duplication must reside in the slide's JSON object or shared assets. Update any custom references or renderer assumptions before opting in: the app changes only the slides array, never arbitrary HTML, scripts, or cross-slide references. Custom renderers must accept JSON cloning and adjacent array reordering.

The app enables management only when the declared JSON IDs and rendered `data-slide-id` sequence agree. IDs and `wetmytt` metadata are excluded from the text editor on opted-in decks. Decks without this contract continue to support preview, navigation, and export.
