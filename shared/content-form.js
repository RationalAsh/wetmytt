import { reservedSlideField } from './content.js';

const IMAGE_KEY = /^(image|img|src|icon|logo|photo|picture|background)/i;
const IMAGE_VALUE = /\.(png|jpe?g|gif|svg|webp|avif)(\?.*)?$/i;
const CHOICE_KEY = /^(layout|align(ment)?|theme|variant|style|type|kind|transition|position|size)$/i;
const LABELS = { bullets: 'Bullet points', cta: 'Call to action', url: 'Link', src: 'Image' };

export const pointerChild = (pointer, key) => `${pointer}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;

export function humanize(key) {
  if (Object.hasOwn(LABELS, key)) return LABELS[key];
  const words = String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.]+/g, ' ').trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Text';
}

export function singular(label) {
  const word = label.toLowerCase();
  return word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

export const isImagePath = value => typeof value === 'string' && IMAGE_VALUE.test(value);
const isToken = value => typeof value === 'string' && value.length > 0 && value.length <= 24 && !/\s/.test(value);

// Decks have no schema, so pick a widget from the key name, the value, and the same key on sibling slides.
export function stringKind(key, value, peers = []) {
  if (IMAGE_KEY.test(key) && (isImagePath(value) || value === '') || isImagePath(value)) return { kind: 'image' };
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) return { kind: 'color' };
  if (CHOICE_KEY.test(key) && isToken(value)) {
    const options = [...new Set([...peers.filter(isToken), value])];
    if (options.length >= 2) return { kind: 'choice', options };
  }
  return { kind: value.includes('\n') || value.length > 60 ? 'long' : 'short' };
}

export function expandHex(color) {
  return color.length === 4 ? `#${[...color.slice(1)].map(char => char + char).join('')}` : color;
}

// The slide list is the top-level "slides" array of objects, or the first array of objects.
export function findSlides(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const isSlides = value => Array.isArray(value) && value.length > 0 && value.every(item => item && typeof item === 'object' && !Array.isArray(item));
  const key = isSlides(doc.slides) ? 'slides' : Object.keys(doc).find(name => isSlides(doc[name]));
  return key === undefined ? null : { key, slides: doc[key] };
}

export function slideTitle(slide) {
  const named = ['title', 'heading', 'headline', 'name'].map(key => slide?.[key]).find(value => typeof value === 'string' && value.trim());
  const first = named ?? Object.values(slide || {}).find(value => typeof value === 'string' && value.trim() && !isImagePath(value));
  return typeof first === 'string' ? first.replace(/\s+/g, ' ').trim() : '';
}

export function peerValues(slides, key) {
  return slides.map(slide => slide?.[key]).filter(value => typeof value === 'string');
}

// Every image path used anywhere in the deck, for suggestions.
export function imagePaths(value, found = new Set()) {
  if (typeof value === 'string') { if (isImagePath(value)) found.add(value); }
  else if (value && typeof value === 'object') Object.values(value).forEach(child => imagePaths(child, found));
  return [...found];
}

export function editable(root, pointer) {
  return !reservedSlideField(root, pointer);
}
