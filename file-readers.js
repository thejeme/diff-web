import { checkTableSize, decodeText, normalizeText, parseDelimited } from './core.js';

const images = new Set('png jpg jpeg jpe jfif gif webp avif bmp ico svg apng'.split(' '));
const workbooks = new Set('xlsx xls xlsm xlsb xlt xltx xltm ods ots fods numbers dbf dif slk sylk wks wk1 wk3'.split(' '));
const documents = new Set('docx docm dotx dotm pptx pptm potx potm odt ott odp otp epub'.split(' '));
const audio = new Set('mp3 wav ogg oga flac m4a aac opus aiff'.split(' '));
const video = new Set('mp4 webm mov m4v ogv'.split(' '));
const textExtensions = new Set('txt md markdown csv tsv json jsonl ndjson xml html htm css scss sass less js mjs cjs jsx ts tsx vue svelte yaml yml toml ini cfg conf env log sql sh bash zsh fish py rb php java c h cc cpp hpp cs go rs swift kt kts r lua pl tex bib rst adoc srt vtt ics vcf properties gitignore dockerfile makefile'.split(' '));

function runWorker(kind, buffer) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./reader-worker.js', import.meta.url));
    const finish = (error, result) => {
      clearTimeout(timer);
      worker.terminate();
      if (error) reject(new Error(error));
      else resolve(result);
    };
    const timer = setTimeout(() => finish('This file took too long to read. Try a smaller file.'), 30000);
    worker.onmessage = ({ data }) => finish(data.error, data.result);
    worker.onerror = () => finish('The file reader could not start. Reload the page and try again.');
    worker.postMessage({ kind, buffer }, [buffer]);
  });
}

function parseXML(text) {
  const xml = new DOMParser().parseFromString(text || '', 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('The document contains invalid XML.');
  return xml;
}

function contentText(node) {
  if (node.nodeType === 3) return node.textContent;
  if (node.nodeType !== 1 && node.nodeType !== 9) return '';
  const name = node.localName;
  if (['script', 'style', 'head'].includes(name)) return '';
  if (name === 'tab') return '\t';
  if (['br', 'line-break', 'cr'].includes(name)) return '\n';
  if (name === 's' && node.prefix === 'text') {
    return ' '.repeat(Math.min(1000, Number(node.getAttribute('text:c')) || 1));
  }
  const text = Array.from(node.childNodes, contentText).join('');
  return text + (['p', 'h', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(name) ? '\n' : '');
}

function documentText(files, extension) {
  let parts;
  if (/^(doc|dot)/.test(extension)) {
    if (!files['word/document.xml']) throw new Error('This is not a readable Word document.');
    parts = [contentText(parseXML(files['word/document.xml']))];
  } else if (/^(ppt|pot)/.test(extension)) {
    let names = Object.keys(files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]));
    if (files['ppt/presentation.xml'] && files['ppt/_rels/presentation.xml.rels']) {
      const relationships = new Map(Array.from(parseXML(files['ppt/_rels/presentation.xml.rels']).getElementsByTagNameNS('*', 'Relationship'), item => [item.getAttribute('Id'), item.getAttribute('Target')]));
      names = Array.from(parseXML(files['ppt/presentation.xml']).getElementsByTagNameNS('*', 'sldId'), item => {
        const id = item.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
        const target = relationships.get(id);
        if (!target) throw new Error('This presentation has a missing slide.');
        return decodeURIComponent(new URL(target, 'https://document.local/ppt/presentation.xml').pathname.slice(1));
      });
    }
    if (!names.length) throw new Error('This presentation has no readable slides.');
    parts = names.map((name, index) => {
      if (!files[name]) throw new Error('This presentation has a missing slide.');
      return `Slide ${index + 1}\n${contentText(parseXML(files[name])).trim()}`;
    });
  } else if (extension === 'epub') {
    const container = parseXML(files['META-INF/container.xml']);
    const path = container.getElementsByTagNameNS('*', 'rootfile')[0]?.getAttribute('full-path');
    if (!path || !files[path]) throw new Error('This EPUB is missing its reading order.');
    const book = parseXML(files[path]);
    const manifest = new Map(Array.from(book.getElementsByTagNameNS('*', 'item'), item => [item.getAttribute('id'), item.getAttribute('href')]));
    parts = Array.from(book.getElementsByTagNameNS('*', 'itemref'), item => {
      const href = manifest.get(item.getAttribute('idref'));
      if (!href) throw new Error('This EPUB has a missing chapter.');
      const resolved = new URL(href, `https://document.local/${path}`).pathname.slice(1);
      const source = files[decodeURIComponent(resolved)] ?? files[resolved];
      if (source === undefined) throw new Error('This EPUB has a missing chapter.');
      return contentText(new DOMParser().parseFromString(source, 'text/html')).trim();
    });
  } else {
    if (!files['content.xml']) throw new Error('This is not a readable OpenDocument file.');
    parts = [contentText(parseXML(files['content.xml']))];
  }
  return normalizeText(parts.map(part => part.trim()).join('\n\n'));
}

export async function pdfPageImage(pdf, number, maxWidth = 1400) {
  const page = await pdf.getPage(number);
  const initial = page.getViewport({ scale: 1 });
  const scale = Math.min(2, maxWidth / initial.width, 2000 / initial.height);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport, background: '#ffffff' }).promise;
  const url = canvas.toDataURL('image/png');
  canvas.width = canvas.height = 0;
  return { url, width: viewport.width, height: viewport.height };
}

