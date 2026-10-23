(() => {
  let index = 0;
  let parentOrigin;
  let editing = false, fields = [], selectedPath = null, selectedElement;
  const normalize = value => value.replace(/\s+/g, ' ').trim();
  const selectionStyle = document.createElement('style');
  selectionStyle.textContent = '[data-wetmytt-selected] { outline: 1.5px solid #b39bdf !important; outline-offset: 4px !important; background-color: #a986e626 !important; border-radius: 3px; } @media print { [data-wetmytt-selected] { outline: none !important; background-color: transparent !important; } }';
  document.head.append(selectionStyle);
  const slides = () => [...document.querySelectorAll('[data-slide]')];
  function highlight(element) {
    selectedElement?.removeAttribute('data-wetmytt-selected');
    selectedElement = element;
    if (editing) selectedElement?.setAttribute('data-wetmytt-selected', '');
  }
  function match(element) {
    const explicit = element.closest('[data-json-path]');
    if (explicit) return fields.find(field => field.path === explicit.dataset.jsonPath)?.path ?? null;
    const text = normalize(element.textContent || '');
    if (!text) return null;
    const matches = fields.filter(field => normalize(field.value) === text);
    const local = matches.filter(field => field.path.startsWith(`/slides/${index}/`));
    return local.length === 1 ? local[0].path : matches.length === 1 ? matches[0].path : null;
  }
  function restoreSelection() {
    if (!editing) { highlight(undefined); return; }
    if (selectedPath === null) {
      if (!slides()[index]?.contains(selectedElement)) highlight(undefined);
      return;
    }
    const elements = [...(slides()[index]?.querySelectorAll('*') || [])];
    const explicit = elements.find(element => element.dataset.jsonPath === selectedPath);
    const candidates = explicit ? [explicit] : elements.filter(element => match(element) === selectedPath);
    highlight(candidates.find(element => !candidates.some(child => child !== element && element.contains(child))));
  }
  function render() {
    const all = slides();
    // JSON renderers may still be fetching when the iframe finishes loading.
    // Preserve the requested slide until containers actually exist.
    if (all.length) index = Math.max(0, Math.min(index, all.length - 1));
    all.forEach((slide, i) => { slide.hidden = i !== index; });
    restoreSelection();
    if (parentOrigin) parent.postMessage({ type: 'wetmytt:state', index, count: all.length, title: document.title }, parentOrigin);
  }
  addEventListener('message', event => {
    if (event.source !== parent) return;
    if (event.data?.type === 'wetmytt:edit') {
      parentOrigin = event.origin;
      editing = event.data.enabled === true;
      fields = Array.isArray(event.data.fields) ? event.data.fields.filter(field => typeof field.path === 'string' && typeof field.value === 'string') : [];
      selectedPath = typeof event.data.path === 'string' ? event.data.path : null;
      restoreSelection(); return;
    }
    if (event.data?.type !== 'wetmytt:navigate') return;
    parentOrigin = event.origin;
    if (Number.isInteger(event.data.index)) index = event.data.index;
    render();
  });
  addEventListener('click', event => {
    if (!editing || !parentOrigin || !event.target.closest) return;
    const slide = event.target.closest('[data-slide]');
    if (!slide || event.target.closest('input, textarea, select, [contenteditable]')) return;
    let element = event.target.closest('[data-json-path]') || event.target;
    let path = null;
    for (let candidate = element; candidate && candidate !== slide; candidate = candidate.parentElement) {
      const candidatePath = match(candidate);
      if (candidatePath !== null) { element = candidate; path = candidatePath; break; }
    }
    const text = element === slide ? '' : (element.textContent || '').trim();
    if (text) { event.preventDefault(); event.stopPropagation(); }
    selectedPath = path; highlight(text ? element : undefined);
    parent.postMessage({ type: 'wetmytt:select', path, text }, parentOrigin);
  }, true);
  addEventListener('keydown', event => {
    if (event.target.closest('input, textarea, select, [contenteditable]')) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault(); index += event.key === 'ArrowRight' ? 1 : -1; render();
    }
    if (event.key === 'Escape' && parentOrigin) parent.postMessage({ type: 'wetmytt:escape' }, parentOrigin);
  });
  // File drags inside the cross-origin preview do not bubble to the shell.
  for (const type of ['dragenter', 'dragover', 'drop']) addEventListener(type, event => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    if (parentOrigin) parent.postMessage({
      type: type === 'drop' ? 'wetmytt:drop' : 'wetmytt:drag',
      ...(type === 'drop' ? { files: [...event.dataTransfer.files] } : {}),
    }, parentOrigin);
  }, true);
  new MutationObserver(render).observe(document.body, { childList: true, subtree: true });
  render();
})();
