// Прогресс и конспект остаются в этом браузере отдельно для каждого аккаунта.
(() => {
  'use strict';
  const root = document.getElementById('courseRoom');
  if (!root) return;
  document.body.classList.add('has-course-room');
  const modules = JSON.parse(root.dataset.modules || '[]');
  if (!modules.length) return;
  const byId = (id) => document.getElementById(id);
  const storageKey = 'paradisi-course-progress-v1-' + (root.dataset.user || 'guest');
  let state = { completed: [], notes: {}, last: modules[0].slug, started: [], pages: {} };
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (saved && typeof saved === 'object') state = { ...state, ...saved };
  } catch (_) { /* Чтение остаётся доступным без хранилища. */ }
  const slugs = new Set(modules.map((module) => module.slug));
  for (const key of ['completed', 'started']) state[key] = [...new Set(Array.isArray(state[key]) ? state[key].filter((slug) => slugs.has(slug)) : [])];
  for (const key of ['notes', 'pages']) if (!state[key] || typeof state[key] !== 'object' || Array.isArray(state[key])) state[key] = {};
  state.last = slugs.has(state.last) ? state.last : modules[0].slug;
  function save() {
    try { localStorage.setItem(storageKey, JSON.stringify(state)); return true; }
    catch (_) { return false; }
  }
  const setText = (id, text) => { byId(id).textContent = text; };
  const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const isDone = (slug) => state.completed.includes(slug);
  const statusText = (slug) => isDone(slug) ? 'Пройден' : state.started.includes(slug) ? 'В работе' : 'Не начат';
  function renderProgress() {
    const count = state.completed.length;
    const percent = Math.round(count / modules.length * 100);
    setText('coursePercent', percent + '%');
    setText('courseProgressText', `Пройдено ${count} из ${modules.length} модулей · ${percent}%`);
    byId('courseProgressFill').style.width = percent + '%';
    byId('courseProgressBar').setAttribute('aria-valuenow', String(count));
    document.querySelectorAll('[data-status]').forEach((el) => {
      const slug = el.dataset.status;
      el.textContent = statusText(slug);
      el.className = 'course-card-status' + (isDone(slug) ? ' is-done' : state.started.includes(slug) ? ' is-started' : '');
    });
    const list = byId('courseProgressList');
    list.replaceChildren();
    for (const module of modules) {
      const item = document.createElement('div');
      item.className = 'course-progress-item';
      const row = document.createElement('div');
      for (const [tag, text] of [['span', module.number], ['strong', module.title], ['em', statusText(module.slug)]]) {
        const el = document.createElement(tag); el.textContent = text; row.append(el);
      }
      const track = document.createElement('div'); track.className = 'course-mini-track';
      const fill = document.createElement('span');
      fill.style.width = (isDone(module.slug) ? 100 : state.started.includes(module.slug) ? 45 : 0) + '%';
      track.append(fill); item.append(row, track); list.append(item);
    }
    byId('courseCompletionMessage').hidden = percent !== 100;
  }

  const reader = byId('courseReader');
  const stage = byId('bookStage');
  const sheet = byId('bookSheet');
  const effect = byId('bookTurnCanvas');
  const motion = window.ParadisiBookMotion;
  const zoomLevels = [1, 1.5, 2, 2.5];
  let front = byId('bookCanvasA');
  let back = byId('bookCanvasB');
  let active = null;
  let pdfDocument = null;
  let loadingTask = null;
  let pageNumber = 1;
  let zoomIndex = 0;
  let busy = false;
  let loadToken = 0;
  let layoutVersion = 0;
  let resizePending = false;
  let currentUrl = '';
  let lastRequest = null;
  let lastTrigger = null;
  let libraryScrollY = 0;
  let noteTimer;
  let resizeTimer;
  let warmTimer;
  let stopAnimation = null;
  const cache = new Map();
  const renderTasks = new Set();
  const total = () => pdfDocument ? pdfDocument.numPages : 0;
  const compact = () => window.matchMedia('(max-width: 900px), (max-height: 500px)').matches;
  const pad = (n) => String(n).padStart(2, '0');

  function updateControls() {
    const count = total();
    byId('bookPrev').disabled = busy || !count || pageNumber <= 1;
    byId('bookNext').disabled = busy || !count || pageNumber >= count;
    byId('bookZoomOut').disabled = busy || !count || zoomIndex === 0;
    byId('bookZoomIn').disabled = busy || !count || zoomIndex === zoomLevels.length - 1;
    setText('bookZoomValue', Math.round(zoomLevels[zoomIndex] * 100) + '%');
    setText('bookCounter', count ? `${pad(pageNumber)} / ${pad(count)}` : '— / —');
    byId('bookProgressFill').style.width = count ? (pageNumber / count * 100) + '%' : '0%';
    stage.setAttribute('aria-busy', String(busy));
  }
  function setStatus(text, retry = false) {
    setText('bookStatus', text);
    byId('bookRetry').hidden = !retry;
  }
  function clearCanvas(canvas) {
    canvas.hidden = true;
    canvas.width = canvas.height = 1;
  }
  function cancelWork() {
    loadToken++;
    clearTimeout(warmTimer);
    clearTimeout(resizeTimer);
    if (stopAnimation) stopAnimation();
    renderTasks.forEach((task) => task.cancel());
    renderTasks.clear(); cache.clear();
    if (loadingTask) Promise.resolve(loadingTask.destroy()).catch(() => {});
    loadingTask = null; pdfDocument = null;
    busy = false; resizePending = false;
  }

  // PDF.js работает только с отдельными canvas. Старый запрос не может изменить видимый лист.
  function preparePage(target, nextZoom) {
    const key = `${loadToken}:${layoutVersion}:${nextZoom}:${target}`;
    if (cache.has(key)) return cache.get(key);
    const doc = pdfDocument;
    const token = loadToken;
    const version = layoutVersion;
    const width = Math.max(1, stage.clientWidth);
    // При увеличении высота stage ограничивает прокрутку, а не исходный масштаб PDF.
    const height = compact() ? Infinity : Math.max(180, stage.clientHeight - 24);
    const promise = (async () => {
      const page = await doc.getPage(target);
      if (token !== loadToken || version !== layoutVersion) return null;
      const base = page.getViewport({ scale: 1 });
      const size = motion.fit(base.width, base.height, width, height, zoomLevels[nextZoom], window.devicePixelRatio);
      const canvas = document.createElement('canvas');
      canvas.width = size.pixelWidth; canvas.height = size.pixelHeight;
      const task = page.render({
        canvasContext: canvas.getContext('2d', { alpha: false }),
        viewport: page.getViewport({ scale: size.scale }),
        transform: [size.ratio, 0, 0, size.ratio, 0, 0],
      });
      renderTasks.add(task);
      try { await task.promise; }
      finally { renderTasks.delete(task); }
      return token === loadToken && version === layoutVersion ? { canvas, size } : null;
    })();
    cache.set(key, promise);
    // Текущий и соседние листы; никогда не храним весь PDF в растровом виде.
    while (cache.size > 3) cache.delete(cache.keys().next().value);
    promise.catch(() => { if (cache.get(key) === promise) cache.delete(key); });
    return promise;
  }
  function warmNext() {
    clearTimeout(warmTimer);
    warmTimer = setTimeout(() => {
      if (!pdfDocument || busy || document.hidden) return;
      const target = pageNumber < total() ? pageNumber + 1 : pageNumber - 1;
      if (target >= 1) preparePage(target, zoomIndex).catch(() => {});
    }, 100);
  }
  function mountPage(rendered, canvas) {
    const { size } = rendered;
    canvas.width = rendered.canvas.width; canvas.height = rendered.canvas.height;
    canvas.getContext('2d', { alpha: false }).drawImage(rendered.canvas, 0, 0);
    canvas.style.width = size.width + 'px'; canvas.style.height = size.height + 'px';
    sheet.style.width = size.width + 'px'; sheet.style.height = size.height + 'px';
  }

  function flip(direction) {
    if (!direction || motionPreference.matches || zoomIndex > 0 || document.hidden) return Promise.resolve(true);
    const width = parseFloat(back.style.width);
    const height = parseFloat(back.style.height);
    // У эффекта отдельный небольшой буфер. Финальный лист всегда остаётся чётким.
    const density = Math.min(window.devicePixelRatio || 1, 1.5, 1600 / Math.max(width, height));
    effect.width = Math.max(1, Math.floor(width * density));
    effect.height = Math.max(1, Math.floor(height * density));
    effect.style.width = width + 'px'; effect.style.height = height + 'px';
    const context = effect.getContext('2d', { alpha: false });
    context.setTransform(density, 0, 0, density, 0, 0);
    const source = direction > 0 ? front : back;
    const target = direction > 0 ? back : front;
    const duration = compact() ? 620 : 760;
    return new Promise((resolve) => {
      let frameId;
      let start;
      const finish = (complete) => {
        cancelAnimationFrame(frameId);
        clearCanvas(effect);
        stopAnimation = null;
        resolve(complete);
      };
      stopAnimation = () => finish(false);
      // Рисуем первый кадр до показа слоя, чтобы не было белой вспышки.
      motion.draw(context, source, target, width, height, direction > 0 ? 0 : 1);
      effect.hidden = false;
      const frame = (time) => {
        start ??= time;
        const t = Math.min(1, (time - start) / duration);
        const eased = t * t * t * (10 + t * (-15 + 6 * t));
        motion.draw(context, source, target, width, height, direction > 0 ? eased : 1 - eased);
        if (t < 1 && !document.hidden && !motionPreference.matches) frameId = requestAnimationFrame(frame);
        else finish(true);
      };
      frameId = requestAnimationFrame(frame);
    });
  }
  async function goTo(target, direction = 0, nextZoom = zoomIndex) {
    if (!pdfDocument || busy || target < 1 || target > total()) return;
    const token = loadToken;
    const version = layoutVersion;
    lastRequest = { target, direction, nextZoom };
    busy = true; updateControls();
    let succeeded = false;
    try {
      const rendered = await preparePage(target, nextZoom);
      if (!rendered || token !== loadToken || version !== layoutVersion) return;
      const sameSize = front.width > 1 && front.style.width === rendered.size.width + 'px' && front.style.height === rendered.size.height + 'px';
      mountPage(rendered, back);
      const complete = await flip(sameSize ? direction : 0);
      if (!complete || token !== loadToken) return;
      clearCanvas(front);
      back.hidden = false;
      [front, back] = [back, front];
      front.removeAttribute('aria-hidden'); front.setAttribute('aria-label', 'Страница ' + target);
      back.setAttribute('aria-hidden', 'true');
      const zoomChanged = zoomIndex !== nextZoom;
      zoomIndex = nextZoom; pageNumber = target;
      stage.classList.toggle('is-zoomed', zoomIndex > 0);
      if (zoomChanged) { stage.scrollLeft = 0; stage.scrollTop = 0; }
      if (active) { state.pages[active.slug] = target; save(); }
      setStatus(''); succeeded = true;
    } catch (error) {
      if (token === loadToken && version === layoutVersion) setStatus('Не удалось показать страницу. Повторите попытку.', true);
    } finally {
      if (token === loadToken) {
        busy = false; updateControls();
        if (resizePending) { resizePending = false; goTo(pageNumber); }
        else if (succeeded) warmNext();
      }
    }
  }
  async function loadBook(url) {
    cancelWork();
    const token = loadToken;
    currentUrl = url; lastRequest = null; pageNumber = 1; zoomIndex = 0;
    stage.classList.remove('is-zoomed'); stage.scrollLeft = stage.scrollTop = 0;
    sheet.style.width = ''; sheet.style.height = '';
    clearCanvas(front); clearCanvas(back);
    busy = true; updateControls(); setStatus('Открываем материал…');
    if (!window.pdfjsLib || !motion) {
      busy = false; updateControls(); setStatus('Просмотрщик не загрузился. Проверьте интернет и обновите страницу.', true); return;
    }
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    try {
      loadingTask = window.pdfjsLib.getDocument({ url });
      const doc = await loadingTask.promise;
      if (token !== loadToken) return;
      pdfDocument = doc; busy = false;
      const saved = Number(state.pages[active.slug]);
      await goTo(Number.isInteger(saved) ? Math.min(Math.max(1, saved), doc.numPages) : 1);
    } catch (_) {
      if (token !== loadToken) return;
      busy = false; pdfDocument = null; updateControls();
      setStatus('Не удалось открыть материал. Проверьте доступ к курсу и повторите попытку.', true);
    }
  }
  function turnPage(direction) { goTo(pageNumber + direction, direction); }
  byId('bookPrev').addEventListener('click', () => turnPage(-1));
  byId('bookNext').addEventListener('click', () => turnPage(1));
  for (const [id, delta] of [['bookZoomOut', -1], ['bookZoomIn', 1]]) byId(id).addEventListener('click', () => {
    const next = zoomIndex + delta;
    if (next >= 0 && next < zoomLevels.length) goTo(pageNumber, 0, next);
  });
  byId('bookRetry').addEventListener('click', () => {
    if (!pdfDocument) loadBook(currentUrl);
    else if (lastRequest) goTo(lastRequest.target, lastRequest.direction, lastRequest.nextZoom);
  });
  document.addEventListener('keydown', (event) => {
    if (reader.hidden || event.ctrlKey || event.altKey || event.metaKey || event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
    if (['ArrowRight', 'PageDown'].includes(event.key)) { event.preventDefault(); turnPage(1); }
    else if (['ArrowLeft', 'PageUp'].includes(event.key)) { event.preventDefault(); turnPage(-1); }
    else if (event.key === 'Escape') byId('backToModules').click();
  });
  let touchStart = null;
  stage.addEventListener('touchstart', (event) => {
    touchStart = !busy && zoomIndex === 0 && event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
  }, { passive: true });
  stage.addEventListener('touchmove', (event) => { if (event.touches.length !== 1) touchStart = null; }, { passive: true });
  stage.addEventListener('touchcancel', () => { touchStart = null; }, { passive: true });
  stage.addEventListener('touchend', (event) => {
    if (!touchStart) return;
    const dx = event.changedTouches[0].clientX - touchStart.x;
    const dy = event.changedTouches[0].clientY - touchStart.y;
    touchStart = null;
    if (zoomIndex === 0 && Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.6) turnPage(dx < 0 ? 1 : -1);
  }, { passive: true });
  function scheduleResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!pdfDocument) return;
      layoutVersion++; cache.clear();
      if (busy) resizePending = true;
      else goTo(pageNumber);
    }, 160);
  }
  window.addEventListener('resize', scheduleResize);
  // Шапка может стать выше при переносе заголовка или увеличении текста.
  if (window.ResizeObserver) new ResizeObserver(() => {
    reader.style.setProperty('--reader-bar-height', byId('readerBar').offsetHeight + 'px');
    scheduleResize();
  }).observe(byId('readerBar'));

  function saveNotes() {
    if (active) state.notes[active.slug] = byId('courseNotes').value;
    clearTimeout(noteTimer);
    setText('notesSaveStatus', save() ? 'Сохранено в этом браузере' : 'Браузер не сохранил заметку. Скопируйте текст.');
  }
  function closeReader() {
    saveNotes(); cancelWork(); active = null;
    clearCanvas(front); clearCanvas(back);
    reader.hidden = true; reader.classList.remove('is-reading');
    document.body.classList.remove('course-book-open');
    byId('courseLibrary').hidden = false; byId('courseFinalProgress').hidden = false;
  }
  function openModule(slug) {
    const module = modules.find((item) => item.slug === slug);
    if (!module) return;
    if (reader.hidden) { libraryScrollY = window.scrollY; lastTrigger = document.activeElement; }
    else saveNotes();
    active = module; state.last = module.slug;
    if (!state.started.includes(module.slug) && !isDone(module.slug)) state.started.push(module.slug);
    save(); renderProgress();
    byId('courseLibrary').hidden = true; byId('courseFinalProgress').hidden = true;
    reader.hidden = false; reader.classList.add('is-reading'); document.body.classList.add('course-book-open');
    reader.scrollTop = 0;
    setText('readerTitle', module.title.toLocaleUpperCase('ru-RU'));
    setText('pdfModuleLabel', 'Модуль ' + module.number);
    byId('courseNotes').value = typeof state.notes[module.slug] === 'string' ? state.notes[module.slug] : '';
    setText('notesSaveStatus', 'Заметки сохраняются в этом браузере');
    setText('markModuleDone', isDone(module.slug) ? 'Модуль изучен ✓' : 'Отметить модуль изученным');
    byId('markModuleDone').classList.toggle('is-complete', isDone(module.slug));
    setText('nextModule', module.slug === modules[modules.length - 1].slug ? 'К прогрессу ↓' : 'Следующий модуль →');
    reader.style.setProperty('--reader-bar-height', byId('readerBar').offsetHeight + 'px');
    loadBook('course-materials/' + encodeURIComponent(module.slug) + '.pdf');
    byId('backToModules').focus({ preventScroll: true });
  }
  document.querySelectorAll('[data-module-card]').forEach((card) => {
    card.addEventListener('click', () => openModule(card.dataset.moduleCard));
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openModule(card.dataset.moduleCard); }
    });
  });
  byId('continueCourse').addEventListener('click', () => openModule(state.last));
  byId('backToModules').addEventListener('click', () => {
    closeReader();
    // Не зависим от глобального smooth scroll при восстановлении списка.
    const previous = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = 'auto';
    window.scrollTo(0, libraryScrollY);
    document.documentElement.style.scrollBehavior = previous;
    if (lastTrigger && document.contains(lastTrigger)) lastTrigger.focus({ preventScroll: true });
  });
  byId('courseNotes').addEventListener('input', () => {
    if (!active) return;
    state.notes[active.slug] = byId('courseNotes').value;
    setText('notesSaveStatus', 'Сохраняем…'); clearTimeout(noteTimer);
    noteTimer = setTimeout(saveNotes, 250);
  });
  byId('markModuleDone').addEventListener('click', () => {
    if (!active) return;
    if (!isDone(active.slug)) state.completed.push(active.slug);
    save(); renderProgress(); setText('markModuleDone', 'Модуль изучен ✓');
    byId('markModuleDone').classList.add('is-complete');
  });
  byId('nextModule').addEventListener('click', () => {
    if (!active) return;
    const next = modules[modules.findIndex((module) => module.slug === active.slug) + 1];
    if (next) openModule(next.slug);
    else { closeReader(); byId('courseFinalProgress').scrollIntoView({ behavior: motionPreference.matches ? 'auto' : 'smooth', block: 'start' }); }
  });
  window.addEventListener('pagehide', () => { saveNotes(); if (stopAnimation) stopAnimation(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveNotes(); });
  renderProgress();
})();
