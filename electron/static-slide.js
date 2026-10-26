// Serialized into a sandboxed deck window. Keep this function self-contained.
export async function prepareStaticSlide(index, { context = 'pdf', revision = '', id, token = '', timeout = 20000 } = {}) {
  let timer, listener;
  const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const ready = async () => {
    while (!document.querySelector('[data-slide]')) await new Promise(resolve => setTimeout(resolve, 50));
    const slides = [...document.querySelectorAll('[data-slide]')];
    if (!slides[index]) throw new Error('Slide ' + (index + 1) + ' does not exist. This deck has ' + slides.length + ' slides.');
    const state = await new Promise(resolve => {
      listener = event => {
        if (event.source === window && event.data?.type === 'wetmytt:state' && event.data.token === token && event.data.revision === revision && event.data.index === index) resolve(event.data);
      };
      addEventListener('message', listener);
      window.postMessage({ type: 'wetmytt:navigate', index, token }, location.origin);
    });
    removeEventListener('message', listener);
    if (id !== undefined && state.slides[index] !== id) throw new Error('Slide identity changed during capture.');
    const active = slides[index];
    // Hooks run after activation. Returning a promise makes custom timers,
    // canvas, fragments and video posters part of the bounded readiness wait.
    if (context === 'thumbnail') await window.wetmyttPrepareThumbnail?.({ slide: active, index, id: state.slides[index], revision, context });
    const assets = async () => {
      const images = [...active.querySelectorAll('img')];
      images.forEach(image => { image.loading = 'eager'; });
      await Promise.all(images.map(image => image.decode().catch(() => { throw new Error('Could not load slide image: ' + image.getAttribute('src')); })));
      const urls = new Set([...active.querySelectorAll('video[poster]')].map(video => video.poster).filter(Boolean));
      const elements = [active, ...active.querySelectorAll('*')];
      for (let parent = active.parentElement; parent; parent = parent.parentElement) elements.push(parent);
      for (const element of elements) for (const pseudo of [null, '::before', '::after']) {
        const style = getComputedStyle(element, pseudo);
        for (const value of [style.backgroundImage, style.maskImage, style.borderImageSource, style.content]) {
          for (const match of value.matchAll(/url\(["']?(.*?)["']?\)/g)) urls.add(match[1]);
        }
      }
      await Promise.all([...urls].map(async url => {
        const image = new Image(); image.src = url;
        await image.decode().catch(() => { throw new Error('Could not load slide background: ' + url); });
      }));
      await document.fonts.ready;
      if ([...document.fonts].some(font => font.status === 'error')) throw new Error('A presentation font failed to load.');
    };
    await assets();
    // Finish delayed entrances, then let completion handlers create subsequent
    // effects. A hook can mark exits/alternative states to keep them untouched.
    const seen = new Set();
    for (let pass = 0; pass < (context === 'pdf' ? 1 : 4); pass++) {
      for (const animation of document.getAnimations()) {
        if (seen.has(animation)) continue;
        seen.add(animation);
        const target = animation.effect?.target;
        if (context === 'thumbnail' && target?.closest?.('[data-thumbnail-animation="preserve"]')) { animation.pause(); continue; }
        if (animation.effect?.getComputedTiming().iterations !== Infinity) {
          try { animation.finish(); } catch { animation.pause(); }
        } else {
          if (context === 'thumbnail') animation.currentTime = 0;
          animation.pause();
        }
      }
      await frame();
    }
    if (context === 'thumbnail') await assets();
    await frame();
    const rect = active.getBoundingClientRect();
    if (active.hidden || rect.width < 1 || rect.height < 1) throw new Error('Slide ' + (index + 1) + ' has no visible dimensions.');
    const currentSlides = [...document.querySelectorAll('[data-slide]')];
    const ids = currentSlides.map(slide => slide.dataset.slideId || slide.id);
    const currentId = ids[index] && ids.filter(value => value === ids[index]).length === 1 ? 'id:' + ids[index] : 'index:' + revision + ':' + index;
    if (currentSlides[index] !== active || currentId !== state.slides[index]) throw new Error('Slides changed during capture.');
    return { count: slides.length, index, id: state.slides[index], revision, token };
  };
  try {
    return await Promise.race([ready(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Slide ' + (index + 1) + ' did not finish loading. Check data-slide, the navigation bridge, fonts and images.')), timeout);
    })]);
  } finally { clearTimeout(timer); removeEventListener('message', listener); }
}
