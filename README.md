# Diff Viewer

A static, client-side diff viewer. Paste text, open a file on each side, or drop
two files together. Files are read locally; no server receives their contents.

Images have a reveal slider and side-by-side view. PDFs use the same views with
page navigation and an extracted-text diff. CSV, TSV, Excel, and OpenDocument
spreadsheets have row alignment, cell highlights, and a sheet selector. Word,
PowerPoint, OpenDocument, and EPUB documents use extracted-text diffs. Browser
audio/video formats have independent playback controls. Other binary files get
an exact contents comparison.

Document text extraction does not compare formatting or embedded images, and
PDF text mode does not perform OCR. Spreadsheet comparison uses displayed cell
values, not formulas or formatting. File identity is checked separately from
the rendered diff, including when text has been edited after opening a file.

Serve the repository with any static HTTP server; there is no build step:

```sh
npm start
```

Then visit http://localhost:4173. ES modules and workers require an HTTP origin,
so opening `index.html` directly from the filesystem is not supported.

For checks:

```sh
npm ci
npm test
npx playwright install --with-deps chromium
npm run test:browser
```

Parsers are pinned, vendored, and loaded on demand. See [vendor/README.md](vendor/README.md)
for their sources and licenses. File reading is capped at 50 MB, with separate
text/table limits and a timeout for spreadsheet and archive parsing. Large text
diffs bound the LCS calculation and may group a large replacement as a block.
