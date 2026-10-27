/* Геометрия цилиндрического сгиба. Без сторонних библиотек и изменения PDF. */
(function (scope) {
  'use strict';
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function fold(width, progress) {
    const p = clamp(progress, 0, 1);
    const length = width * p;
    const radius = Math.min(width * .065 * Math.sin(Math.PI * p), length / Math.PI);
    return { crease: width - length, radius, tail: Math.max(0, length - Math.PI * radius) };
  }

  function fit(width, height, availableWidth, availableHeight, zoom, density) {
    const scale = Math.min(availableWidth / width, availableHeight / height) * zoom;
    const w = Math.max(1, Math.floor(width * scale));
    const h = Math.max(1, Math.floor(height * scale));
    // Ограничение памяти касается растрового буфера, а не размера увеличенного листа.
    const ratio = Math.min(density || 1, 2, 4096 / Math.max(w, h), Math.sqrt(3000000 / (w * h)));
    return { width: w, height: h, scale, ratio, pixelWidth: Math.max(1, Math.floor(w * ratio)), pixelHeight: Math.max(1, Math.floor(h * ratio)) };
  }

  function draw(context, source, target, width, height, progress) {
    const p = clamp(progress, 0, 1);
    context.clearRect(0, 0, width, height);
    context.drawImage(target, 0, 0, width, height);
    if (p >= 1) return;
    if (p <= 0) { context.drawImage(source, 0, 0, width, height); return; }
    const { crease, radius, tail } = fold(width, p);
    const textureScale = source.width / width;
    const edge = crease - tail;
    const shadowWidth = Math.max(1, radius * 1.3);

    // Падающая тень на следующем листе движется вместе со сгибом.
    const shadow = context.createLinearGradient(crease, 0, crease + radius + shadowWidth, 0);
    shadow.addColorStop(0, 'rgba(0,0,0,.22)');
    shadow.addColorStop(1, 'rgba(0,0,0,0)');
    context.fillStyle = shadow;
    context.fillRect(crease, 0, radius + shadowWidth, height);
    if (crease > 0) context.drawImage(source, 0, 0, crease * textureScale, source.height, 0, 0, crease, height);

    // Обратная сторона листа: светлая бумага с едва заметным отпечатком.
    if (tail > .1) {
      context.fillStyle = '#faf9f6';
      context.fillRect(edge, 0, tail, height);
      context.save();
      context.translate(crease, 0);
      context.scale(-1, 1);
      context.globalAlpha = .055;
      context.drawImage(source, (crease + Math.PI * radius) * textureScale, 0, tail * textureScale, source.height, 0, 0, tail, height);
      context.restore();
      const shade = context.createLinearGradient(edge, 0, crease, 0);
      shade.addColorStop(0, 'rgba(0,0,0,.06)');
      shade.addColorStop(.7, 'rgba(255,255,255,.08)');
      shade.addColorStop(1, 'rgba(0,0,0,.13)');
      context.fillStyle = shade;
      context.fillRect(edge, 0, tail, height);
    }

    // Сетка узких полос аппроксимирует изгиб; текстура берётся из готового canvas.
    // PDF не рендерится заново ни на одном кадре анимации.
    const strips = 24;
    for (let i = 0; i < strips; i++) {
      const a = Math.PI * i / strips;
      const b = Math.PI * (i + 1) / strips;
      const x1 = crease + radius * Math.sin(a);
      const x2 = crease + radius * Math.sin(b);
      const stripWidth = Math.abs(x2 - x1);
      if (stripWidth < .02) continue;
      const sx = (crease + radius * a) * textureScale;
      const sw = radius * (b - a) * textureScale;
      const left = Math.min(x1, x2);
      if (i < strips / 2) {
        context.drawImage(source, sx, 0, sw, source.height, left, 0, stripWidth + .5, height);
        context.fillStyle = `rgba(0,0,0,${.18 * Math.sin(a)})`;
      } else {
        const light = Math.round(233 + 20 * Math.abs(Math.cos(a)));
        context.fillStyle = `rgb(${light},${light},${Math.max(0, light - 3)})`;
      }
      context.fillRect(left, 0, stripWidth + .5, height);
    }
  }

  const api = { fold, fit, draw };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else scope.ParadisiBookMotion = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
