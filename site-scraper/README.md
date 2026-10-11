# Site Scraper (Chrome extension)

Grab all the content from a web page in one click, or crawl a whole website, and export it as
Markdown, plain text, JSON or CSV.

## Install (developer mode)

1. Open `chrome://extensions` in Chrome (or any Chromium browser: Edge, Brave, Arc).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `site-scraper` folder.
4. Pin the extension from the puzzle-piece menu so it's one click away.

## Scrape one page

Click the toolbar icon, then **Scrape this page**. You get:

- word, heading, link and image counts, plus a Markdown preview
- **Copy Markdown** / **Copy text** to the clipboard
- downloads: `.md`, `.txt`, `.json` (everything), `links.csv`, `images.csv`
- **images.zip**: every image on the page in one ZIP (opens a small download tab)

This reads the page as rendered in your tab, so it works on JavaScript-heavy sites and on pages
you're logged in to. Tick **Main content only** to skip navigation, headers, footers and sidebars.

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
