// Прогресс, последний модуль и личные заметки сохраняются в localStorage отдельно для каждого аккаунта.
(() => {
  const root = document.getElementById('courseRoom');
  if (!root) return;
  const userId = 'preview';
  const storageKey = 'paradisi-course-progress-v1-' + userId;
  const modules = JSON.parse(root.dataset.modules || '[]');
  let state = { completed: [], notes: {}, last: modules[0].slug, started: [] };
  try { const saved = JSON.parse(localStorage.getItem(storageKey) || 'null'); if (saved && typeof saved === 'object') state = {...state, ...saved}; } catch (error) { /* Если хранилище недоступно, страница всё равно остаётся рабочей. */ }
  // Старые или повреждённые данные браузера не должны ломать страницу курса.
  const knownSlugs = new Set(modules.map((module) => module.slug));
  state.completed = Array.isArray(state.completed) ? state.completed.filter((slug) => knownSlugs.has(slug)) : [];
  state.started = Array.isArray(state.started) ? state.started.filter((slug) => knownSlugs.has(slug)) : [];
  state.notes = state.notes && typeof state.notes === 'object' && !Array.isArray(state.notes) ? state.notes : {};
  state.last = knownSlugs.has(state.last) ? state.last : (modules[0] && modules[0].slug);
  const byId = (id) => document.getElementById(id);
  const save = () => { try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch (error) { /* Не прерываем изучение, если браузер запретил сохранение. */ } };
  let active = null;
  let libraryScrollY = 0; // позиция списка модулей, чтобы вернуться на то же место
  let noteTimer = null;
  let pdfDocument = null;
  let pdfPageNumber = 1;
  const setText = (id, text) => { const el = byId(id); if (el) el.textContent = text; };
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  state.pages = (state.pages && typeof state.pages === 'object') ? state.pages : {};
  const isDone = (slug) => state.completed.includes(slug);
  const isStarted = (slug) => state.started.includes(slug) && !isDone(slug);
  const statusText = (slug) => isDone(slug) ? 'Пройден' : isStarted(slug) ? 'В работе' : 'Не начат';
  function renderProgress() {
    const count = state.completed.length;
    const percent = Math.round(count / modules.length * 100);
    byId('coursePercent').textContent = percent + '%';
    byId('courseProgressText').textContent = `Пройдено ${count} из ${modules.length} модулей · ${percent}%`;
    byId('courseProgressFill').style.width = percent + '%';
    byId('courseProgressBar').setAttribute('aria-valuenow', String(count));
    document.querySelectorAll('[data-status]').forEach((el) => { const slug = el.dataset.status; el.textContent = statusText(slug); el.className = 'course-card-status' + (isDone(slug) ? ' is-done' : isStarted(slug) ? ' is-started' : ''); });
    byId('courseProgressList').innerHTML = modules.map((m) => `<div class="course-progress-item"><div><span>${m.number}</span><strong>${m.title}</strong><em>${statusText(m.slug)}</em></div><div class="course-mini-track"><span style="width:${isDone(m.slug) ? 100 : isStarted(m.slug) ? 45 : 0}%"></span></div></div>`).join('');
    byId('courseCompletionMessage').hidden = percent !== 100;
  }
  function renderNav() {
    if (!byId('readerNav')) return; // боковой панели в режиме чтения больше нет
    byId('readerNav').innerHTML = modules.map((m) => `<button type="button" data-open-module="${m.slug}" class="course-reader-nav-item${active && active.slug === m.slug ? ' is-active' : ''}"><span>${m.number}</span><span>${m.title}</span><i aria-label="${isDone(m.slug) ? 'Пройден' : statusText(m.slug)}">${isDone(m.slug) ? '✓' : '○'}</i></button>`).join('');
  }
  /* ===== Книжный просмотр: всегда одна страница PDF, перелистывание через два canvas ===== */
  const stage = byId('bookStage');
  const sheet = byId('bookSheet');
  const zoomLevels = [1, 1.5, 2, 2.5];
  let zoomIndex = 0;
  const zoomToolbar = document.createElement('div');
  zoomToolbar.className = 'course-book-zoom';
  zoomToolbar.setAttribute('aria-label', 'Масштаб страницы PDF');
  zoomToolbar.innerHTML = '<button type="button" id="bookZoomOut" aria-label="Уменьшить PDF">−</button><span id="bookZoomValue" aria-live="polite">100%</span><button type="button" id="bookZoomIn" aria-label="Увеличить PDF">+</button>';
  byId('courseBook').querySelector('.course-book-controls').after(zoomToolbar);
  let front = byId('bookCanvasA');   // сейчас на экране
  let back = byId('bookCanvasB');    // страница, которая готовится / приходит
  let busy = false;                  // идёт загрузка или перелистывание — новые команды игнорируются
  let loadToken = 0;                 // защита от устаревших асинхронных результатов
  let resizePending = false;
  let currentUrl = '';
  const pad = (n) => String(n).padStart(2, '0');
  const total = () => (pdfDocument ? pdfDocument.numPages : 0);

  function updateControls() {
    const count = total();
    byId('bookPrev').disabled = busy || !count || pdfPageNumber <= 1;
    byId('bookNext').disabled = busy || !count || pdfPageNumber >= count;
    byId('bookCounter').textContent = count ? `${pad(pdfPageNumber)} / ${pad(count)}` : '— / —';
    byId('bookProgressFill').style.width = count ? (pdfPageNumber / count * 100) + '%' : '0%';
    stage.setAttribute('aria-busy', busy ? 'true' : 'false');
    byId('bookZoomOut').disabled = busy || !count || zoomIndex === 0;
    byId('bookZoomIn').disabled = busy || !count || zoomIndex === zoomLevels.length - 1;
    byId('bookZoomValue').textContent = Math.round(zoomLevels[zoomIndex] * 100) + '%';
  }
  function setStatus(text, canRetry) {
    byId('bookStatus').textContent = text || '';
    byId('bookRetry').hidden = !canRetry;
  }
  async function drawPage(canvas, pageNumber, doc) {
    const page = await doc.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    sheet.style.setProperty('--page-ratio', (base.width / base.height).toFixed(4));
    const narrow = window.matchMedia('(max-width: 700px)').matches;
    const fitWidth = Math.max(160, stage.clientWidth);
    const fitHeight = narrow ? Infinity : Math.max(160, stage.clientHeight - 32);
    const fitScale = Math.min(fitWidth / base.width, fitHeight / base.height);
    const viewport = page.getViewport({ scale: fitScale * zoomLevels[zoomIndex] });
    const enlarged = zoomIndex > 0;
    stage.classList.toggle('is-zoomed', enlarged);
    sheet.classList.toggle('is-zoomed', enlarged);
    sheet.style.width = enlarged ? Math.ceil(viewport.width) + 'px' : '';
    sheet.style.height = enlarged ? Math.ceil(viewport.height) + 'px' : '';
    const ratio = Math.min(window.devicePixelRatio || 1, 2, 4096 / Math.max(viewport.width, viewport.height));
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = Math.floor(viewport.width) + 'px';
    canvas.style.height = Math.floor(viewport.height) + 'px';
    const context = canvas.getContext('2d', { alpha: false });
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    await page.render({ canvasContext: context, viewport }).promise;
  }
  function releaseCanvas(canvas) {
    canvas.getAnimations().forEach((animation) => animation.cancel());
    canvas.hidden = true;
    canvas.style.zIndex = '';
    canvas.width = 1;
    canvas.height = 1;
  }
  async function flip(direction) {
    const outgoing = front;
    const incoming = back;
    const token = loadToken;
    incoming.hidden = false;
    if (!direction || reducedMotion() || !outgoing.animate) {
      releaseCanvas(outgoing);
      return;
    }
    // Следующий PDF уже отрисован. Поворачиваем лист без раннего растворения текста.
    const moving = direction > 0 ? outgoing : incoming;
    const resting = direction > 0 ? incoming : outgoing;
    resting.style.zIndex = '1';
    moving.style.zIndex = '2';
    const frames = [
      { transform: 'rotateY(0deg)', opacity: 1, boxShadow: '0 0 0 rgba(0,0,0,0)', offset: 0 },
      { transform: 'rotateY(-24deg)', opacity: 1, boxShadow: '12px 4px 18px rgba(0,0,0,.12)', offset: .38 },
      { transform: 'rotateY(-68deg)', opacity: 1, boxShadow: '22px 5px 24px rgba(0,0,0,.16)', offset: .78 },
      { transform: 'rotateY(-89.5deg)', opacity: 0, boxShadow: '0 0 0 rgba(0,0,0,0)', offset: 1 }
    ];
    const animation = moving.animate(frames, {
      duration: window.matchMedia('(max-width: 700px)').matches ? 580 : 760,
      easing: 'cubic-bezier(.25,.1,.2,1)',
      direction: direction > 0 ? 'normal' : 'reverse',
      fill: 'both'
    });
    try {
      await animation.finished;
    } catch (error) {
      // Закрытие книги отменяет переход; старый переход не меняет новый модуль.
    } finally {
      if (token === loadToken) {
        releaseCanvas(outgoing);
        incoming.style.zIndex = '';
      }
      animation.cancel();
    }
  }
  // Показывает страницу target. direction: 1 вперёд, -1 назад, 0 без анимации (первая загрузка, изменение размера).
  async function goTo(target, direction) {
    const doc = pdfDocument;
    if (!doc || busy || target < 1 || target > doc.numPages) return;
    const token = loadToken;
    busy = true; updateControls();
    try {
      await drawPage(back, target, doc);
      if (token !== loadToken) return;
      await flip(direction);
      if (token !== loadToken) return;
      [front, back] = [back, front];
      back.style.zIndex = ''; front.style.zIndex = '';
      front.removeAttribute('aria-hidden');
      front.setAttribute('aria-label', 'Страница ' + target);
      back.setAttribute('aria-hidden', 'true');
      pdfPageNumber = target;
      if (active) { state.pages[active.slug] = target; save(); }
      setStatus('', false);
    } catch (error) {
      if (token !== loadToken) return;
      back.hidden = true;
      setStatus(front.hidden ? 'Не удалось показать страницу.' : 'Не удалось загрузить страницу. Попробуйте перелистнуть ещё раз.', true);
    } finally {
      if (token === loadToken) {
        busy = false; updateControls();
        if (resizePending) { resizePending = false; goTo(pdfPageNumber, 0); }
      }
    }
  }
  async function loadBook(url) {
    currentUrl = url;
    loadToken += 1;
    const token = loadToken;
    if (pdfDocument && pdfDocument.destroy) { try { pdfDocument.destroy(); } catch (error) { /* не критично */ } }
    pdfDocument = null; pdfPageNumber = 1; busy = true; resizePending = false;
    zoomIndex = 0;
    stage.classList.remove('is-zoomed');
    sheet.classList.remove('is-zoomed');
    sheet.style.width = '';
    sheet.style.height = '';
    releaseCanvas(front); releaseCanvas(back);
    updateControls();
    setStatus('Открываем материал…', false);
    if (!window.pdfjsLib) {
      busy = false; updateControls();
      setStatus('Просмотрщик не загрузился. Проверьте подключение к интернету: библиотека загружается с CDN.', true);
      return;
    }
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    try {
      const doc = await window.pdfjsLib.getDocument({ url }).promise;
      if (token !== loadToken) { try { doc.destroy(); } catch (error) { /* не критично */ } return; }
      pdfDocument = doc;
      busy = false;
      const saved = Number(state.pages[active ? active.slug : '']) || 1;
      await goTo(Math.min(Math.max(1, saved), doc.numPages), 0);
    } catch (error) {
      if (token !== loadToken) return;
      pdfDocument = null; busy = false; updateControls();
      setStatus('Не удалось открыть PDF. Обновите страницу и попробуйте снова.', true);
    }
  }
  function setZoom(nextIndex) {
    if (!pdfDocument || busy || nextIndex < 0 || nextIndex >= zoomLevels.length || nextIndex === zoomIndex) return;
    zoomIndex = nextIndex;
    goTo(pdfPageNumber, 0);
  }
  byId('bookZoomOut').addEventListener('click', () => setZoom(zoomIndex - 1));
  byId('bookZoomIn').addEventListener('click', () => setZoom(zoomIndex + 1));
  function turnPage(direction) { goTo(pdfPageNumber + direction, direction); }
  byId('bookPrev').addEventListener('click', () => turnPage(-1));
  byId('bookNext').addEventListener('click', () => turnPage(1));
  byId('bookRetry').addEventListener('click', () => {
    if (!pdfDocument) loadBook(currentUrl);
    else goTo(pdfPageNumber, 0);
  });
  document.addEventListener('keydown', (event) => {
    if (byId('courseReader').hidden) return;
    const tag = (event.target && event.target.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'input') return;
    if (event.key === 'ArrowRight' || event.key === 'PageDown') { event.preventDefault(); turnPage(1); }
    else if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); turnPage(-1); }
    else if (event.key === 'Escape') { event.preventDefault(); byId('backToModules').click(); }
  });
  let touchStart = null;
  stage.addEventListener('touchstart', (event) => { const t = event.changedTouches[0]; touchStart = { x: t.clientX, y: t.clientY }; }, { passive: true });
  stage.addEventListener('touchend', (event) => {
    if (!touchStart) return;
    const t = event.changedTouches[0]; const dx = t.clientX - touchStart.x; const dy = t.clientY - touchStart.y; touchStart = null;
    // При увеличении жест двигает страницу; при обычном масштабе перелистывает её.
    if (zoomIndex > 0) return;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) turnPage(dx < 0 ? 1 : -1);
  }, { passive: true });
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (!pdfDocument) return; if (busy) resizePending = true; else goTo(pdfPageNumber, 0); }, 180);
  });
  function closeReader() {
    if (active) state.notes[active.slug] = byId('courseNotes').value;
    clearTimeout(noteTimer);
    save();
    loadToken += 1; busy = false; resizePending = false;
    if (pdfDocument && pdfDocument.destroy) { try { pdfDocument.destroy(); } catch (error) { /* не критично */ } }
    pdfDocument = null;
    releaseCanvas(front); releaseCanvas(back);
    byId('courseReader').hidden = true; byId('courseReader').classList.remove('is-reading');
    document.body.classList.remove('course-book-open');
    byId('courseLibrary').hidden = false; byId('courseFinalProgress').hidden = false;
  }

  let lastTrigger = null;
  function openModule(slug) {
    const module = modules.find((item) => item.slug === slug) || modules[0];
    const reader = byId('courseReader');
    if (reader.hidden) { libraryScrollY = window.scrollY; lastTrigger = document.activeElement; }
    active = module; state.last = module.slug;
    if (!state.started.includes(module.slug) && !isDone(module.slug)) state.started.push(module.slug);
    save(); renderProgress(); renderNav();
    byId('courseLibrary').hidden = true; byId('courseFinalProgress').hidden = true;
    reader.hidden = false; reader.classList.add('is-reading'); document.body.classList.add('course-book-open');
    reader.scrollTop = 0;
    setText('readerTitle', module.title.toLocaleUpperCase('ru-RU'));
    setText('pdfModuleLabel', 'Модуль ' + module.number);
    byId('courseNotes').value = state.notes[module.slug] || '';
    byId('markModuleDone').textContent = isDone(module.slug) ? 'Модуль изучен ✓' : 'Отметить модуль изученным';
    byId('markModuleDone').classList.toggle('is-complete', isDone(module.slug));
    byId('nextModule').textContent = module.slug === modules[modules.length - 1].slug ? 'К прогрессу ↓' : 'Следующий модуль →';
    loadBook('course-materials/' + encodeURIComponent(module.slug) + '.pdf');
    byId('backToModules').focus({ preventScroll: true });
  }
  document.querySelectorAll('[data-module-card]').forEach((card) => {
    const activate = () => openModule(card.dataset.moduleCard);
    card.addEventListener('click', activate);
    card.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); } });
  });
  const readerNavEl = byId('readerNav');
  if (readerNavEl) readerNavEl.addEventListener('click', (event) => { const button = event.target.closest('[data-open-module]'); if (button) openModule(button.dataset.openModule); });
  byId('continueCourse').addEventListener('click', () => { const unfinished = modules.find((m) => !isDone(m.slug)); openModule(state.last || (unfinished && unfinished.slug) || modules[0].slug); });
  byId('backToModules').addEventListener('click', () => {
    closeReader();
    window.scrollTo({ top: libraryScrollY, left: 0, behavior: 'auto' });
    if (lastTrigger && document.contains(lastTrigger) && lastTrigger.focus) lastTrigger.focus({ preventScroll: true });
  });
  byId('courseNotes').addEventListener('input', () => {
    if (!active) return;
    state.notes[active.slug] = byId('courseNotes').value;
    byId('notesSaveStatus').textContent = 'Сохраняем…';
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { save(); byId('notesSaveStatus').textContent = 'Сохранено в этом браузере'; }, 250);
  });
  byId('markModuleDone').addEventListener('click', () => {
    if (!active) return;
    if (!isDone(active.slug)) state.completed.push(active.slug);
    state.completed = [...new Set(state.completed)]; save(); renderProgress(); renderNav();
    byId('markModuleDone').textContent = 'Модуль изучен ✓'; byId('markModuleDone').classList.add('is-complete');
  });
  byId('nextModule').addEventListener('click', () => {
    if (!active) return;
    const index = modules.findIndex((m) => m.slug === active.slug);
    if (index < modules.length - 1) openModule(modules[index + 1].slug);
    else { closeReader(); byId('courseFinalProgress').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  });
  // Сохраняем последний лист и заметки и при быстром закрытии вкладки.
  const saveBeforeLeave = () => {
    if (active) state.notes[active.slug] = byId('courseNotes').value;
    clearTimeout(noteTimer);
    save();
  };
  window.addEventListener('pagehide', saveBeforeLeave);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveBeforeLeave(); });
  renderProgress();
})();
