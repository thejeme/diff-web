import { alignRows, checkTableSize, computeDiff, escapeHTML as esc, formatSize, parseDelimited, textLines } from './core.js';
import { disposeSource, pdfPageImage, pdfText, readFile } from './file-readers.js';

const sideNames = ['original', 'modified'];
const label = index => index === 0 ? 'Original' : 'Modified';

class DiffOutput extends HTMLElement {
  #sources;
  #revision = 0;
  #mode;
  #page = 1;
  #sheet;
  #position = 50;
  #raw = '';

  connectedCallback() { this.clear(); }

  clear(message = 'Paste text or open two files, then compare.') {
    this.#revision++;
    this.#sources = undefined;
    this.#raw = '';
    this.innerHTML = `<div class="placeholder"><p>${esc(message)}</p></div>`;
  }

  async compare(sources) {
    this.#sources = sources;
    this.#page = 1;
    this.#sheet = undefined;
    this.#position = 50;
    const kinds = sources.map(source => source.kind);
    this.#mode = kinds.every(kind => kind === 'image' || kind === 'pdf') ? 'slider'
      : kinds.every(kind => kind === 'table') ? 'table'
        : kinds.every(kind => ['audio', 'video'].includes(kind)) ? 'media'
          : kinds.some(kind => ['image', 'pdf', 'audio', 'video', 'binary'].includes(kind)) ? 'details' : 'text';
    if (kinds.includes('pdf') && kinds.every(kind => ['pdf', 'text', 'document'].includes(kind)) && !kinds.every(kind => kind === 'pdf')) this.#mode = 'text';
    await this.#render();
  }

