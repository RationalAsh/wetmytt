// The rendering is yours to change. Keep data-slide on each slide for Welcome to My TED Talk navigation.
fetch('deck.json').then(response => {
  if (!response.ok) throw new Error('Could not read deck.json');
  return response.json();
}).then(deck => {
  if (!Array.isArray(deck.slides) || !deck.slides.length) throw new Error('deck.json needs at least one slide.');
  document.title = deck.title || 'Untitled presentation';
  const container = document.querySelector('#slides');
  deck.slides.forEach((slide, index) => {
    const section = document.createElement('section');
    section.dataset.slide = '';
    section.className = `slide ${['cover', 'split', 'closing'].includes(slide.layout) ? slide.layout : 'cover'}`;
    section.hidden = index !== 0;
    const content = document.createElement('div');
    content.className = 'content';
    for (const [tag, text, className] of [['span', slide.eyebrow, 'eyebrow'], ['h1', slide.title, 'title'], ['p', slide.body, 'body']]) {
      if (!text) continue;
      const element = document.createElement(tag);
      element.textContent = text;
      element.className = className;
      element.dataset.jsonPath = `/slides/${index}/${className === 'title' ? 'title' : className}`;
      content.append(element);
    }
    if (slide.bullets?.length) {
      const list = document.createElement('ul');
      slide.bullets.forEach((text, bulletIndex) => { const item = document.createElement('li'); item.textContent = text; item.dataset.jsonPath = `/slides/${index}/bullets/${bulletIndex}`; list.append(item); });
      content.append(list);
    }
    section.append(content);
    if (slide.image) {
      const image = document.createElement('img');
      image.src = slide.image; image.alt = slide.imageAlt || ''; section.append(image);
    }
    const footer = document.createElement('footer');
    footer.textContent = `${deck.title || 'WETMYTT'}   /   ${String(index + 1).padStart(2, '0')}`;
    section.append(footer); container.append(section);
  });
}).catch(error => {
  const message = document.createElement('section');
  message.dataset.slide = ''; message.className = 'slide';
  message.textContent = `Unable to render the deck: ${error.message}. Fix deck.json and save to reload.`;
  document.querySelector('#slides').replaceChildren(message);
});
