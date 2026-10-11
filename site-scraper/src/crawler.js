const $ = (id) => document.getElementById(id);
const X = globalThis.SiteScraperExport;
const extract = globalThis.SiteScraperExtract;

// Links to files we can't scrape as HTML pages.
const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|ico|bmp|tiff?|mp[34]|m4a|wav|ogg|webm|mov|avi|zip|rar|7z|gz|tar|dmg|exe|msi|apk|docx?|xlsx?|pptx?|csv|json|xml|rss|css|js|woff2?|ttf|eot)$/i;
const ESTIMATE_SAMPLE = 10; // pages fetched to measure speed and size
// Results are held in memory, which costs more than their exported size
// (object overhead, duplicate text + Markdown strings).
const MEMORY_FACTOR = 2;
const MEMORY_STOP_RATIO = 0.8; // auto-stop when the tab's JS heap is this full

let crawl = null;
let ticker = null;

const params = new URLSearchParams(location.search);
if (params.get('start')) $('start').value = params.get('start');

// Remember settings between crawls.
const SETTINGS = ['maxPages', 'concurrency', 'delay', 'samePath', 'mainOnly', 'includeImages', 'robots', 'sitemap'];
for (const id of SETTINGS) {
  const el = $(id);
  const key = 'crawler:' + id;
  try {
    const saved = localStorage.getItem(key);
    if (saved !== null) {
      if (el.type === 'checkbox') el.checked = saved === '1';
      else el.value = saved;
    }
  } catch (e) { /* storage unavailable */ }
  el.addEventListener('change', () => {
    try {
      localStorage.setItem(key, el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value);
    } catch (e) { /* storage unavailable */ }
  });
}

// Image exports only make sense if the crawl collected images.
document.querySelectorAll('.image-only').forEach((b) => b.classList.toggle('hidden', !$('includeImages').checked));

function log(message, kind) {
  const line = document.createElement('div');
  line.textContent = message;
  line.title = message;
  if (kind) line.className = kind;
  $('log').prepend(line);
  while ($('log').childElementCount > 500) $('log').lastChild.remove();
}

function setStatus(message, kind) {
  $('status').textContent = message;
  $('status').className = kind || 'muted';
}

/** JS heap usage of this tab, where Chrome exposes it. */
function heap() {
  const m = performance.memory;
  return m ? { used: m.usedJSHeapSize, limit: m.jsHeapSizeLimit } : null;
}