  #modes() {
    const kinds = this.#sources.map(source => source.kind);
    if (kinds.every(kind => ['image', 'pdf'].includes(kind))) {
      return [{ value: 'slider', name: 'Slider' }, { value: 'side', name: 'Side by side' },
        ...(kinds.every(kind => kind === 'pdf') ? [{ value: 'text', name: 'Text' }] : [])];
    }
    if (kinds.every(kind => kind === 'table')) return [{ value: 'table', name: 'Table' }, { value: 'text', name: 'Text' }];
    return [];
  }

  #shell(revision) {
    const modes = this.#modes();
    const pages = Math.max(...this.#sources.map(source => source.pdf?.numPages || 1));
    const multipleSheets = this.#sources.some(source => source.sheets?.length > 1);
    const sheets = multipleSheets
      ? [...new Set(this.#sources.flatMap(source => source.editable ? [] : (source.sheets || []).map(sheet => sheet.name)))]
      : [this.#sources[0].sheets?.[0]?.name].filter(Boolean);
    this.#sheet ??= sheets[0];
    this.innerHTML = `
      <div class="result-toolbar">
        <div class="result-stats" role="status">Comparing…</div>
        <div class="result-actions">
          ${this.#mode === 'table' && sheets.length > 1 ? `<label class="control-label">Sheet <select class="sheet-select" aria-label="Sheet">${sheets.map(name => `<option${name === this.#sheet ? ' selected' : ''}>${esc(name)}</option>`).join('')}</select></label>` : ''}
          ${pages > 1 && ['slider', 'side'].includes(this.#mode) ? `<div class="page-controls"><button type="button" class="small-btn previous-page" aria-label="Previous page"${this.#page === 1 ? ' disabled' : ''}>‹</button><span>Page ${this.#page} / ${pages}</span><button type="button" class="small-btn next-page" aria-label="Next page"${this.#page === pages ? ' disabled' : ''}>›</button></div>` : ''}
          ${modes.length ? `<div class="view-switch" role="group" aria-label="Comparison view">${modes.map(mode => `<button type="button" data-mode="${mode.value}" aria-pressed="${mode.value === this.#mode}">${mode.name}</button>`).join('')}</div>` : ''}
          ${this.#mode === 'text' || this.#mode === 'table' ? '<button type="button" class="small-btn copy-diff" disabled>Copy diff</button>' : ''}
        </div>
      </div>
      <div class="result-body" aria-busy="true"><div class="result-message" role="status">Loading comparison…</div></div>`;
    this.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
      this.#mode = button.dataset.mode;
      this.#render();
    }));
    this.querySelector('.sheet-select')?.addEventListener('change', event => {
      this.#sheet = event.target.value;
      this.#render();
    });
    for (const [selector, step] of [['.previous-page', -1], ['.next-page', 1]]) {
      this.querySelector(selector)?.addEventListener('click', () => { this.#page += step; this.#render(); });
    }
    this.querySelector('.copy-diff')?.addEventListener('click', async event => {
      const button = event.currentTarget;
      try { await navigator.clipboard.writeText(this.#raw); button.textContent = 'Copied'; }
      catch { button.textContent = 'Copy failed'; }
      setTimeout(() => { if (revision === this.#revision) button.textContent = 'Copy diff'; }, 1800);
    });
    return this.querySelector('.result-body');
  }

  #stats(html) { this.querySelector('.result-stats').innerHTML = html; }

  async #render() {
    const revision = ++this.#revision;
    const sources = this.#sources;
    const body = this.#shell(revision);
    try {
      if (this.#mode === 'text') {
        const texts = await Promise.all(sources.map(source => source.kind === 'pdf' ? pdfText(source) : source.text || ''));
        if (revision !== this.#revision) return;
        this.#text(body, texts, sources);
      } else if (this.#mode === 'table') this.#table(body, sources);
      else if (this.#mode === 'slider' || this.#mode === 'side') {
        const page = this.#page;
        const visuals = await Promise.all(sources.map(source => source.kind === 'pdf'
          ? (page <= source.pdf.numPages ? pdfPageImage(source.pdf, page) : null) : source));
        if (revision !== this.#revision) return;
        this.#visual(body, visuals, sources);
      } else if (this.#mode === 'media') this.#media(body, sources);
      else {
        body.innerHTML = `<p class="result-message">${sources.every(source => source.file) ? 'These files have different types or no preview. Their full contents are compared below.' : 'Open a file on each side to compare file contents, or use matching types for a preview.'}</p>`;
        this.#stats('File comparison');
      }
      if (revision !== this.#revision) return;
      body.setAttribute('aria-busy', 'false');
      if (sources.every(source => source.file)) this.#fileIdentity(body, sources, revision);
    } catch (error) {
      if (revision !== this.#revision) return;
      this.#stats('Could not compare');
      body.innerHTML = `<p class="result-message error" role="alert">${esc(error.message)}</p>`;
      body.setAttribute('aria-busy', 'false');
    }
  }

  #text(body, texts, sources) {
    const lines = texts.map(textLines);
    if (lines.some(side => side.length > 20000) || texts.some(text => text.length > 2_000_000)) {
      throw new Error('The text is too large to display. Use up to 20,000 lines and 2 million characters per side.');
    }
    const hunks = computeDiff(...lines);
    const adds = hunks.filter(hunk => hunk.type === 'insert').length;
    const dels = hunks.filter(hunk => hunk.type === 'delete').length;
    this.#stats(adds || dels ? `<span class="stat add">+${adds} addition${adds === 1 ? '' : 's'}</span><span class="stat del">−${dels} deletion${dels === 1 ? '' : 's'}</span>` : 'Text is identical');
    this.#raw = hunks.map(hunk => `${hunk.type === 'insert' ? '+' : hunk.type === 'delete' ? '-' : ' '} ${hunk.value}`).join('\n');
    let left = 0, right = 0;
    const rows = hunks.map(hunk => {
      const original = hunk.type !== 'insert' ? ++left : '';
      const modified = hunk.type !== 'delete' ? ++right : '';
      return `<tr class="${hunk.type}"><td class="ln">${original}</td><td class="ln">${modified}</td><td class="gutter">${hunk.type === 'insert' ? '+' : hunk.type === 'delete' ? '−' : ' '}</td><td class="code">${esc(hunk.value)}</td></tr>`;
    }).join('');
    const extracted = sources.some(source => ['document', 'pdf'].includes(source.kind));
    const scanned = sources.some(source => source.kind === 'pdf' && source.hasText === false);
    body.innerHTML = `${extracted ? `<p class="result-note">${scanned ? 'No selectable text was found in one or both PDFs. Use the page views to compare scanned pages.' : 'Comparing extracted text. Formatting and embedded images are not included.'}</p>` : ''}
      <div class="table-wrap"><table class="line-diff" aria-label="Text differences"><tbody>${rows || '<tr><td class="result-message">Both inputs are empty.</td></tr>'}</tbody></table></div>`;
    this.querySelector('.copy-diff').disabled = false;
  }

  #table(body, sources) {
    const multiple = sources.some(source => source.sheets.length > 1);
    const sheets = sources.map(source => source.sheets.find(sheet => sheet.name === this.#sheet) || ((!multiple || source.editable) && source.sheets.length === 1 ? source.sheets[0] : undefined));
    const rows = alignRows(...sheets.map(sheet => sheet?.rows || []));
    const columns = Math.max(1, ...sheets.flatMap(sheet => (sheet?.rows || []).map(row => row.length)));
    if (rows.length * columns > 200000) throw new Error('This comparison is too large to display. Try comparing smaller sheets.');
    let changed = 0, added = 0, removed = 0;
    const columnName = index => {
      let name = '';
      for (let n = index + 1; n; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name;
      return name;
    };
    const rendered = rows.map(row => {
      const type = !row.before ? 'insert' : !row.after ? 'delete' : '';
      if (type === 'insert') added++;
      if (type === 'delete') removed++;
      const cells = Array.from({ length: columns }, (_, index) => {
        const before = String(row.before?.cells[index] ?? '');
        const after = String(row.after?.cells[index] ?? '');
        if (row.before && row.after && before !== after) {
          changed++;
          return `<td class="changed-cell"><del aria-label="Original value">${before === '' ? '<span class="empty-cell">empty</span>' : esc(before)}</del><ins aria-label="Modified value">${after === '' ? '<span class="empty-cell">empty</span>' : esc(after)}</ins></td>`;
        }
        return `<td>${esc(row.after ? after : before)}</td>`;
      }).join('');
      return `<tr class="${type}"><th class="ln" scope="row">${row.before?.number ?? ''}</th><td class="ln">${row.after?.number ?? ''}</td><td class="gutter">${type === 'insert' ? '+' : type === 'delete' ? '−' : ''}</td>${cells}</tr>`;
    }).join('');
    const stats = [];
    if (changed) stats.push(`${changed} changed cell${changed === 1 ? '' : 's'}`);
    if (added) stats.push(`<span class="stat add">+${added} row${added === 1 ? '' : 's'}</span>`);
    if (removed) stats.push(`<span class="stat del">−${removed} row${removed === 1 ? '' : 's'}</span>`);
    this.#stats(stats.length ? stats.join(' ') : 'Tables are identical');
    body.innerHTML = `${sheets.some(sheet => !sheet) ? `<p class="result-note">This sheet exists only in the ${sheets[0] ? 'original' : 'modified'} file.</p>` : ''}<div class="table-wrap"><table class="data-diff" aria-label="Cell differences"><thead><tr><th class="ln" title="Original row">old</th><th class="ln" title="Modified row">new</th><th class="gutter"></th>${Array.from({ length: columns }, (_, i) => `<th scope="col">${columnName(i)}</th>`).join('')}</tr></thead><tbody>${rendered}</tbody></table>${rows.length ? '' : '<p class="result-message">This sheet is empty.</p>'}</div>`;
    this.#raw = rows.map(row => {
      if (!row.before) return `+ ${row.after.cells.join('\t')}`;
      if (!row.after) return `- ${row.before.cells.join('\t')}`;
      if (JSON.stringify(row.before.cells) === JSON.stringify(row.after.cells)) return `  ${row.before.cells.join('\t')}`;
      return `- ${row.before.cells.join('\t')}\n+ ${row.after.cells.join('\t')}`;
    }).join('\n');
    this.querySelector('.copy-diff').disabled = false;
  }

  #visual(body, visuals, sources) {
    const width = Math.max(...visuals.filter(Boolean).map(visual => visual.width));
    const height = Math.max(...visuals.filter(Boolean).map(visual => visual.height));
    this.#stats(sources.some(source => source.kind === 'pdf')
      ? sources.map((source, index) => `${label(index)}: ${source.pdf ? `${source.pdf.numPages} page${source.pdf.numPages === 1 ? '' : 's'}` : `${source.width} × ${source.height}`}`).join(' · ')
      : visuals.map((visual, index) => `${label(index)}: ${visual.width} × ${visual.height}`).join(' · '));
    const content = (visual, index) => visual
      ? `<img src="${esc(visual.url)}" style="width:${visual.width / width * 100}%;height:${visual.height / height * 100}%" alt="${label(index)}${sources[index].kind === 'pdf' ? ` page ${this.#page}` : ' image'}" draggable="false" />`
      : '<span class="missing-page">No page on this side</span>';
    if (this.#mode === 'side') {
      body.innerHTML = `<div class="visual-pair">${visuals.map((visual, index) => `<figure><figcaption>${label(index)}</figcaption><div class="visual-frame checker" style="aspect-ratio:${width}/${height}">${content(visual, index)}</div></figure>`).join('')}</div>`;
    } else {
      body.innerHTML = `<div class="visual-stage" style="aspect-ratio:${width}/${height};--position:${this.#position}%">
        <div class="visual-layer checker modified-layer">${content(visuals[1], 1)}</div>
        <div class="visual-layer checker original-layer">${content(visuals[0], 0)}</div>
        <span class="image-label original-label">Original</span><span class="image-label modified-label">Modified</span>
        <div class="slider-divider" aria-hidden="true"><span>‹ ›</span></div>
        <input class="image-slider" type="range" min="0" max="100" value="${this.#position}" aria-label="Reveal original image" aria-valuetext="${this.#position}% original" />
      </div><p class="slider-hint">Drag to compare</p>`;
      const slider = body.querySelector('.image-slider');
      slider.addEventListener('input', () => {
        this.#position = Number(slider.value);
        slider.parentElement.style.setProperty('--position', `${this.#position}%`);
        slider.setAttribute('aria-valuetext', `${this.#position}% original`);
      });
    }
  }

  #media(body, sources) {
    this.#stats('Playback comparison');
    body.innerHTML = `<div class="media-pair">${sources.map((source, index) => `<figure><figcaption>${label(index)}</figcaption><${source.kind} controls preload="metadata" src="${esc(source.url)}" aria-label="${label(index)} ${source.kind}"></${source.kind}><p class="media-error" hidden>Playback is unavailable for this file in your browser.</p></figure>`).join('')}</div><p class="result-note">Play each file to compare. Full file contents are checked below.</p>`;
    body.querySelectorAll('audio, video').forEach(media => media.addEventListener('error', () => { media.nextElementSibling.hidden = false; }));
  }

  async #fileIdentity(body, sources, revision) {
    const details = document.createElement('div');
    details.className = 'file-identity';
    details.innerHTML = `${this.#mode === 'details' ? `<div class="file-details">${sources.map((source, index) => `<div><span>${label(index)}</span><strong>${esc(source.file.name)}</strong><span>${formatSize(source.file.size)}</span></div>`).join('')}</div>` : ''}<p class="identity-status" role="status">Checking file contents…</p>`;
    body.append(details);
    try {
      let identical = sources[0].file.size === sources[1].file.size;
      if (identical) {
        for (let offset = 0; identical && offset < sources[0].file.size; offset += 1024 * 1024) {
          const bytes = await Promise.all(sources.map(source => source.file.slice(offset, offset + 1024 * 1024).arrayBuffer()));
          if (revision !== this.#revision) return;
          const left = new Uint8Array(bytes[0]), right = new Uint8Array(bytes[1]);
          identical = left.every((value, i) => value === right[i]);
        }
      }
      if (revision !== this.#revision) return;
      details.querySelector('.identity-status').textContent = `${identical ? 'File contents are identical.' : 'File contents differ.'}${sources.some(source => source.edited) ? ' This check uses the opened files; the diff above includes your edits.' : ''}`;
    } catch {
      if (revision === this.#revision) details.querySelector('.identity-status').textContent = 'File contents could not be checked. Reopen the files to try again.';
    }
  }
}

customElements.define('diff-output', DiffOutput);

const compareButton = document.getElementById('compare-btn');
const output = document.getElementById('diff-output');
const panels = sideNames.map(side => ({
  side, pane: document.querySelector(`[data-side="${side}"]`), text: document.getElementById(side),
  input: document.getElementById(`${side}-file`), meta: document.getElementById(`${side}-meta`),
  preview: document.getElementById(`${side}-preview`), status: document.getElementById(`${side}-status`),
  open: document.querySelector(`[data-open="${side}"]`), source: null, revision: 0, loading: false
}));

function status(panel, message = '', error = false) {
  panel.status.textContent = message;
  panel.status.hidden = !message;
  panel.status.classList.toggle('error', error);
}

function updateBusy() {
  compareButton.disabled = panels.some(panel => panel.loading);
  for (const panel of panels) {
    panel.pane.setAttribute('aria-busy', String(panel.loading));
    panel.open.textContent = panel.loading ? 'opening…' : 'open file';
  }
}

function resetPanel(panel) {
  panel.revision++;
  panel.loading = false;
  disposeSource(panel.source);
  panel.source = null;
  panel.input.value = '';
  panel.text.value = '';
  panel.text.readOnly = false;
  panel.text.hidden = false;
  panel.preview.replaceChildren();
  panel.preview.hidden = true;
  panel.meta.replaceChildren();
  panel.meta.hidden = true;
  status(panel);
  output.clear();
  updateBusy();
}

function renderPanel(panel) {
  const source = panel.source;
  panel.meta.hidden = false;
  panel.meta.innerHTML = `<span class="file-name" title="${esc(source.file.name)}">${esc(source.file.name)}</span><span class="file-size">${formatSize(source.file.size)}</span><button type="button" class="remove-file" aria-label="Remove ${panel.side} file">×</button>`;
  panel.meta.querySelector('button').addEventListener('click', () => { resetPanel(panel); panel.text.focus(); });
  const preview = ['image', 'pdf', 'audio', 'video', 'binary'].includes(source.kind);
  panel.text.hidden = preview;
  panel.text.readOnly = source.kind === 'table' && !source.editable;
  panel.text.value = source.text || '';
  panel.preview.hidden = !preview;
  panel.preview.replaceChildren();
  if (source.kind === 'image' || source.kind === 'pdf') {
    const img = new Image();
    img.alt = `${panel.side === 'original' ? 'Original' : 'Modified'} preview`;
    img.src = source.kind === 'pdf' ? source.preview.url : source.url;
    panel.preview.append(img);
    panel.preview.classList.add('checker');
  } else {
    panel.preview.classList.remove('checker');
    if (source.kind === 'audio' || source.kind === 'video') {
      const media = document.createElement(source.kind);
      media.controls = true;
      media.preload = 'metadata';
      media.src = source.url;
      media.setAttribute('aria-label', `${panel.side} ${source.kind}`);
      media.addEventListener('error', () => status(panel, 'Playback is unavailable for this file in your browser.', true));
      panel.preview.append(media);
    } else panel.preview.textContent = 'Ready to compare file contents';
  }
  status(panel, source.kind === 'document' ? 'Extracted text' : source.kind === 'pdf' ? `${source.pdf.numPages} page${source.pdf.numPages === 1 ? '' : 's'}` : source.kind === 'table' && !source.editable ? `${source.sheets.length} sheet${source.sheets.length === 1 ? '' : 's'}` : '');
}

async function openFile(panel, file) {
  const revision = ++panel.revision;
  panel.loading = true;
  status(panel, 'Opening file…');
  output.clear();
  updateBusy();
  try {
    const source = await readFile(file);
    if (revision !== panel.revision) { disposeSource(source); return; }
    disposeSource(panel.source);
    panel.source = source;
    renderPanel(panel);
  } catch (error) {
    if (revision === panel.revision) status(panel, error.message || 'This file could not be opened.', true);
  } finally {
    if (revision === panel.revision) {
      panel.loading = false;
      panel.input.value = '';
      updateBusy();
      if (panels.every(side => !side.loading && (side.source || side.text.value))) compare();
    }
  }
}

function currentSource(panel) {
  if (!panel.source) return { kind: 'text', text: panel.text.value };
  const source = { ...panel.source };
  if (['text', 'document'].includes(source.kind) || source.editable) {
    source.text = panel.text.value;
    source.edited = source.text !== panel.source.text;
    if (source.editable) source.sheets = [{ name: 'Table', rows: checkTableSize(parseDelimited(source.text, source.delimiter)) }];
  }
  return source;
}

function compare() {
  if (panels.some(panel => panel.loading)) return;
  try { output.compare(panels.map(currentSource)); }
  catch (error) { output.clear(error.message); }
}

for (const panel of panels) {
  panel.open.addEventListener('click', () => panel.input.click());
  panel.input.addEventListener('change', () => { if (panel.input.files[0]) openFile(panel, panel.input.files[0]); });
  panel.text.addEventListener('input', () => output.clear('Inputs changed. Click compare to update.'));
  let dragDepth = 0;
  panel.pane.addEventListener('dragenter', event => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    dragDepth++;
    panel.pane.classList.add('dragging');
  });
  panel.pane.addEventListener('dragover', event => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  panel.pane.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) { dragDepth = 0; panel.pane.classList.remove('dragging'); }
  });
  panel.pane.addEventListener('drop', event => {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    dragDepth = 0;
    panel.pane.classList.remove('dragging');
    const files = [...event.dataTransfer.files];
    if (files.length > 2) { status(panel, 'Drop one file on each side, or two files together.', true); return; }
    if (files.length === 2) files.forEach((file, index) => openFile(panels[index], file));
    else openFile(panel, files[0]);
  });
}
for (const type of ['dragover', 'drop']) document.addEventListener(type, event => {
  if (event.dataTransfer.types.includes('Files')) event.preventDefault();
});
compareButton.addEventListener('click', compare);
document.getElementById('clear-btn').addEventListener('click', () => {
  panels.forEach(resetPanel);
  panels[0].text.focus();
});
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    compare();
  }
});
window.addEventListener('pagehide', event => {
  if (!event.persisted) panels.forEach(panel => disposeSource(panel.source));
});
