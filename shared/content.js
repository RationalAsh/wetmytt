// JSON pointers keep keys containing dots, slashes, and array indexes unambiguous.
export function textFields(value, pointer = '') {
  if (typeof value === 'string') return [{ path: pointer, value }];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => textFields(child, `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`));
}

export function replaceText(value, pointer, text) {
  if (typeof pointer !== 'string' || typeof text !== 'string') throw new Error('Choose a text field.');
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
