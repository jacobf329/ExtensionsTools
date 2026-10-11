const $ = (id) => document.getElementById(id);
const X = globalThis.SiteScraperExport;
const I = globalThis.SiteScraperImages;
let job = null;
let abort = null;

function setStatus(message, kind) {
  $('status').textContent = message;
  $('status').className = kind || 'muted';
}

function log(message, kind) {
  const line = document.createElement('div');
  line.textContent = message;
  line.title = message;
  if (kind) line.className = kind;
  $('log').prepend(line);
}

chrome.storage.session.get('imageJob').then(({ imageJob }) => {
  if (!imageJob || !imageJob.images.length) {
    setStatus('No images to download. Scrape a page from the toolbar popup first.', 'error');
    return;
  }
  job = imageJob;
  $('source').textContent = `${job.images.length} images from ${job.title || job.source}`;
  $('source').title = job.source;
  $('startBtn').disabled = false;
  setStatus('Click “Download ZIP” to start. Chrome may ask for permission to fetch images from the sites that host them.');
});

$('startBtn').addEventListener('click', async () => {
  // Must be requested directly from the click, before any other await.
  const granted = await chrome.permissions.request({ origins: I.originPatterns(job.images) });
  if (!granted) {
    setStatus('Permission to download the images was not granted.', 'error');
    return;
  }

  abort = new AbortController();
  $('startBtn').disabled = true;
  $('stopBtn').disabled = false;
  $('log').textContent = '';
  $('progress').classList.remove('hidden');
  $('progress').max = job.images.length;
  $('progress').value = 0;
  const t0 = Date.now();
  try {
    const result = await I.buildImageZip(job.images, {
      signal: abort.signal,
      onProgress: (done, total, failed, bytes) => {
        $('progress').value = done;
        const left = done ? ` · ~${X.formatDuration(((Date.now() - t0) / done) * (total - done))} left` : '';
        setStatus(
          `Downloading images: ${done} / ${total}${failed ? ` (${failed} failed)` : ''} · ${X.formatBytes(bytes)}${left}…`
        );
      },
      onError: (src, message) => log(`✗ ${src}  ${message}`, 'error'),
    });
    X.download(result.blob, `${X.slug(job.source)}-images.zip`, 'application/zip');
    const notes = [result.failed ? `${result.failed} failed` : '', result.truncated ? 'stopped at the ZIP size limit' : '']
      .filter(Boolean).join(', ');
    setStatus(`Saved ${result.saved} images (${X.formatBytes(result.blob.size)}) to the ZIP${notes ? ` (${notes})` : ''}.`, result.saved ? 'ok' : 'error');
  } catch (err) {
    setStatus(err.name === 'AbortError' ? 'Cancelled.' : 'Image download failed: ' + err.message, 'error');
  } finally {
    $('startBtn').disabled = false;
    $('stopBtn').disabled = true;
  }
});

$('stopBtn').addEventListener('click', () => {
  if (abort) abort.abort();
});
