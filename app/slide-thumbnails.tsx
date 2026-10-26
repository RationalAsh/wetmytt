'use client';

import { useEffect, useRef, useState } from 'react';
import type { Deck } from './bridge';

function Chevron({ right = false }: { right?: boolean }) {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={right ? 'm10 5 7 7-7 7' : 'm14 5-7 7 7 7'} /></svg>;
}

export function SlideThumbnails({ deck, ids, count, slide, onNavigate }: { deck: Deck; ids: string[]; count: number; slide: number; onNavigate(index: number): void }) {
  const viewport = useRef<HTMLDivElement>(null);
  const alive = useRef(false);
  const [visible, setVisible] = useState<number[]>([]);
  const [images, setImages] = useState<Record<number, string>>({});
  const [failed, setFailed] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [scroll, setScroll] = useState({ left: 0, max: 0 });
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const update = () => setScroll({ left: element.scrollLeft, max: Math.max(0, element.scrollWidth - element.clientWidth) });
    const resize = new ResizeObserver(update);
    resize.observe(element);
    element.addEventListener('scroll', update, { passive: true });
    update();
    return () => { resize.disconnect(); element.removeEventListener('scroll', update); };
  }, [count]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const nearby = new Set<number>();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const index = Number((entry.target as HTMLElement).dataset.index);
        if (entry.isIntersecting) nearby.add(index); else nearby.delete(index);
      }
      setVisible([...nearby].sort((a, b) => a - b));
    }, { root: element, rootMargin: '0px 112px', threshold: 0 });
    element.querySelectorAll('[data-index]').forEach(button => observer.observe(button));
    return () => observer.disconnect();
  }, [count]);

  useEffect(() => {
    const element = viewport.current;
    const active = element?.querySelector<HTMLElement>(`[data-index="${slide}"]`);
    if (!element || !active) return;
    // Scroll only the filmstrip; scrollIntoView can also move the workspace.
    const start = active.offsetLeft - element.offsetLeft;
    const end = start + active.offsetWidth;
    if (start < element.scrollLeft || end > element.scrollLeft + element.clientWidth) {
      element.scrollTo({ left: Math.max(0, start - (element.clientWidth - active.offsetWidth) / 2), behavior: reducedMotion() ? 'instant' : 'smooth' });
    }
  }, [slide, count]);

  useEffect(() => {
    if (busy || cancelled || !deck.root || deck.generation === undefined || deck.contentRevision === undefined || deck.contentSettled === false || ids.length !== count || !window.wetmytt) return;
    const indices = visible.filter(index => !images[index] && !failed.includes(index)).slice(0, 6);
    if (!indices.length) return;
    setBusy(true);
    void window.wetmytt.thumbnails(deck.root, deck.generation, deck.contentRevision, indices.map(index => ({ index, id: ids[index] }))).then(result => {
      if (result === null) { if (alive.current) setCancelled(true); return; }
      if (alive.current) {
        const valid = result.filter(image => image.root === deck.root && image.generation === deck.generation && image.revision === deck.contentRevision && indices.includes(image.index) && image.id === ids[image.index]);
        setImages(current => ({ ...current, ...Object.fromEntries(valid.filter(image => image.url).map(image => [image.index, image.url!])) }));
        setFailed(current => [...current, ...valid.filter(image => image.error).map(image => image.index)]);
      }
    }).catch(() => {
      // Navigation still works when a custom slide cannot be captured.
      if (alive.current) setFailed(current => [...current, ...indices]);
    }).finally(() => { if (alive.current) setBusy(false); });
  }, [visible, images, failed, busy, cancelled, deck.root, deck.generation, deck.contentRevision, deck.contentSettled, ids, count]);

  const move = (direction: number) => {
    const element = viewport.current;
    if (element) element.scrollBy({ left: direction * Math.max(112, element.clientWidth * .8), behavior: reducedMotion() ? 'instant' : 'smooth' });
  };
  const overflow = scroll.max > 1;

  return <nav className="slide-thumbnails" aria-label="Slide thumbnails" data-slide-thumbnails data-content-revision={deck.contentRevision}>
    <button className="thumbnail-chevron" aria-label="Scroll thumbnails left" disabled={!overflow || scroll.left < 1} onClick={() => move(-1)}><Chevron /></button>
    <div className="thumbnail-track">
      <div className="thumbnail-viewport" ref={viewport} data-fade-left={scroll.left > 1} data-fade-right={scroll.left < scroll.max - 1}>
        {Array.from({ length: count }, (_, index) => <button key={index} data-index={index} className="slide-thumbnail" aria-label={`Go to slide ${index + 1}`} aria-current={slide === index ? 'true' : undefined} title={failed.includes(index) ? `Slide ${index + 1} · Preview unavailable` : `Slide ${index + 1}`} onClick={() => onNavigate(index)} onKeyDown={event => {
          const next = event.key === 'ArrowRight' ? Math.min(count - 1, index + 1) : event.key === 'ArrowLeft' ? Math.max(0, index - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : null;
          if (next === null) return;
          event.preventDefault(); event.stopPropagation();
          onNavigate(next);
          viewport.current?.querySelector<HTMLButtonElement>(`[data-index="${next}"]`)?.focus({ preventScroll: true });
        }}>
          <span className="thumbnail-image">{images[index] ? <img src={images[index]} alt="" draggable={false} /> : <span className="thumbnail-placeholder">{failed.includes(index) ? 'Preview unavailable' : 'Loading…'}</span>}</span>
          <span className="thumbnail-number">{String(index + 1).padStart(2, '0')}</span>
        </button>)}
        {!count && <span className="thumbnail-empty">Loading slides…</span>}
      </div>
      <input className="thumbnail-seeker" type="range" aria-label="Scroll through slide thumbnails" min="0" max="1000" step="1" value={scroll.max ? Math.round(scroll.left / scroll.max * 1000) : 0} disabled={!overflow} onChange={event => {
        if (viewport.current) viewport.current.scrollLeft = Number(event.target.value) / 1000 * scroll.max;
      }} />
    </div>
    <button className="thumbnail-chevron" aria-label="Scroll thumbnails right" disabled={!overflow || scroll.left > scroll.max - 1} onClick={() => move(1)}><Chevron right /></button>
  </nav>;
}
