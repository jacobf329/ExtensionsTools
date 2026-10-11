# Site Scraper (Chrome extension)

Grab all the content from a web page in one click, or crawl a whole website, and export it as
Markdown, plain text, JSON or CSV.

## Install (developer mode)

1. Get the files: download this repository as a ZIP from GitHub (green **Code** button →
   **Download ZIP**) and unzip it, or `git clone` it.
2. Open `chrome://extensions` in Chrome (or any Chromium browser: Edge, Brave, Arc).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the `site-scraper` folder (the one containing `manifest.json`).
5. Pin the extension from the puzzle-piece menu so it's one click away.

To update after changing or re-downloading the files, click the reload arrow on the extension's
card in `chrome://extensions`. Don't delete the folder; Chrome loads the extension from it.

## Scrape one page

Click the toolbar icon, then **Scrape this page**. You get:

- word, heading, link and image counts, plus a Markdown preview
- **Copy Markdown** / **Copy text** to the clipboard
- downloads: `.md`, `.txt`, `.json` (everything), `links.csv`, `images.csv`
- **images.zip**: every image on the page in one ZIP (opens a small download tab)

This reads the page as rendered in your tab, so it works on JavaScript-heavy sites and on pages
you're logged in to. Tick **Main content only** to skip navigation, headers, footers and sidebars.

Images are **off by default** (text only). Tick **Include images** to list them and enable the
image downloads. Your checkbox choices are remembered.

## Crawl a whole site

Click **Crawl whole site…**. A crawler tab opens with the current page as the start URL.

| Setting | What it does |
| --- | --- |
| Max pages | Stops after this many pages (default 100). |
| Parallel requests | How many pages are fetched at once (1–10). |
| Delay | Pause between requests per worker. Raise it for small sites. |
| Stay under the start URL's folder | e.g. start at `/blog/` to crawl just the blog. |
| Respect robots.txt | Skips paths the site disallows. |
| Also seed from sitemap.xml | Finds pages that aren't linked from anywhere. |
| Include images | Off by default (text only). Turn on to collect image lists and enable the image ZIP. |

Settings are remembered between crawls.

### Before a big crawl: Estimate time & size

**Estimate time & size** reads the sitemap to count the site's pages, then loads 10 sample
pages spread across the site to measure how long each takes and how much data it produces. It
shows:

- how many pages the site has (exact from the sitemap, otherwise a lower bound)
- time, export size and browser memory for your **Max pages** limit, and for the whole site
- with images on: roughly how many images there are and how big the ZIP will be

Figures are rough. Real time depends on how the server responds during the crawl.

### While crawling

The crawler shows elapsed time, estimated time left, pages per minute, how much data has been
collected and how much memory the tab is using. Results are kept in the tab's memory until you
export them. If memory gets close to Chrome's per-tab limit (usually a few GB), the crawl stops
by itself so the tab doesn't crash; export what you have, then crawl a smaller section with
**Stay under the start URL's folder**.

Chrome asks once for permission to read that site. Keep the crawler tab open while it runs; you
can **Stop** at any time and still export what was collected.

Exports: all pages as one `.md` or `.txt`, a `.json` with everything, `pages.csv`,
`links.csv`, `images.csv`, `emails.csv`, and **All images (.zip)**.

## Image ZIPs

The ZIP holds each image once (even if it appears on many pages) plus an `index.csv` mapping
every file back to its original URL, alt text and the page it was found on. Clashing filenames
get a suffix (`photo.png`, `photo-2.png`), and files whose URL has no extension get one from
their content. Images that fail to download are listed in the log and skipped.

Images are often hosted on other domains (CDNs), so Chrome asks for permission to read those
too. ZIPs are capped at about 3.5 GB.

## What gets extracted

For every page: URL, title, meta description, language, canonical URL, author/keywords/OG image,
headings, all links (marked internal or external), images, tables (as rows), email addresses,
clean Markdown, plain text and a word count.

## Limitations

- The crawler fetches raw HTML and doesn't run JavaScript, so pages that build their content
  in the browser (some single-page apps) can come back thin. For those, open the page and use
  **Scrape this page** instead.
- Only stays on the start URL's origin; it doesn't follow links to other domains.
- Respect each site's terms of service and keep request rates reasonable.

## Files

```
manifest.json      Manifest V3 config
src/extractor.js   HTML → Markdown/text/structured data (shared by popup and crawler)
src/export.js      CSV/Markdown formatting and downloads
src/zip.js         Minimal ZIP writer (no dependencies)
src/imagezip.js    Fetches images and packs them into a ZIP
src/images.*       Image ZIP download tab (opened from the popup)
src/popup.*        Toolbar popup (single page)
src/crawler.*      Full-site crawler page
src/styles.css     Shared styles (light/dark)
icons/             Toolbar icons
```
