const $ = (id) => document.getElementById(id);
const X = globalThis.SiteScraperExport;
const extract = globalThis.SiteScraperExtract;

// Links to files we can't scrape as HTML pages.
const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|ico|bmp|tiff?|mp[34]|m4a|wav|ogg|webm|mov|avi|zip|rar|7z|gz|tar|dmg|exe|msi|apk|docx?|xlsx?|pptx?|csv|json|xml|rss|css|js|woff2?|ttf|eot)$/i;

let crawl = null;

const params = new URLSearchParams(location.search);
if (params.get('start')) $('start').value = params.get('start');

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

function updateStats() {
  $('pages').textContent = crawl.pages.length.toLocaleString();
  $('queued').textContent = crawl.queue.length.toLocaleString();
  $('words').textContent = crawl.pages.reduce((n, p) => n + p.wordCount, 0).toLocaleString();
  $('errors').textContent = crawl.errors.toLocaleString();
  $('progress').max = crawl.maxPages;
  $('progress').value = crawl.pages.length;
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
  if (added) log(`Added ${added} URLs from sitemap`, 'muted');
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
  const page = extract(doc, finalUrl, { mainOnly: crawl.mainOnly });
  for (const link of page.links) if (link.internal) enqueue(link.href, finalUrl);
  return page;
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
      log(`✓ ${page.url}  (${page.wordCount} words)`);
    } catch (err) {
      if (err.name === 'AbortError') break;
      crawl.errors++;
      log(`✗ ${url}  ${err.message}`, 'error');
    } finally {
      crawl.inFlight--;
      updateStats();
    }
    if (crawl.delay) await sleep(crawl.delay);
  }
}

function setExportsEnabled(enabled) {
  document.querySelectorAll('[data-export]').forEach((b) => { b.disabled = !enabled; });
}

$('startBtn').addEventListener('click', async () => {
  let start;
  try {
    start = new URL($('start').value.trim());
    if (!/^https?:$/.test(start.protocol)) throw new Error();
  } catch (e) {
    setStatus('Enter a full http(s) URL to start from.', 'error');
    return;
  }

  // Must be requested directly from the click, before any other await.
  const granted = await chrome.permissions.request({ origins: [start.origin + '/*'] });
  if (!granted) {
    setStatus(`Permission to read ${start.origin} was not granted.`, 'error');
    return;
  }

  const dir = start.pathname.endsWith('/') ? start.pathname : start.pathname.replace(/[^/]*$/, '');
  crawl = {
    origin: start.origin,
    pathPrefix: $('samePath').checked ? dir : '',
    maxPages: Math.max(1, Number($('maxPages').value) || 100),
    concurrency: Math.min(10, Math.max(1, Number($('concurrency').value) || 3)),
    delay: Math.max(0, Number($('delay').value) || 0),
    mainOnly: $('mainOnly').checked,
    robots: null,
    robotSitemaps: [],
    queue: [],
    seen: new Set(),
    scraped: new Set(),
    pages: [],
    errors: 0,
    inFlight: 0,
    running: true,
    abort: new AbortController(),
    startedAt: new Date().toISOString(),
  };

  $('log').textContent = '';
  $('startBtn').disabled = true;
  $('stopBtn').disabled = false;
  $('progress').classList.remove('hidden');
  setExportsEnabled(false);
  updateStats();

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

  setStatus(`Crawling ${crawl.origin}…`);
  await Promise.all(Array.from({ length: crawl.concurrency }, worker));

  const stopped = !crawl.running;
  crawl.running = false;
  $('startBtn').disabled = false;
  $('stopBtn').disabled = true;
  updateStats();
  setExportsEnabled(crawl.pages.length > 0);
  const left = crawl.queue.length ? ` ${crawl.queue.length} URLs were left in the queue.` : '';
  setStatus(
    `${stopped ? 'Stopped' : 'Done'}: scraped ${crawl.pages.length} pages.${left}`,
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
      case 'emails': {
        const found = new Map();
        for (const p of pages) for (const e of p.emails) if (!found.has(e)) found.set(e, p.url);
        return X.download(X.csv([['email', 'found_on']].concat(Array.from(found))), `${name}-emails.csv`, 'text/csv');
      }
    }
  });
});
