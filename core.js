// Bound the quadratic part of the diff. Common prefixes and suffixes are free,
// and very different large inputs fall back to a valid replace block.
export function computeDiff(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]) end++;

  const before = a.slice(start, a.length - end);
  const after = b.slice(start, b.length - end);
  const result = a.slice(0, start).map(value => ({ type: 'equal', value }));
  if (before.length * after.length > 4_000_000) {
    result.push(...before.map(value => ({ type: 'delete', value })),
      ...after.map(value => ({ type: 'insert', value })));
  } else {
    const width = after.length + 1;
    const dp = new Uint32Array((before.length + 1) * width);
    for (let i = 1; i <= before.length; i++) {
      for (let j = 1; j <= after.length; j++) {
        dp[i * width + j] = before[i - 1] === after[j - 1]
          ? dp[(i - 1) * width + j - 1] + 1
          : Math.max(dp[(i - 1) * width + j], dp[i * width + j - 1]);
      }
    }
    const middle = [];
    let i = before.length, j = after.length;
    while (i || j) {
      if (i && j && before[i - 1] === after[j - 1]) {
        middle.push({ type: 'equal', value: before[--i] });
        j--;
      } else if (j && (!i || dp[i * width + j - 1] >= dp[(i - 1) * width + j])) {
        middle.push({ type: 'insert', value: after[--j] });
      } else {
        middle.push({ type: 'delete', value: before[--i] });
      }
    }
    result.push(...middle.reverse());
  }
  result.push(...a.slice(a.length - end).map(value => ({ type: 'equal', value })));
  return result;
}

export function normalizeText(text) {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

export function textLines(text) {
  return text === '' ? [] : normalizeText(text).split('\n');
}

export function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// RFC 4180 quoting, embedded newlines, escaped quotes, and trailing empty cells.
export function parseDelimited(text, delimiter) {
  text = normalizeText(text);
  if (!text) return [];
  if (!delimiter) {
    const candidates = [',', ';', '\t', '|'];
    const sample = text.slice(0, 65536);
    delimiter = candidates.reduce((best, candidate) => {
      const count = value => {
        let quoted = false, total = 0;
        for (let i = 0; i < sample.length; i++) {
          if (sample[i] === '"') quoted = !quoted;
          else if (!quoted && sample[i] === '\n') break;
          else if (!quoted && sample[i] === value) total++;
        }
        return total;
      };
      return count(candidate) > count(best) ? candidate : best;
    });
  }
  const rows = [];
  let row = [], cell = '', quoted = false, endedRow = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    endedRow = false;
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else if (quoted || cell === '') quoted = !quoted;
      else cell += char;
    } else if (!quoted && (char === delimiter || char === '\n')) {
      row.push(cell);
      cell = '';
      if (char === '\n') { rows.push(row); row = []; endedRow = true; }
    } else cell += char;
  }
  if (quoted) throw new Error('A quoted cell is missing its closing quote.');
  if (!endedRow) { row.push(cell); rows.push(row); }
  return rows;
}

export function checkTableSize(rows) {
  let cells = 0;
  for (const row of rows) cells += row.length;
  if (rows.length > 20000 || cells > 200000 || rows.some(row => row.length > 500)) {
    throw new Error('This table is too large to display. Use a file with up to 20,000 rows, 500 columns, and 200,000 cells.');
  }
  return rows;
}

// Align unchanged rows first, then pair changed rows inside each replacement.
export function alignRows(before, after) {
  const hunks = computeDiff(before.map(row => JSON.stringify(row)), after.map(row => JSON.stringify(row)));
  const rows = [];
  let left = 0, right = 0, removed = [], added = [];
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) {
      rows.push({ before: removed[i], after: added[i] });
    }
    removed = []; added = [];
  };
  for (const hunk of hunks) {
    if (hunk.type === 'equal') {
      flush();
      rows.push({ before: { number: ++left, cells: before[left - 1] }, after: { number: ++right, cells: after[right - 1] } });
    } else if (hunk.type === 'delete') removed.push({ number: ++left, cells: before[left - 1] });
    else added.push({ number: ++right, cells: after[right - 1] });
  }
  flush();
  return rows;
}

export function decodeText(buffer) {
  const bytes = new Uint8Array(buffer);
  let encoding = 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  else if (bytes.slice(0, 8192).some(byte => byte === 0)) return null;
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    if (/[\u0000-\u0008\u000e-\u001a]/.test(text)) return null;
    return normalizeText(text);
  } catch { return null; }
}
