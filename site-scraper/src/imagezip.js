// Downloads a list of images and packs them into a ZIP, with an index.csv
// mapping each file back to its source URL, alt text and page.
(function (root) {
  const MAX_FILES = 65000; // classic ZIP entry limit (no ZIP64 support)
  const MAX_BYTES = 3.5 * 1024 ** 3; // stay under the 4 GB classic ZIP limit
  const TIMEOUT_MS = 30000;

  const EXT_BY_TYPE = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/bmp': 'bmp', 'image/x-icon': 'ico',
    'image/vnd.microsoft.icon': 'ico', 'image/tiff': 'tif',
  };

  // Identifies common formats from their first bytes, for servers that send
  // a generic content type and URLs without a file extension.
  function sniffType(data) {
    const b = data;
    const ascii = (start, end) => String.fromCharCode(...b.subarray(start, end));
    if (b[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (ascii(0, 4) === 'GIF8') return 'image/gif';
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
    if (ascii(4, 12) === 'ftypavif') return 'image/avif';
    if (ascii(0, 2) === 'BM') return 'image/bmp';
    if (/<svg[\s>]/i.test(ascii(0, Math.min(b.length, 512)))) return 'image/svg+xml';
    return '';
  }

  /** Collapses images from many pages into a unique list keyed by src. */
  function collectImages(pages) {
    const bySrc = new Map();
    for (const page of pages) {
      for (const img of page.images) {
        if (!bySrc.has(img.src)) bySrc.set(img.src, { src: img.src, alt: img.alt, page: page.url });
      }
    }
    return Array.from(bySrc.values());
  }

  /** Origin patterns to request host permission for. */
  function originPatterns(images) {
    const origins = new Set();
    for (const img of images) {
      try {
        const u = new URL(img.src);
        if (/^https?:$/.test(u.protocol)) origins.add(u.origin + '/*');
      } catch (e) { /* skip */ }
    }
    return Array.from(origins);
  }

  function fileName(src, type, used) {
    let base = 'image';
    try {
      const path = decodeURIComponent(new URL(src).pathname);
      base = path.split('/').filter(Boolean).pop() || 'image';
    } catch (e) { /* keep default */ }
    base = base.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').slice(0, 100);

    let stem = base.replace(/\.[a-z0-9]{1,5}$/i, '');
    let ext = (/\.([a-z0-9]{1,5})$/i.exec(base) || [])[1];
    const typeExt = EXT_BY_TYPE[(type || '').split(';')[0].trim().toLowerCase()];
    if (typeExt && (!ext || !Object.values(EXT_BY_TYPE).includes(ext.toLowerCase()))) ext = typeExt;
    stem = stem || 'image';

    let name = ext ? `${stem}.${ext}` : stem;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = ext ? `${stem}-${i}.${ext}` : `${stem}-${i}`;
    used.add(name.toLowerCase());
    return name;
  }

  async function fetchImage(src, signal) {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
    const onAbort = () => timeout.abort();
    if (signal) signal.addEventListener('abort', onAbort);
    try {
      const res = await fetch(src, { credentials: 'include', signal: timeout.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = res.headers.get('content-type') || '';
      if (type && !/^image\//i.test(type) && !/octet-stream/i.test(type)) {
        throw new Error(`not an image (${type.split(';')[0]})`);
      }
      const data = new Uint8Array(await res.arrayBuffer());
      return { type: /^image\//i.test(type) ? type : sniffType(data) || type, data };
    } catch (err) {
      if (signal && signal.aborted) throw err;
      if (err.name === 'AbortError') throw new Error('timed out');
      throw err;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * @param {{src: string, alt: string, page: string}[]} images
   * @param {{signal?: AbortSignal, concurrency?: number,
   *          onProgress?: (done: number, total: number, failed: number, bytes: number) => void,
   *          onError?: (src: string, message: string) => void}} [options]
   * @returns {Promise<{blob: Blob, saved: number, failed: number, truncated: boolean}>}
   */
  async function buildImageZip(images, options) {
    const opts = Object.assign({ concurrency: 4 }, options);
    const zip = new root.SiteScraperZip();
    const used = new Set(['index.csv']);
    const index = [['file', 'src', 'alt', 'page']];
    let next = 0;
    let done = 0;
    let failed = 0;
    let truncated = false;

    async function worker() {
      while (next < images.length && !truncated) {
        if (opts.signal && opts.signal.aborted) return;
        const img = images[next++];
        try {
          const { type, data } = await fetchImage(img.src, opts.signal);
          if (index.length > MAX_FILES || zip.size + data.length > MAX_BYTES) {
            truncated = true;
            break;
          }
          const name = fileName(img.src, type, used);
          zip.add(name, data);
          index.push([name, img.src, img.alt, img.page]);
        } catch (err) {
          if (opts.signal && opts.signal.aborted) return;
          failed++;
          if (opts.onError) opts.onError(img.src, err.message);
        }
        done++;
        if (opts.onProgress) opts.onProgress(done, images.length, failed, zip.size);
      }
    }

    await Promise.all(Array.from({ length: Math.min(opts.concurrency, images.length || 1) }, worker));
    if (opts.signal && opts.signal.aborted) throw new DOMException('Aborted', 'AbortError');

    zip.add('index.csv', new TextEncoder().encode('\ufeff' + root.SiteScraperExport.csv(index)));
    return { blob: zip.finish(), saved: index.length - 1, failed, truncated };
  }

  root.SiteScraperImages = { collectImages, originPatterns, buildImageZip };
})(globalThis);
