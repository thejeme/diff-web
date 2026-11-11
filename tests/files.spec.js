import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const library = (path, name) => {
  const context = { Uint8Array, ArrayBuffer, TextEncoder, TextDecoder, console };
  vm.runInNewContext(readFileSync(new URL(path, import.meta.url), 'utf8'), context);
  return context[name];
};
const fflate = library('../vendor/fflate/umd/index.js', 'fflate');
const XLSX = library('../vendor/xlsx.full.min.js', 'XLSX');
const upload = (name, text, mimeType = 'text/plain') => ({ name, mimeType, buffer: Buffer.from(text) });
const zip = files => Buffer.from(fflate.zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, fflate.strToU8(text)]))));
const xml = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
const word = text => zip({ 'word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${xml(text)}</w:t></w:r></w:p></w:body></w:document>` });
const slides = text => zip({ 'ppt/slides/slide1.xml': `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>${xml(text)}</a:t></a:r></a:p></p:sld>` });
const odt = text => zip({ 'content.xml': `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:p>${xml(text)}</text:p></office:text></office:body></office:document-content>` });
const epub = text => zip({
  'META-INF/container.xml': '<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>',
  'OEBPS/book.opf': '<package><manifest><item id="a" href="chapter.xhtml"/></manifest><spine><itemref idref="a"/></spine></package>',
  'OEBPS/chapter.xhtml': `<html><head><title>Ignore title</title></head><body><p>${xml(text)}</p></body></html>`
});
const workbook = (sheets, bookType = 'xlsx') => {
  const book = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  return Buffer.from(XLSX.write(book, { type: 'array', bookType }));
};
const svg = (color, width = 800, height = 480) => upload(`${color}.svg`, `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#e7dfd0"/><circle cx="${color === 'orange' ? 280 : 440}" cy="240" r="130" fill="${color}"/><text x="40" y="65" font-family="monospace" font-size="25" fill="#322c23">A simple change.</text></svg>`, 'image/svg+xml');
async function openPair(page, before, after) {
  await page.locator('#original-file').setInputFiles(before);
  await expect(page.locator('[data-side="original"]')).toHaveAttribute('aria-busy', 'false');
  await page.locator('#modified-file').setInputFiles(after);
  await expect(page.locator('[data-side="modified"]')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.result-body')).toHaveAttribute('aria-busy', 'false');
}

test.beforeEach(async ({ page }) => { await page.goto('/'); });

test('pasted text, keyboard compare, escaping, copy and clearing', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('#original').fill('same\nbefore\n<img src=x onerror=alert(1)>');
  await page.locator('#modified').fill('same\nafter\n<img src=x onerror=alert(1)>');
  await page.locator('#modified').press('Control+Enter');
  await expect(page.locator('.result-stats')).toContainText('+1 addition');
  await expect(page.locator('.result-stats')).toContainText('−1 deletion');
  await expect(page.locator('.line-diff img')).toHaveCount(0);
  await page.getByRole('button', { name: 'Copy diff' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('- before\n+ after');
  await page.locator('#clear-btn').click();
  await expect(page.locator('#original')).toBeEmpty();
  await expect(page.locator('.placeholder')).toBeVisible();
});

test('text uploads retain editable content and normalize Windows line endings', async ({ page }) => {
  await openPair(page, upload('old.md', 'hello\r\nworld'), upload('new.json', 'hello\nworld'));
  await expect(page.locator('.result-stats')).toHaveText('Text is identical');
  await expect(page.locator('.identity-status')).toHaveText('File contents differ.');
  await page.locator('#modified').fill('hello\nchanged');
  await page.locator('#compare-btn').click();
  await expect(page.locator('.result-stats')).toContainText('+1 addition');
  await expect(page.locator('.identity-status')).toContainText('includes your edits');
  await page.getByRole('button', { name: 'Remove modified file' }).click();
  await expect(page.locator('#modified')).toBeEmpty();
  await expect(page.locator('#original-meta')).toContainText('old.md');
});

test('CSV highlights cells and aligns inserted rows, and can switch back to text', async ({ page }) => {
  await openPair(page, upload('old.csv', 'Name,Count\nAlice,1\nBob,2'), upload('new.csv', 'Name,Count\nNew,0\nAlice,1\nBob,3'));
  await expect(page.locator('.result-stats')).toContainText('1 changed cell');
  await expect(page.locator('.result-stats')).toContainText('+1 row');
  await expect(page.locator('.changed-cell del')).toHaveText('2');
  await expect(page.locator('.changed-cell ins')).toHaveText('3');
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await expect(page.locator('.line-diff')).toBeVisible();
  await page.locator('#modified').fill('Name,Count\nAlice,1\nBob,2');
  await page.locator('#compare-btn').click();
  await expect(page.locator('.result-stats')).toHaveText('Tables are identical');
});

test('CSV and TSV compare parsed values including multiline and escaped quotes', async ({ page }) => {
  await openPair(page, upload('a.csv', 'name;note\r\nAlice;"one, two"\r\nBob;"a ""quote""\nand a line"\r\n'), upload('b.tsv', 'name\tnote\nAlice\tone, two\nBob\t"a ""quote""\nand a line"\n'));
  await expect(page.locator('.result-stats')).toHaveText('Tables are identical');
});

for (const format of ['xlsx', 'xls', 'ods']) {
  test(`${format} workbooks compare cells and expose added or missing sheets`, async ({ page }) => {
    const before = workbook({ Main: [['Name', 'Count'], ['Alice', 1]], Removed: [['old']] }, format);
    const after = workbook({ Main: [['Name', 'Count'], ['Alice', 2]], Added: [['new']] }, format);
    await openPair(page, { name: `old.${format}`, mimeType: 'application/octet-stream', buffer: before }, { name: `new.${format}`, mimeType: 'application/octet-stream', buffer: after });
    await expect(page.locator('.changed-cell ins')).toHaveText('2');
    await page.getByLabel('Sheet', { exact: true }).selectOption('Removed');
    await expect(page.locator('.result-note')).toContainText('only in the original');
    await expect(page.locator('.result-stats')).toContainText('−1 row');
    await page.getByLabel('Sheet', { exact: true }).selectOption('Added');
    await expect(page.locator('.result-note')).toContainText('only in the modified');
  });
}

test('CSV can be compared against any sheet of a workbook', async ({ page }) => {
  await openPair(page, upload('a.csv', 'a,b\n1,2'), { name: 'b.xlsx', mimeType: 'application/octet-stream', buffer: workbook({ One: [['a', 'b'], [1, 2]], Two: [['a', 'b'], [1, 3]] }) });
  await expect(page.locator('.result-stats')).toHaveText('Tables are identical');
  await page.getByLabel('Sheet', { exact: true }).selectOption('Two');
  await expect(page.locator('.result-stats')).toContainText('1 changed cell');
});

for (const [extension, make] of [['docx', word], ['pptx', slides], ['odt', odt], ['epub', epub]]) {
  test(`${extension} extracts text without rendering document markup`, async ({ page }) => {
    await openPair(page, { name: `old.${extension}`, mimeType: 'application/octet-stream', buffer: make('Before <script>bad</script>') }, { name: `new.${extension}`, mimeType: 'application/octet-stream', buffer: make('After <script>bad</script>') });
    await expect(page.locator('.result-stats')).toContainText('+1 addition');
    await expect(page.locator('.result-note')).toContainText('extracted text');
    await expect(page.locator('#original')).toHaveValue(/Before <script>bad<\/script>/);
    await expect(page.locator('.line-diff script')).toHaveCount(0);
  });
}

test('images support a keyboard accessible slider and side by side', async ({ page }) => {
  await openPair(page, svg('orange'), svg('teal', 600, 480));
  const slider = page.getByRole('slider');
  await expect(slider).toHaveValue('50');
  await slider.focus();
  await slider.press('ArrowRight');
  await expect(slider).toHaveValue('51');
  await expect(page.locator('.visual-stage')).toHaveCSS('--position', '51%');
  await page.screenshot({ path: 'test-results/images-slider.png', fullPage: true });
  await page.getByRole('button', { name: 'Side by side' }).click();
  await expect(page.locator('.visual-pair img')).toHaveCount(2);
  await expect(page.locator('.identity-status')).toHaveText('File contents differ.');
  await page.getByRole('button', { name: 'Remove original file' }).click();
  await expect(page.locator('#original')).toBeVisible();
  await expect(page.locator('.placeholder')).toBeVisible();
});

test('PDFs compare rendered pages and text, including an absent page', async ({ page, context }) => {
  const maker = await context.newPage();
  const requests = [];
  page.on('request', request => requests.push(request.url()));
  await maker.setContent('<style>@page{size:400px 500px;margin:30px}.next{break-before:page}</style><h1>Original page</h1><p>Shared text</p><h1 class="next">Second page</h1>');
  const before = await maker.pdf({ preferCSSPageSize: true });
  await maker.setContent('<style>@page{size:400px 500px;margin:30px}</style><h1>Modified page</h1><p>Shared text</p>');
  const after = await maker.pdf({ preferCSSPageSize: true });
  await maker.close();
  await openPair(page, { name: 'old.pdf', mimeType: 'application/pdf', buffer: before }, { name: 'new.pdf', mimeType: 'application/pdf', buffer: after });
  await expect(page.getByRole('slider')).toBeVisible();
  await expect(page.locator('.result-stats')).toContainText('Original: 2 pages');
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.locator('.missing-page')).toHaveText('No page on this side');
  await page.getByRole('button', { name: 'Side by side' }).click();
  await expect(page.locator('.visual-pair img')).toHaveCount(1);
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await expect(page.locator('.line-diff')).toContainText('Modified page');
  await expect(page.locator('.line-diff')).toContainText('Second page');
  await expect(page.locator('.result-stats')).toContainText('deletion');
  expect(requests.every(url => url.startsWith('http://127.0.0.1:4173/') || /^(blob|data):/.test(url))).toBeTruthy();
});

test('binary files report actual equality, including same size different bytes', async ({ page }) => {
  const binary = value => ({ name: 'file.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 255, value]) });
  await openPair(page, binary(1), binary(1));
  await expect(page.locator('.identity-status')).toHaveText('File contents are identical.');
  await page.locator('#modified-file').setInputFiles(binary(2));
  await expect(page.locator('.identity-status')).toHaveText('File contents differ.');
});

test('two files can be dropped together', async ({ page }) => {
  await page.locator('[data-side="original"]').evaluate(element => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(['before'], 'a.txt', { type: 'text/plain' }));
    dataTransfer.items.add(new File(['after'], 'b.txt', { type: 'text/plain' }));
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  });
  await expect(page.locator('.result-stats')).toContainText('+1 addition');
  await expect(page.locator('#original-meta')).toContainText('a.txt');
  await expect(page.locator('#modified-meta')).toContainText('b.txt');
});

test('malformed documents fail locally and leave the previous input usable', async ({ page }) => {
  await page.locator('#original').fill('keep me');
  await page.locator('#original-file').setInputFiles(upload('broken.docx', 'not a zip'));
  await expect(page.locator('#original-status')).toHaveClass(/error/);
  await expect(page.locator('#original')).toHaveValue('keep me');
  await expect(page.locator('#compare-btn')).toBeEnabled();
  await page.locator('#original-file').setInputFiles(upload('broken.pdf', 'not a pdf', 'application/pdf'));
  await expect(page.locator('#original-status')).toContainText('could not be opened');
  await page.locator('#original-file').setInputFiles(upload('broken.png', 'not an image', 'image/png'));
  await expect(page.locator('#original-status')).toContainText('could not be opened');
});

test('clearing while a file is opening prevents late results from restoring it', async ({ page }) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/vendor/xlsx.full.min.js', async route => { await gate; await route.continue(); });
  await page.locator('#original-file').setInputFiles({ name: 'a.xlsx', mimeType: 'application/octet-stream', buffer: workbook({ Main: [['a']] }) });
  await expect(page.locator('#original-status')).toHaveText('Opening file…');
  await page.locator('#clear-btn').click();
  release();
  await expect(page.locator('#original')).toBeEmpty();
  await expect(page.locator('#original-meta')).toBeHidden();
  await expect(page.locator('#compare-btn')).toBeEnabled();
});

test('audio has playable side by side controls', async ({ page }) => {
  const bytes = Buffer.alloc(844);
  bytes.write('RIFF'); bytes.writeUInt32LE(836, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(8000, 28); bytes.writeUInt16LE(1, 32);
  bytes.writeUInt16LE(8, 34); bytes.write('data', 36); bytes.writeUInt32LE(800, 40); bytes.fill(128, 44);
  await openPair(page, { name: 'a.wav', mimeType: 'audio/wav', buffer: bytes }, { name: 'b.wav', mimeType: 'audio/wav', buffer: bytes });
  await expect(page.locator('.media-pair audio')).toHaveCount(2);
  await expect(page.locator('.identity-status')).toHaveText('File contents are identical.');
});

test('mobile layout fits text, table, and image comparison without page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(await fits()).toBeTruthy();
  await page.screenshot({ path: 'test-results/mobile-empty.png', fullPage: true });
  await openPair(page, upload('a.csv', 'LongColumn,AnotherColumn\nhello,1'), upload('b.csv', 'LongColumn,AnotherColumn\nworld,2'));
  expect(await fits()).toBeTruthy();
  await page.screenshot({ path: 'test-results/mobile-table.png', fullPage: true });
  await openPair(page, svg('orange'), svg('teal'));
  expect(await fits()).toBeTruthy();
  await page.screenshot({ path: 'test-results/mobile-slider.png', fullPage: true });
});

test('PowerPoint uses presentation order after slides are rearranged', async ({ page }) => {
  const namespace = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const slideXML = text => `<a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:r><a:t>${text}</a:t></a:r></a:p>`;
  const make = order => zip({
    'ppt/presentation.xml': `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${namespace}"><p:sldIdLst>${order.map(id => `<p:sldId r:id="rId${id}"/>`).join('')}</p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>',
    'ppt/slides/slide1.xml': slideXML('First created'),
    'ppt/slides/slide2.xml': slideXML('Second created')
  });
  await openPair(page, { name: 'a.pptx', mimeType: 'application/octet-stream', buffer: make([1, 2]) }, { name: 'b.pptx', mimeType: 'application/octet-stream', buffer: make([2, 1]) });
  await expect(page.locator('#modified')).toHaveValue('Slide 1\nSecond created\n\nSlide 2\nFirst created');
  await expect(page.locator('.result-stats')).toContainText('addition');
});
