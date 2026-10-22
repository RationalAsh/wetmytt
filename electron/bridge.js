(() => {
  let index = 0;
  let parentOrigin;
  const slides = () => [...document.querySelectorAll('[data-slide]')];
  function render() {
    const all = slides();
    // JSON renderers may still be fetching when the iframe finishes loading.
    // Preserve the requested slide until containers actually exist.
    if (all.length) index = Math.max(0, Math.min(index, all.length - 1));
    all.forEach((slide, i) => { slide.hidden = i !== index; });
    if (parentOrigin) parent.postMessage({ type: 'wetmytt:state', index, count: all.length, title: document.title }, parentOrigin);
  }
  addEventListener('message', event => {
    if (event.source !== parent || event.data?.type !== 'wetmytt:navigate') return;
    parentOrigin = event.origin;
    if (Number.isInteger(event.data.index)) index = event.data.index;
    render();
  });
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
