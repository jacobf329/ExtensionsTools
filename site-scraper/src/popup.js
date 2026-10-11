const $ = (id) => document.getElementById(id);
const X = globalThis.SiteScraperExport;
let page = null;
let withImages = false; // whether the last scrape collected images

function setStatus(message, kind) {
  $('status').textContent = message;
  $('status').className = kind || 'muted';
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Remember checkbox choices between popup openings.
for (const id of ['mainOnly', 'includeImages']) {
  try {
    $(id).checked = localStorage.getItem(id) === '1';
  } catch (e) { /* storage unavailable */ }
  $(id).addEventListener('change', () => {
    try {
      localStorage.setItem(id, $(id).checked ? '1' : '0');
    } catch (e) { /* storage unavailable */ }
  });
}

$('scrape').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab || !/^https?:|^file:/.test(tab.url || '')) {
    setStatus('This page can’t be scraped (browser pages and the Web Store are off-limits).', 'error');
    return;
  }
  setStatus('Scraping…');
  $('scrape').disabled = true;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/extractor.js'] });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [$('mainOnly').checked, $('includeImages').checked],
      func: (mainOnly, includeImages) =>
        globalThis.SiteScraperExtract(document, location.href, { mainOnly, includeImages, live: true }),
    });
    page = result;
    withImages = $('includeImages').checked;
    render();
    setStatus(`Scraped ${page.wordCount.toLocaleString()} words (${X.formatBytes(X.pageBytes(page))} as JSON).`, 'ok');
  } catch (err) {
    setStatus('Scrape failed: ' + err.message, 'error');
  } finally {
    $('scrape').disabled = false;
  }
});

function render() {
  $('result').classList.remove('hidden');
  $('pageTitle').textContent = page.title || page.url;
  $('pageTitle').title = page.url;
  $('words').textContent = page.wordCount.toLocaleString();
  $('headings').textContent = page.headings.length;
  $('links').textContent = page.links.length;
  $('images').textContent = withImages ? page.images.length : 'off';
  document.querySelectorAll('.image-only').forEach((b) => b.classList.toggle('hidden', !withImages));
  $('preview').value = page.markdown;
}

async function copy(text, label) {
  await navigator.clipboard.writeText(text);
  setStatus(`${label} copied to clipboard.`, 'ok');
}

$('copyMd').addEventListener('click', () => copy(X.pageMarkdown(page), 'Markdown'));
$('copyText').addEventListener('click', () => copy(X.pageText(page), 'Text'));

document.querySelectorAll('[data-export]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const name = X.slug(page.url);
    switch (btn.dataset.export) {
      case 'md': return X.download(X.pageMarkdown(page), `${name}.md`, 'text/markdown');
      case 'txt': return X.download(X.pageText(page), `${name}.txt`, 'text/plain');
      case 'json': return X.download(JSON.stringify(page, null, 2), `${name}.json`, 'application/json');
      case 'links': return X.download(X.linksCsv([page]), `${name}-links.csv`, 'text/csv');
      case 'images': return X.download(X.imagesCsv([page]), `${name}-images.csv`, 'text/csv');
      case 'zip': return openImageDownloader();
    }
  });
});

// Image downloads may need a permission prompt, which can close the popup,
// so the ZIP is built in its own tab.
async function openImageDownloader() {
  if (!page.images.length) {
    setStatus('No images found on this page.', 'error');
    return;
  }
  await chrome.storage.session.set({
    imageJob: { source: page.url, title: page.title, images: page.images.map((i) => ({ ...i, page: page.url })) },
  });
  chrome.tabs.create({ url: chrome.runtime.getURL('src/images.html') });
  window.close();
}

$('crawl').addEventListener('click', async () => {
  const tab = await activeTab();
  const start = tab && /^https?:/.test(tab.url || '') ? tab.url : '';
  chrome.tabs.create({ url: chrome.runtime.getURL('src/crawler.html') + (start ? '?start=' + encodeURIComponent(start) : '') });
  window.close();
});
