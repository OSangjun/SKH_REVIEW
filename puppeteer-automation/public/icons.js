/* Browser Automation Tool — SVG icon set
 *
 * Lucide-style line icons. 16×16 by default, 1.75px stroke, currentColor.
 * Exposed on window.ICONS for both inline HTML and dynamic builder code.
 */
(function () {
  'use strict';
  const SIZE = 16;
  const STROKE = 1.75;
  function svg(viewBox, body, opts = {}) {
    const size = opts.size || SIZE;
    const cls = opts.cls ? ` ${opts.cls}` : '';
    return `<svg class="icon${cls}" width="${size}" height="${size}" viewBox="${viewBox}" `
         + `fill="none" stroke="currentColor" stroke-width="${STROKE}" `
         + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  }
  function ico(body, cls) { return svg('0 0 24 24', body, { cls }); }

  const ICONS = {
    // Navigation / address bar
    globe: () => ico(
      '<circle cx="12" cy="12" r="10"/>' +
      '<path d="M2 12h20"/>' +
      '<path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>'),
    arrowRight: () => ico('<path d="M5 12h14"/><path d="m13 5 7 7-7 7"/>'),
    moreHorizontal: () => ico(
      '<circle cx="5" cy="12" r="1.2"/>' +
      '<circle cx="12" cy="12" r="1.2"/>' +
      '<circle cx="19" cy="12" r="1.2"/>'),

    // Actions
    cookie: () => ico(
      '<path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5"/>' +
      '<path d="M8.5 8.5h.01"/><path d="M16 15.5h.01"/>' +
      '<path d="M12 12h.01"/><path d="M11 17h.01"/><path d="M7 14h.01"/>'),
    play: (cls) => svg('0 0 24 24',
      '<polygon points="6 3 21 12 6 21 6 3" fill="currentColor" stroke="none"/>',
      { cls }),
    square: () => ico('<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/>'),
    zap: (cls) => svg('0 0 24 24',
      '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" '
      + 'fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
      { cls }),
    edit: () => ico(
      '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>' +
      '<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z"/>'),
    trash: () => ico(
      '<polyline points="3 6 5 6 21 6"/>' +
      '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>' +
      '<path d="M10 11v6"/><path d="M14 11v6"/>' +
      '<path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>'),
    x: () => ico('<path d="M18 6 6 18"/><path d="M6 6l12 12"/>'),
    chevronDown: () => ico('<path d="m6 9 6 6 6-6"/>'),
    chevronRight: () => ico('<path d="m9 6 6 6-6 6"/>'),

    // Status / data types
    server: () => ico(
      '<rect x="2" y="2" width="20" height="8" rx="2"/>' +
      '<rect x="2" y="14" width="20" height="8" rx="2"/>' +
      '<line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>'),
    braces: () => ico(
      '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/>' +
      '<path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>'),
    code: () => ico(
      '<polyline points="16 18 22 12 16 6"/>' +
      '<polyline points="8 6 2 12 8 18"/>'),
    bell: () => ico(
      '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/>' +
      '<path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'),
    link: () => ico(
      '<path d="M9 17H7A5 5 0 0 1 7 7h2"/>' +
      '<path d="M15 7h2a5 5 0 1 1 0 10h-2"/>' +
      '<line x1="8" y1="12" x2="16" y2="12"/>'),
    checkCircle: (cls) => svg('0 0 24 24',
      '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
      { cls }),
    xCircle: (cls) => svg('0 0 24 24',
      '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
      { cls }),
  };

  window.ICONS = ICONS;
})();
