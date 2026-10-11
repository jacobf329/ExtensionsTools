// Formatters and download helpers shared by the popup and crawler pages.
(function (root) {
  function slug(value) {
    return (value || 'page')
      .replace(/^https?:\/\//, '')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'page';
  }

  function pageMarkdown(page) {
    const header = [`# ${page.title || page.url}`, '', `Source: ${page.url}`];
    if (page.description) header.push('', `> ${page.description}`);
    return header.join('\n') + '\n\n---\n\n' + page.markdown + '\n';
  }

  function pageText(page) {
    return `${page.title || page.url}\n${page.url}\n\n${page.text}\n`;
  }

  function csv(rows) {
    return rows
      .map((row) =>
        row
          .map((value) => {
            const s = value == null ? '' : String(value);
            return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
          })
          .join(',')
      )
      .join('\r\n') + '\r\n';
  }

  function linksCsv(pages) {
    const rows = [['page', 'link_text', 'href', 'internal']];
    for (const p of pages) for (const l of p.links) rows.push([p.url, l.text, l.href, l.internal]);
    return csv(rows);
  }

  function imagesCsv(pages) {
    const rows = [['page', 'src', 'alt']];
    for (const p of pages) for (const i of p.images) rows.push([p.url, i.src, i.alt]);
    return csv(rows);
  }

  function pagesCsv(pages) {
    const rows = [['url', 'title', 'description', 'word_count', 'headings', 'links', 'images', 'emails', 'text']];
    for (const p of pages) {
      rows.push([p.url, p.title, p.description, p.wordCount, p.headings.length, p.links.length,
        p.images.length, p.emails.join(' '), p.text]);
    }
    return csv(rows);
  }

  function download(content, filename, mime) {
    // A BOM keeps Excel from mangling UTF-8 CSVs.
    const parts = mime === 'text/csv' ? ['﻿', content] : [content];
    const url = URL.createObjectURL(new Blob(parts, { type: `${mime};charset=utf-8` }));
    chrome.downloads.download({ url, filename, saveAs: false }, () => {
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    });
  }

  root.SiteScraperExport = { slug, pageMarkdown, pageText, csv, linksCsv, imagesCsv, pagesCsv, download };
})(globalThis);