export async function pdfText(source) {
  if (source.text !== undefined) return source.text;
  const pages = [];
  let total = 0;
  for (let i = 1; i <= source.pdf.numPages; i++) {
    const page = await source.pdf.getPage(i);
    const content = await page.getTextContent();
    let text = '', previous;
    for (const item of content.items) {
      if (!('str' in item)) continue;
      const y = item.transform?.[5];
      if (previous && !text.endsWith('\n')) {
        if (y !== undefined && Math.abs(y - previous.transform[5]) > 3) text += '\n';
        else {
          const gap = item.transform[4] - (previous.transform[4] + previous.width);
          if (gap > Math.max(1, Math.abs(item.transform[0]) * 0.18) && !/\s$/.test(text) && !/^\s/.test(item.str)) text += ' ';
        }
      }
      // Font runs (including ligatures) may split a word into several items.
      text += item.str + (item.hasEOL ? '\n' : '');
      previous = item;
    }
    pages.push(text.trimEnd());
    total += text.length;
    if (total > 2_000_000) throw new Error('This PDF contains too much text to compare. Use the page view.');
  }
  source.text = pages.join('\n\n');
  source.hasText = pages.some(page => page.trim());
  return source.text;
}

export async function readFile(file) {
  if (file.size > 50 * 1024 * 1024) throw new Error('This file is too large. Choose a file under 50 MB.');
  const extension = file.name.toLowerCase().split('.').pop();
  const source = { file, extension, kind: 'text' };
  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const isPDF = new TextDecoder().decode(header).startsWith('%PDF-');
  if (images.has(extension) || file.type.startsWith('image/')) {
    const mime = extension === 'svg' ? 'image/svg+xml' : (file.type || `image/${extension === 'jpg' ? 'jpeg' : extension}`);
    source.url = URL.createObjectURL(new Blob([file], { type: mime }));
    try {
      const image = new Image();
      image.src = source.url;
      await image.decode();
      return { ...source, kind: 'image', width: image.naturalWidth, height: image.naturalHeight };
    } catch {
      URL.revokeObjectURL(source.url);
      throw new Error('This image could not be opened. It may be damaged or unsupported by your browser.');
    }
  }
  if (isPDF || extension === 'pdf' || file.type === 'application/pdf') {
    const pdfjs = await import('./vendor/pdfjs/build/pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/build/pdf.worker.mjs', import.meta.url).href;
    const base = new URL('./vendor/pdfjs/', import.meta.url).href;
    const loading = pdfjs.getDocument({
      data: new Uint8Array(await file.arrayBuffer()), cMapUrl: `${base}cmaps/`, cMapPacked: true,
      standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/`, iccUrl: `${base}iccs/`, isEvalSupported: false
    });
    try {
      source.pdf = await loading.promise;
      source.preview = await pdfPageImage(source.pdf, 1, 600);
      return { ...source, kind: 'pdf' };
    } catch (error) {
      await loading.destroy();
      throw new Error(error.name === 'PasswordException' ? 'This PDF is password protected. Open an unlocked copy.' : 'This PDF could not be opened. It may be damaged.');
    }
  }
  if (audio.has(extension) || video.has(extension) || /^(audio|video)\//.test(file.type)) {
    return { ...source, kind: video.has(extension) || file.type.startsWith('video/') ? 'video' : 'audio', url: URL.createObjectURL(file) };
  }
  if (workbooks.has(extension)) {
    source.sheets = await runWorker('workbook', await file.arrayBuffer());
    if (!source.sheets.length) throw new Error('This workbook has no readable sheets.');
    return { ...source, kind: 'table', text: sheetsText(source.sheets) };
  }
  if (documents.has(extension)) {
    const files = await runWorker('document', await file.arrayBuffer());
    const text = documentText(files, extension);
    if (text.length > 2_000_000) throw new Error('This document contains too much text. Choose a document under 2 million characters.');
    return { ...source, kind: 'document', text };
  }
  const buffer = await file.arrayBuffer();
  let text = decodeText(buffer);
  // Legacy text files often use Windows-1252 rather than UTF-8.
  if (text === null && textExtensions.has(extension) && !header.includes(0)) {
    text = normalizeText(new TextDecoder('windows-1252').decode(buffer));
  }
  if (text === null) return { ...source, kind: 'binary' };
  if (text.length > 2_000_000) throw new Error('This file contains too much text. Choose a file under 2 million characters.');
  if (extension === 'csv' || extension === 'tsv' || file.type === 'text/csv' || file.type === 'text/tab-separated-values') {
    const delimiter = extension === 'tsv' || file.type === 'text/tab-separated-values' ? '\t' : undefined;
    return { ...source, kind: 'table', delimiter, editable: true, text,
      sheets: [{ name: 'Table', rows: checkTableSize(parseDelimited(text, delimiter)) }] };
  }
  return { ...source, text };
}

export function sheetsText(sheets) {
  return sheets.map(sheet => `${sheets.length > 1 ? `${sheet.name}\n` : ''}${sheet.rows.map(row => row.join('\t')).join('\n')}`).join('\n\n');
}

export function disposeSource(source) {
  if (source?.url) URL.revokeObjectURL(source.url);
  if (source?.pdf) source.pdf.destroy();
}