function updateStats() {
  if (!crawl) return;
  $('pages').textContent = crawl.pages.length.toLocaleString();
  $('queued').textContent = crawl.queue.length.toLocaleString();
  $('words').textContent = crawl.words.toLocaleString();
  $('errors').textContent = crawl.errors.toLocaleString();
  $('progress').max = crawl.maxPages;
  $('progress').value = crawl.pages.length;

  const elapsed = (crawl.finishedAt || Date.now()) - crawl.startedMs;
  $('elapsed').textContent = X.formatDuration(elapsed);
  $('dataSize').textContent = X.formatBytes(crawl.bytes);
  const h = heap();
  $('memory').textContent = h ? X.formatBytes(h.used) : 'n/a';
  $('memory').title = h ? `Browser limit for this tab: ${X.formatBytes(h.limit)}` : '';

  if (crawl.running && crawl.pages.length >= 3) {
    // Pages still to do: what's known so far, capped by the page limit.
    const target = Math.min(crawl.maxPages, crawl.pages.length + crawl.queue.length + crawl.inFlight);
    const rate = crawl.pages.length / elapsed; // pages per ms
    $('timeLeft').textContent = '~' + X.formatDuration((target - crawl.pages.length) / rate);
    $('speed').textContent = `Speed: ${Math.round(rate * 60000).toLocaleString()} pages/min`;
  } else if (!crawl.running) {
    $('timeLeft').textContent = '–';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalize(raw, base) {
  let u;
  try {
    u = new URL(raw, base);
  } catch (e) {
    return null;
  }
  if (!/^https?:$/.test(u.protocol) || u.origin !== crawl.origin) return null;
  if (crawl.pathPrefix && !u.pathname.startsWith(crawl.pathPrefix)) return null;
  if (SKIP_EXT.test(u.pathname)) return null;
  if (crawl.robots && !crawl.robots(u.pathname + u.search)) return null;
  u.hash = '';
  return u.href;
}

function enqueue(raw, base) {
  const url = normalize(raw, base);
  if (!url || crawl.seen.has(url)) return;
  crawl.seen.add(url);
  crawl.queue.push(url);
}

async function decode(res) {
  const buf = await res.arrayBuffer();
  let charset = (/charset=([^;]+)/i.exec(res.headers.get('content-type') || '') || [])[1];
  if (!charset) {
    const head = new TextDecoder('ascii').decode(buf.slice(0, 2048));
    charset = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(head) || [])[1];
  }
  try {
    return new TextDecoder((charset || 'utf-8').trim()).decode(buf);
  } catch (e) {
    return new TextDecoder('utf-8').decode(buf);
  }
}

async function fetchText(url) {
  const res = await fetch(url, { credentials: 'include', signal: crawl.abort.signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { res, text: await decode(res) };
}

// Minimal robots.txt support: Allow/Disallow rules in the "*" group, longest match wins.
async function loadRobots() {
  try {
    const { text } = await fetchText(crawl.origin + '/robots.txt');
    const rules = [];
    const sitemaps = [];
    let applies = false;
    let lastWasAgent = false;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*/, '').trim();
      const m = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const value = m[2].trim();
      if (key === 'sitemap') {
        sitemaps.push(value);
        continue;
      }
      if (key === 'user-agent') {
        if (!lastWasAgent) applies = false;
        if (value === '*') applies = true;
        lastWasAgent = true;
        continue;
      }
      lastWasAgent = false;
      if (applies && (key === 'allow' || key === 'disallow') && value) {
        const pattern = new RegExp('^' + value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
        rules.push({ allow: key === 'allow', pattern, length: value.length });
      }
    }
    crawl.robotSitemaps = sitemaps;
    if (!rules.length) return null;
    return (path) => {
      let best = null;
      for (const r of rules) if (r.pattern.test(path) && (!best || r.length > best.length)) best = r;
      return !best || best.allow;
    };
  } catch (e) {
    return null;
  }
}

async function seedFromSitemaps() {
  const pending = crawl.robotSitemaps.length ? crawl.robotSitemaps.slice() : [crawl.origin + '/sitemap.xml'];
  let fetched = 0;
  let added = 0;
  while (pending.length && fetched < 20 && crawl.running) {
    const sitemapUrl = pending.shift();
    fetched++;
    try {
      const { text } = await fetchText(sitemapUrl);
      const xml = new DOMParser().parseFromString(text, 'application/xml');
      const isIndex = xml.getElementsByTagName('sitemapindex').length > 0;
      for (const loc of xml.getElementsByTagName('loc')) {
        const value = loc.textContent.trim();
        if (isIndex) {
          pending.push(value);
        } else {
          const before = crawl.queue.length;
          enqueue(value, sitemapUrl);
          added += crawl.queue.length - before;
        }
      }
    } catch (e) {
      // No sitemap, or not reachable; the link crawl still runs.
    }
  }
  crawl.sitemapCount = added;
  crawl.sitemapPartial = pending.length > 0; // more sitemap files than we read
  if (added) log(`Added ${added} URLs from sitemap${crawl.sitemapPartial ? ' (more sitemap files not read)' : ''}`, 'muted');
}

async function scrapeOne(url) {
  const { res, text } = await fetchText(url);
  const type = res.headers.get('content-type') || '';
  if (type && !/html/i.test(type)) throw new Error(`skipped (${type.split(';')[0]})`);

  // Follow redirects without scraping the same final page twice.
  const finalUrl = res.url || url;
  if (finalUrl !== url) {
    const normalized = normalize(finalUrl, url);
    if (!normalized) throw new Error('redirected off-site');
    if (crawl.scraped.has(normalized)) throw new Error('duplicate (redirect)');
    crawl.seen.add(normalized);
  }
  if (crawl.scraped.has(finalUrl)) throw new Error('duplicate');
  crawl.scraped.add(finalUrl);

  const doc = new DOMParser().parseFromString(text, 'text/html');
  const page = extract(doc, finalUrl, { mainOnly: crawl.mainOnly, includeImages: crawl.includeImages });
  for (const link of page.links) if (link.internal) enqueue(link.href, finalUrl);
  return page;
}

function stopForMemory() {
  const h = heap();
  if (!h || h.used < h.limit * MEMORY_STOP_RATIO) return false;
  crawl.running = false;
  crawl.memoryStop = true;
  log(`Stopped: this tab is using ${X.formatBytes(h.used)} of its ${X.formatBytes(h.limit)} memory limit`, 'error');
  return true;
}

async function worker() {
  while (crawl.running) {
    if (crawl.pages.length + crawl.inFlight >= crawl.maxPages) break;
    const url = crawl.queue.shift();
    if (!url) {
      if (crawl.inFlight === 0) break;
      await sleep(100);
      continue;
    }
    crawl.inFlight++;
    try {
      const page = await scrapeOne(url);
      crawl.pages.push(page);
      crawl.words += page.wordCount;
      crawl.bytes += X.pageBytes(page);
      log(`✓ ${page.url}  (${page.wordCount} words)`);
    } catch (err) {
      if (err.name === 'AbortError') break;
      crawl.errors++;
      log(`✗ ${url}  ${err.message}`, 'error');
    } finally {
      crawl.inFlight--;
      updateStats();
    }
    if (stopForMemory()) break;
    if (crawl.delay) await sleep(crawl.delay);
  }
}

function setExportsEnabled(enabled) {
  document.querySelectorAll('[data-export]').forEach((b) => { b.disabled = !enabled; });
}

function readStartUrl() {
  try {
    const start = new URL($('start').value.trim());
    if (/^https?:$/.test(start.protocol)) return start;
  } catch (e) { /* invalid */ }
  setStatus('Enter a full http(s) URL to start from.', 'error');
  return null;
}

function newCrawl(start) {
  const dir = start.pathname.endsWith('/') ? start.pathname : start.pathname.replace(/[^/]*$/, '');
  return {
    origin: start.origin,
    pathPrefix: $('samePath').checked ? dir : '',
    maxPages: Math.max(1, Number($('maxPages').value) || 100),
    concurrency: Math.min(10, Math.max(1, Number($('concurrency').value) || 3)),
    delay: Math.max(0, Number($('delay').value) || 0),
    mainOnly: $('mainOnly').checked,
    includeImages: $('includeImages').checked,
    robots: null,
    robotSitemaps: [],
    sitemapCount: 0,
    sitemapPartial: false,
    queue: [],
    seen: new Set(),
    scraped: new Set(),
    pages: [],
    words: 0,
    bytes: 0,
    errors: 0,
    inFlight: 0,
    running: true,
    memoryStop: false,
    abort: new AbortController(),
    startedAt: new Date().toISOString(),
    startedMs: Date.now(),
    finishedAt: 0,
  };
}

/** Reads robots.txt and the sitemap, and queues the start URL. */
async function prepare(start) {
  if ($('robots').checked) {
    setStatus('Reading robots.txt…');
    crawl.robots = await loadRobots();
  }
  enqueue(start.href);
  if (!crawl.queue.length) log('The start URL is blocked by robots.txt', 'error');
  if ($('sitemap').checked) {
    setStatus('Reading sitemap…');
    await seedFromSitemaps();
  }
}

function setBusy(busy) {
  $('startBtn').disabled = busy;
  $('estimateBtn').disabled = busy;
  $('stopBtn').disabled = !busy;
}

async function requestSite(start) {
  const granted = await chrome.permissions.request({ origins: [start.origin + '/*'] });
  if (!granted) setStatus(`Permission to read ${start.origin} was not granted.`, 'error');
  return granted;
}

$('startBtn').addEventListener('click', async () => {
  const start = readStartUrl();
  // The permission request must come straight from the click, before any other await.
  if (!start || !(await requestSite(start))) return;

  crawl = newCrawl(start);
  $('log').textContent = '';
  $('estimate').classList.add('hidden');
  setBusy(true);
  $('progress').classList.remove('hidden');
  setExportsEnabled(false);
  document.querySelectorAll('.image-only').forEach((b) => b.classList.toggle('hidden', !crawl.includeImages));
  updateStats();
  ticker = setInterval(updateStats, 1000);

  await prepare(start);
  setStatus(`Crawling ${crawl.origin}…`);
  await Promise.all(Array.from({ length: crawl.concurrency }, worker));

  clearInterval(ticker);
  const stopped = !crawl.running;
  crawl.running = false;
  crawl.finishedAt = Date.now();
  setBusy(false);
  updateStats();
  setExportsEnabled(crawl.pages.length > 0);
  const left = crawl.queue.length ? ` ${crawl.queue.length.toLocaleString()} URLs were left in the queue.` : '';
  const why = crawl.memoryStop ? ' (memory limit reached; export now, then crawl a smaller section)' : '';
  setStatus(
    `${stopped ? 'Stopped' : 'Done'}${why}: scraped ${crawl.pages.length.toLocaleString()} pages ` +
      `(${X.formatBytes(crawl.bytes)}) in ${X.formatDuration(crawl.finishedAt - crawl.startedMs)}.${left}`,
    crawl.pages.length ? 'ok' : 'error'
  );
});

$('stopBtn').addEventListener('click', () => {
  if (!crawl) return;
  crawl.running = false;
  crawl.abort.abort();
  $('stopBtn').disabled = true;
  setStatus('Stopping…');
});

window.addEventListener('beforeunload', (e) => {
  if (crawl && crawl.running) e.preventDefault();
});

// --- Estimate -------------------------------------------------------------

/** Average size of a few images, from their Content-Length headers. */
async function sampleImageBytes(images) {
  const sizes = [];
  for (const img of images.slice(0, 8)) {
    try {
      const res = await fetch(img.src, { method: 'HEAD', credentials: 'include', signal: crawl.abort.signal });
      const len = Number(res.headers.get('content-length'));
      if (res.ok && len > 0) sizes.push(len);
    } catch (e) {
      if (!crawl.running) break;
    }
  }
  return sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : null;
}

/** Picks sample URLs spread across the queue, so one section doesn't dominate. */
function sampleUrls(n) {
  const q = crawl.queue;
  if (q.length <= n) return q.slice();
  const picks = [q[0]];
  for (let i = 1; i < n; i++) picks.push(q[Math.floor((i * (q.length - 1)) / (n - 1))]);
  return Array.from(new Set(picks));
}

$('estimateBtn').addEventListener('click', async () => {
  const start = readStartUrl();
  if (!start || !(await requestSite(start))) return;

  crawl = newCrawl(start);
  $('log').textContent = '';
  $('estimate').classList.add('hidden');
  setExportsEnabled(false);
  setBusy(true);
  try {
    await prepare(start);

    const samples = [];
    const imageSrcs = new Map();
    let imagesSeen = 0;
    for (const url of sampleUrls(ESTIMATE_SAMPLE)) {
      if (!crawl.running) break;
      setStatus(`Sampling pages to measure speed and size (${samples.length + 1}/${ESTIMATE_SAMPLE})…`);
      const t0 = performance.now();
      try {
        const page = await scrapeOne(url);
        samples.push({ ms: performance.now() - t0, bytes: X.pageBytes(page) });
        imagesSeen += page.images.length;
        for (const img of page.images) imageSrcs.set(img.src, img);
        log(`sampled ${page.url}  (${X.formatBytes(X.pageBytes(page))})`, 'muted');
      } catch (err) {
        if (err.name === 'AbortError') break;
        log(`✗ ${url}  ${err.message}`, 'error');
      }
      if (crawl.delay) await sleep(crawl.delay);
    }
    if (!crawl.running) {
      setStatus('Estimate cancelled.');
      return;
    }
    if (!samples.length) {
      setStatus('Couldn’t load any pages to estimate from. Check the start URL.', 'error');
      return;
    }

    let imageBytes = null;
    if (crawl.includeImages && imageSrcs.size) {
      setStatus('Checking image sizes…');
      imageBytes = await sampleImageBytes(Array.from(imageSrcs.values()));
    }
    showEstimate(samples, imageSrcs.size, imagesSeen, imageBytes);
    setStatus('Estimate ready. These are rough figures from a small sample.', 'ok');
  } finally {
    crawl.running = false;
    setBusy(false);
  }
});

function showEstimate(samples, uniqueImages, imagesSeen, imageBytes) {
  const avg = (key) => samples.reduce((n, s) => n + s[key], 0) / samples.length;
  const msPerPage = avg('ms');
  const bytesPerPage = avg('bytes');
  // Each worker fetches one page, then waits for the delay.
  const pagesPerMs = crawl.concurrency / (msPerPage + crawl.delay);

  const known = crawl.seen.size; // sitemap URLs + links found on the sampled pages
  const fromSitemap = crawl.sitemapCount > 0;
  const planned = Math.min(crawl.maxPages, known);
  // Without a sitemap we only know about pages linked from the sample, so the
  // crawl will usually keep discovering more until it reaches the page limit.
  const likely = fromSitemap && !crawl.sitemapPartial ? planned : crawl.maxPages;

  // Unique images per sampled page, so logos and icons repeated on every page count once.
  const newImagesPerPage = uniqueImages / samples.length;
  const h = heap();

  const rows = [];
  const add = (label, value) => rows.push([label, value]);
  add(
    'Pages on the site',
    fromSitemap
      ? `${known.toLocaleString()}${crawl.sitemapPartial ? '+' : ''} (from the sitemap)`
      : `at least ${known.toLocaleString()} (no sitemap; more will be discovered while crawling)`
  );
  add('Average page', `${Math.round(msPerPage).toLocaleString()} ms to load, ${X.formatBytes(bytesPerPage)} of data`);
  const forPages = (n) =>
    `~${X.formatDuration(n / pagesPerMs)}, ~${X.formatBytes(n * bytesPerPage)} of data, ` +
    `~${X.formatBytes(n * bytesPerPage * MEMORY_FACTOR)} browser memory`;
  add(`Crawling ${likely.toLocaleString()} pages (your limit${likely < crawl.maxPages ? ' or site size' : ''})`, forPages(likely));
  if (known > crawl.maxPages) add(`Whole site (${known.toLocaleString()} pages)`, forPages(known));

  if (crawl.includeImages) {
    if (!uniqueImages) {
      add('Images', 'none found on the sampled pages');
    } else {
      const total = Math.round(newImagesPerPage * likely);
      add(
        'Image ZIP',
        `~${total.toLocaleString()} images` +
          (imageBytes ? `, ~${X.formatBytes(total * imageBytes)} (avg ${X.formatBytes(imageBytes)} each)` : ', size unknown') +
          ` (${imagesSeen} image references on ${samples.length} pages)`
      );
    }
  } else {
    add('Images', 'off (text only)');
  }

  const table = $('estimateTable');
  table.textContent = '';
  for (const [label, value] of rows) {
    const tr = table.insertRow();
    tr.insertCell().textContent = label;
    tr.insertCell().textContent = value;
  }

  const warn = $('estimateWarn');
  const needed = likely * bytesPerPage * MEMORY_FACTOR;
  if (h && needed > h.limit * MEMORY_STOP_RATIO) {
    warn.textContent =
      `That's more than this tab can hold (limit ${X.formatBytes(h.limit)}). The crawl will stop automatically ` +
      'before running out; lower Max pages, turn on “Main content only”, or crawl one section at a time ' +
      'with “Stay under the start URL’s folder”.';
    warn.classList.remove('hidden');
  } else {
    warn.classList.add('hidden');
  }
  $('estimate').classList.remove('hidden');
}

// --- Export ---------------------------------------------------------------

document.querySelectorAll('[data-export]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const pages = crawl.pages;
    const name = X.slug(crawl.origin);
    switch (btn.dataset.export) {
      case 'md':
        return X.download(pages.map(X.pageMarkdown).join('\n\n'), `${name}.md`, 'text/markdown');
      case 'txt':
        return X.download(pages.map(X.pageText).join('\n\n========\n\n'), `${name}.txt`, 'text/plain');
      case 'json':
        return X.download(
          JSON.stringify({ site: crawl.origin, crawledAt: crawl.startedAt, pageCount: pages.length, pages }, null, 2),
          `${name}.json`,
          'application/json'
        );
      case 'pages': return X.download(X.pagesCsv(pages), `${name}-pages.csv`, 'text/csv');
      case 'links': return X.download(X.linksCsv(pages), `${name}-links.csv`, 'text/csv');
      case 'images': return X.download(X.imagesCsv(pages), `${name}-images.csv`, 'text/csv');
      case 'zip': return downloadImagesZip(btn);
      case 'emails': {
        const found = new Map();
        for (const p of pages) for (const e of p.emails) if (!found.has(e)) found.set(e, p.url);
        return X.download(X.csv([['email', 'found_on']].concat(Array.from(found))), `${name}-emails.csv`, 'text/csv');
      }
    }
  });
});

