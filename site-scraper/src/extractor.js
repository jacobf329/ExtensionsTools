// Shared content extractor. Works on a live page (injected via chrome.scripting)
// and on documents parsed with DOMParser (used by the crawler), so it avoids
// layout-dependent APIs like innerText.
(function (root) {
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME',
    'OBJECT', 'EMBED', 'HEAD', 'BUTTON', 'SELECT', 'TEXTAREA', 'INPUT', 'META', 'LINK',
  ]);
  const CHROME_TAGS = new Set(['NAV', 'HEADER', 'FOOTER', 'ASIDE']);
  const BLOCK_TAGS = new Set([
    'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'NAV', 'ASIDE',
    'FIGURE', 'FIGCAPTION', 'DL', 'DT', 'DD', 'ADDRESS', 'DETAILS', 'SUMMARY',
    'FORM', 'FIELDSET', 'BODY', 'CENTER',
  ]);
  const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

  function absUrl(value, base) {
    if (!value) return '';
    try {
      return new URL(value.trim(), base).href;
    } catch (e) {
      return '';
    }
  }

  function isHidden(el, ctx) {
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
    if (/display\s*:\s*none/i.test(el.getAttribute('style') || '')) return true;
    if (ctx.live && el.ownerDocument.defaultView) {
      const style = el.ownerDocument.defaultView.getComputedStyle(el);
      if (style && style.display === 'none') return true;
    }
    return false;
  }

  function imgSrc(el, base) {
    return absUrl(
      el.currentSrc || el.getAttribute('src') || el.getAttribute('data-src') ||
        el.getAttribute('data-lazy-src') || '',
      base
    );
  }

  function convertChildren(el, ctx) {
    let out = '';
    for (const child of el.childNodes) out += convert(child, ctx);
    return out;
  }

  function convert(node, ctx) {
    if (node.nodeType === 3) {
      return ctx.pre ? node.nodeValue : node.nodeValue.replace(/\s+/g, ' ');
    }
    if (node.nodeType !== 1) return '';

    const el = node;
    const tag = el.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag) || isHidden(el, ctx)) return '';
    if (ctx.mainOnly && CHROME_TAGS.has(tag)) return '';

    const md = !ctx.plain;
    switch (tag) {
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': {
        const text = convertChildren(el, ctx).replace(/\s+/g, ' ').trim();
        if (!text) return '';
        const prefix = md ? '#'.repeat(Number(tag[1])) + ' ' : '';
        return `\n\n${prefix}${text}\n\n`;
      }
      case 'P':
        return `\n\n${convertChildren(el, ctx).trim()}\n\n`;
      case 'BR':
        return '\n';
      case 'HR':
        return md ? '\n\n---\n\n' : '\n\n';
      case 'STRONG': case 'B':
        return wrapInline(convertChildren(el, ctx), md ? '**' : '');
      case 'EM': case 'I':
        return wrapInline(convertChildren(el, ctx), md ? '_' : '');
      case 'CODE': {
        const text = el.textContent;
        return md && !ctx.pre ? '`' + text + '`' : text;
      }
      case 'PRE': {
        const text = el.textContent.replace(/\n+$/, '');
        return md ? `\n\n\`\`\`\n${text}\n\`\`\`\n\n` : `\n\n${text}\n\n`;
      }
      case 'A': {
        const text = convertChildren(el, ctx).replace(/\s+/g, ' ').trim();
        const href = absUrl(el.getAttribute('href'), ctx.base);
        if (!md || !href || href.startsWith('javascript:') || !text) return text;
        return `[${text}](${href})`;
      }
      case 'IMG': {
        if (!md) return '';
        const src = imgSrc(el, ctx.base);
        if (!src || src.startsWith('data:')) return '';
        return `![${(el.getAttribute('alt') || '').trim()}](${src})`;
      }
      case 'UL': case 'OL':
        return convertList(el, tag === 'OL', ctx);
      case 'BLOCKQUOTE': {
        const inner = tidy(convertChildren(el, ctx));
        if (!md) return `\n\n${inner}\n\n`;
        return '\n\n' + inner.split('\n').map((l) => '> ' + l).join('\n') + '\n\n';
      }
      case 'TABLE':
        return convertTable(el, ctx);
      case 'LI': // stray <li> outside a list
        return `\n- ${convertChildren(el, ctx).trim()}\n`;
      default: {
        const inner = convertChildren(el, ctx);
        return BLOCK_TAGS.has(tag) ? `\n${inner}\n` : inner;
      }
    }
  }

  function convertList(el, ordered, ctx) {
    const items = Array.from(el.children).filter((c) => c.tagName.toUpperCase() === 'LI');
    if (!items.length) return '';
    const indent = '  '.repeat(ctx.listDepth);
    const start = Number(el.getAttribute('start')) || 1;
    const childCtx = Object.assign({}, ctx, { listDepth: ctx.listDepth + 1 });
    const lines = items
      .filter((li) => !isHidden(li, ctx))
      .map((li, i) => {
        const body = convertChildren(li, childCtx).replace(/\n{2,}/g, '\n').trim();
        const marker = ordered ? `${start + i}.` : '-';
        return `${indent}${marker} ${body}`;
      });
    return `\n\n${lines.join('\n')}\n\n`;
  }

  function tableRows(table, ctx) {
    const cellCtx = Object.assign({}, ctx, { plain: true });
    return Array.from(table.rows).map((row) =>
      Array.from(row.cells).map((cell) =>
        convertChildren(cell, cellCtx).replace(/\s+/g, ' ').trim()
      )
    );
  }

  function convertTable(table, ctx) {
    const rows = tableRows(table, ctx).filter((r) => r.some(Boolean));
    if (!rows.length) return '';
    if (ctx.plain) return '\n\n' + rows.map((r) => r.join('\t')).join('\n') + '\n\n';
    const width = Math.max(...rows.map((r) => r.length));
    const fmt = (r) => {
      const cells = r.concat(Array(width - r.length).fill(''));
      return '| ' + cells.map((c) => c.replace(/\|/g, '\\|')).join(' | ') + ' |';
    };
    const sep = '| ' + Array(width).fill('---').join(' | ') + ' |';
    return '\n\n' + [fmt(rows[0]), sep].concat(rows.slice(1).map(fmt)).join('\n') + '\n\n';
  }

  // Wraps inline text in a marker while keeping surrounding spaces outside it.
  function wrapInline(text, marker) {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
    return marker && m[2] ? m[1] + marker + m[2] + marker + m[3] : text;
  }

  // Normalises whitespace: drops stray indentation (except list nesting and code
  // blocks), trailing spaces, and runs of blank lines.
  function tidy(text) {
    let inFence = false;
    const lines = text.split('\n').map((line) => {
      if (/^\s*```/.test(line)) inFence = !inFence;
      if (inFence) return line.replace(/\s+$/, '');
      if (/^\s+(-|\d+\.) /.test(line)) return line.replace(/\s+$/, '');
      return line.trim();
    });
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function meta(doc, name) {
    const el = doc.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
    return el ? (el.getAttribute('content') || '').trim() : '';
  }

  /**
   * Extracts content from a document.
   * @param {Document} doc
   * @param {string} url  The page URL (used to resolve relative links).
   * @param {{mainOnly?: boolean, live?: boolean}} [options]
   */
  function extract(doc, url, options) {
    const opts = Object.assign({ mainOnly: false, live: false }, options);
    const baseEl = doc.querySelector('base[href]');
    const base = baseEl ? absUrl(baseEl.getAttribute('href'), url) || url : url;
    const origin = new URL(url).origin;

    let rootEl = doc.body || doc.documentElement;
    if (opts.mainOnly) {
      rootEl = doc.querySelector('main, [role="main"], article') || rootEl;
    }

    const ctx = { base, live: opts.live, mainOnly: opts.mainOnly, listDepth: 0, pre: false, plain: false };
    const markdown = rootEl ? tidy(convert(rootEl, ctx)) : '';
    const text = rootEl ? tidy(convert(rootEl, Object.assign({}, ctx, { plain: true }))) : '';

    const scope = rootEl || doc;
    const visible = (el) => {
      for (let n = el; n && n !== scope.parentNode; n = n.parentElement) {
        if (isHidden(n, ctx) || (opts.mainOnly && CHROME_TAGS.has(n.tagName.toUpperCase()))) return false;
      }
      return true;
    };

    const headings = Array.from(scope.querySelectorAll('h1, h2, h3, h4, h5, h6'))
      .filter(visible)
      .map((h) => ({ level: Number(h.tagName[1]), text: h.textContent.replace(/\s+/g, ' ').trim() }))
      .filter((h) => h.text);

    const seenLinks = new Set();
    const links = [];
    for (const a of doc.querySelectorAll('a[href]')) {
      const href = absUrl(a.getAttribute('href'), base);
      if (!href || !/^(https?|mailto|tel):/.test(href) || seenLinks.has(href)) continue;
      seenLinks.add(href);
      let internal = false;
      try {
        internal = new URL(href).origin === origin;
      } catch (e) { /* mailto/tel */ }
      links.push({ text: a.textContent.replace(/\s+/g, ' ').trim(), href, internal });
    }

    const seenImages = new Set();
    const images = [];
    for (const img of scope.querySelectorAll('img')) {
      const src = imgSrc(img, base);
      if (!src || src.startsWith('data:') || seenImages.has(src)) continue;
      seenImages.add(src);
      images.push({ src, alt: (img.getAttribute('alt') || '').trim() });
    }

    const tables = Array.from(scope.querySelectorAll('table'))
      .filter(visible)
      .map((t) => tableRows(t, ctx).filter((r) => r.some(Boolean)))
      .filter((rows) => rows.length);

    const emails = new Set((text.match(EMAIL_RE) || []).map((e) => e.toLowerCase()));
    for (const l of links) {
      if (l.href.startsWith('mailto:')) emails.add(decodeURIComponent(l.href.slice(7).split('?')[0]).toLowerCase());
    }

    const canonicalEl = doc.querySelector('link[rel="canonical"]');
    const titleEl = doc.querySelector('title');
    return {
      url,
      title: (titleEl ? titleEl.textContent : '').trim() || meta(doc, 'og:title') || (headings[0] ? headings[0].text : ''),
      description: meta(doc, 'description') || meta(doc, 'og:description'),
      lang: (doc.documentElement.getAttribute('lang') || '').trim(),
      canonical: canonicalEl ? absUrl(canonicalEl.getAttribute('href'), base) : '',
      meta: {
        author: meta(doc, 'author'),
        keywords: meta(doc, 'keywords'),
        ogImage: absUrl(meta(doc, 'og:image'), base),
        published: meta(doc, 'article:published_time'),
      },
      wordCount: (text.match(/\S+/g) || []).length,
      headings,
      links,
      images,
      tables,
      emails: Array.from(emails),
      text,
      markdown,
      scrapedAt: new Date().toISOString(),
    };
  }

  root.SiteScraperExtract = extract;
})(typeof globalThis !== 'undefined' ? globalThis : this);
