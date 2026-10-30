import { randomUUID } from 'node:crypto';
import { readContent, withContentWrite } from './content.js';
import { writeFile } from './files.js';

export function slideManagement(source) {
  const deck = JSON.parse(source);
  let reason = '';
  if (deck?.wetmytt?.slideManagement !== 1) reason = 'This deck has not opted in to slide management.';
  else if (!Array.isArray(deck.slides) || !deck.slides.length || deck.slides.some(slide => !slide || typeof slide !== 'object' || Array.isArray(slide) || typeof slide.id !== 'string' || !slide.id.trim())) reason = 'Slide management needs slide objects with nonempty IDs.';
  else if (new Set(deck.slides.map(slide => slide.id)).size !== deck.slides.length) reason = 'Slide IDs must be unique.';
  return { supported: !reason, reason, source, ids: reason ? [] : deck.slides.map(slide => slide.id), titles: reason ? [] : deck.slides.map(slide => typeof slide.title === 'string' ? slide.title : '') };
}

export async function readSlideManagement(root) {
  try { return slideManagement(await readContent(root)); }
  catch { return { supported: false, reason: 'Slide management requires a valid deck.json file.', source: '', ids: [], titles: [] }; }
}

export function mutateSlide(root, source, renderedIds, operation, guard = () => {}) {
  return withContentWrite(root, async () => {
    guard();
    if (typeof source !== 'string' || await readContent(root) !== source) throw new Error('deck.json changed on disk. Reload before managing slides.');
    const state = slideManagement(source);
    if (!state.supported) throw new Error(state.reason);
    if (!Array.isArray(renderedIds) || renderedIds.length !== state.ids.length || state.ids.some((id, index) => renderedIds[index] !== `id:${id}`)) throw new Error('Rendered slides do not match deck.json. Reload before managing slides.');
    const deck = JSON.parse(source);
    const index = state.ids.indexOf(operation?.id);
    if (index < 0) throw new Error('The slide no longer exists. Reload before managing slides.');
    let duplicateId;
    switch (operation.type) {
      case 'duplicate': {
        const copy = structuredClone(deck.slides[index]);
        do { copy.id = randomUUID(); } while (state.ids.includes(copy.id));
        duplicateId = copy.id;
        deck.slides.splice(index + 1, 0, copy);
        break;
      }
      case 'delete':
        if (deck.slides.length === 1) throw new Error('Keep at least one slide.');
        deck.slides.splice(index, 1); break;
      case 'moveEarlier':
      case 'moveLater': {
        const next = index + (operation.type === 'moveEarlier' ? -1 : 1);
        if (next < 0 || next >= deck.slides.length) throw new Error('The slide cannot move further in that direction.');
        [deck.slides[index], deck.slides[next]] = [deck.slides[next], deck.slides[index]];
        break;
      }
      default: throw new Error('Unknown slide operation.');
    }
    const next = JSON.stringify(deck, null, 2) + '\n';
    // Check again after asynchronous reads, immediately before starting the write.
    guard();
    if (await readContent(root) !== source) throw new Error('deck.json changed on disk. Reload before managing slides.');
    guard();
    await writeFile(root, 'deck.json', next, guard);
    return { ...slideManagement(next), duplicateId };
  });
}
