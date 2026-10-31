export function reservedSlideField(value, pointer) {
  return value?.wetmytt?.slideManagement === 1 && (pointer === '/wetmytt' || pointer.startsWith('/wetmytt/') || /^\/slides\/\d+\/id(?:\/|$)/.test(pointer));
}

// JSON pointers keep keys containing dots, slashes, and array indexes unambiguous.
export function textFields(value, pointer = '', root = value) {
  if (reservedSlideField(root, pointer)) return [];
  if (typeof value === 'string') return [{ path: pointer, value }];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => textFields(child, `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, root));
}

export function replaceText(value, pointer, text) {
  if (typeof pointer !== 'string' || typeof text !== 'string') throw new Error('Choose a text field.');
  if (reservedSlideField(value, pointer)) throw new Error('Slide identity and management metadata cannot be edited as text.');
  if (pointer === '' && typeof value === 'string') return text;
  if (!pointer.startsWith('/')) throw new Error('Invalid JSON pointer.');
  const keys = pointer.slice(1).split('/').map(key => key.replace(/~1/g, '/').replace(/~0/g, '~'));
  let target = value;
  for (const key of keys.slice(0, -1)) {
    if (!target || typeof target !== 'object' || !Object.hasOwn(target, key)) throw new Error('The text field no longer exists.');
    target = target[key];
  }
  const key = keys.at(-1);
  if (!target || typeof target !== 'object' || !Object.hasOwn(target, key) || typeof target[key] !== 'string') throw new Error('Choose an existing text field.');
  target[key] = text;
  return value;
}

const isStrings = value => Array.isArray(value) && value.every(item => typeof item === 'string');

// Replaces an existing value in place. The new value must keep the old value's kind
// (string, number, boolean, or list of strings) so edits cannot reshape the deck.
export function replaceValue(value, pointer, next) {
  if (typeof pointer !== 'string') throw new Error('Choose a field.');
  if (reservedSlideField(value, pointer)) throw new Error('Slide identity and management metadata cannot be edited.');
  if (!pointer.startsWith('/')) throw new Error('Invalid JSON pointer.');
  const keys = pointer.slice(1).split('/').map(key => key.replace(/~1/g, '/').replace(/~0/g, '~'));
  let target = value;
  for (const key of keys.slice(0, -1)) {
    if (!target || typeof target !== 'object' || !Object.hasOwn(target, key)) throw new Error('The field no longer exists.');
    target = target[key];
  }
  const key = keys.at(-1);
  if (!target || typeof target !== 'object' || !Object.hasOwn(target, key)) throw new Error('Choose an existing field.');
  const current = target[key];
  const matches = typeof current === 'string' ? typeof next === 'string'
    : typeof current === 'boolean' ? typeof next === 'boolean'
    : typeof current === 'number' ? typeof next === 'number' && Number.isFinite(next)
    : isStrings(current) && isStrings(next);
  if (!matches) throw new Error('Choose an existing field.');
  target[key] = next;
  return value;
}