async function downloadImagesZip(btn) {
  const I = globalThis.SiteScraperImages;
  const images = I.collectImages(crawl.pages);
  if (!images.length) {
    setStatus('No images were found on the crawled pages.', 'error');
    return;
  }
  // Images are often served from CDNs on other domains, which need their own permission.
  const granted = await chrome.permissions.request({ origins: I.originPatterns(images) });
  if (!granted) {
    setStatus('Permission to download the images was not granted.', 'error');
    return;
  }

  btn.disabled = true;
  $('startBtn').disabled = true;
  $('estimateBtn').disabled = true;
  $('progress').classList.remove('hidden');
  $('progress').max = images.length;
  $('progress').value = 0;
  const t0 = Date.now();
  try {
    const result = await I.buildImageZip(images, {
      onProgress: (done, total, failed, bytes) => {
        $('progress').value = done;
        const left = done ? ` · ~${X.formatDuration(((Date.now() - t0) / done) * (total - done))} left` : '';
        setStatus(
          `Downloading images: ${done} / ${total}${failed ? ` (${failed} failed)` : ''} · ${X.formatBytes(bytes)}${left}…`
        );
      },
      onError: (src, message) => log(`✗ ${src}  ${message}`, 'error'),
    });
    X.download(result.blob, `${X.slug(crawl.origin)}-images.zip`, 'application/zip');
    const notes = [result.failed ? `${result.failed} failed` : '', result.truncated ? 'stopped at the ZIP size limit' : '']
      .filter(Boolean).join(', ');
    setStatus(`Saved ${result.saved} images (${X.formatBytes(result.blob.size)}) to the ZIP${notes ? ` (${notes})` : ''}.`, 'ok');
  } catch (err) {
    setStatus('Image download failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    $('startBtn').disabled = false;
    $('estimateBtn').disabled = false;
    $('progress').max = crawl.maxPages;
    $('progress').value = crawl.pages.length;
  }
}
