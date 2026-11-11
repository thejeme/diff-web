import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alignRows, checkTableSize, computeDiff, decodeText, escapeHTML, normalizeText, parseDelimited, textLines } from '../core.js';

function reconstruct(hunks, side) {
  return hunks.filter(hunk => hunk.type !== (side === 'original' ? 'insert' : 'delete')).map(hunk => hunk.value);
}

test('diff reconstructs both inputs, including repeated and empty lines', () => {
  const cases = [[[], []], [[], ['a']], [['a'], []], [['a', 'b', 'a'], ['b', 'a', 'c']], [['', 'x', ''], ['', 'y', '']]];
  let seed = 813;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed; };
  for (let i = 0; i < 100; i++) {
    cases.push([Array.from({ length: random() % 25 }, () => String(random() % 5)), Array.from({ length: random() % 25 }, () => String(random() % 5))]);
  }
  for (const [before, after] of cases) {
    const hunks = computeDiff(before, after);
    assert.deepEqual(reconstruct(hunks, 'original'), before);
    assert.deepEqual(reconstruct(hunks, 'modified'), after);
  }
});

test('large unrelated files use bounded memory and preserve all content', () => {
  const before = Array.from({ length: 6000 }, (_, i) => `before ${i}`);
  const after = Array.from({ length: 6000 }, (_, i) => `after ${i}`);
  const hunks = computeDiff(before, after);
  assert.equal(hunks.length, 12000);
  assert.deepEqual(reconstruct(hunks, 'original'), before);
  assert.deepEqual(reconstruct(hunks, 'modified'), after);
});

test('CSV handles quotes, BOM, delimiters, multiline cells, empty rows and trailing fields', () => {
  assert.deepEqual(parseDelimited('\uFEFFname,note,\r\nAlice,"one, two",\r\nBob,"a ""quote""\nand a line",\r\n'), [
    ['name', 'note', ''], ['Alice', 'one, two', ''], ['Bob', 'a "quote"\nand a line', '']
  ]);
  assert.deepEqual(parseDelimited('a;b\n1;2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseDelimited('a\tb\n1\t2', '\t'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseDelimited(''), []);
  assert.deepEqual(parseDelimited('a,\n\n'), [['a', ''], ['']]);
  assert.throws(() => parseDelimited('a,"unclosed'), /closing quote/);
});

test('inserted table rows align without marking the rest of the sheet changed', () => {
  const before = [['Name', 'Value'], ['Alice', '1'], ['Bob', '2']];
  const after = [['Name', 'Value'], ['New', '0'], ['Alice', '1'], ['Bob', '3']];
  const rows = alignRows(before, after);
  assert.equal(rows.length, 4);
  assert.equal(rows[1].before, undefined);
  assert.deepEqual(rows[2].before.cells, rows[2].after.cells);
  assert.equal(rows[3].before.cells[1], '2');
  assert.equal(rows[3].after.cells[1], '3');
  assert.equal(rows[3].after.number, 4);
});

test('text decoding preserves Unicode and rejects binary content', () => {
  assert.equal(decodeText(new TextEncoder().encode('héllo\r\nworld')), 'héllo\nworld');
  assert.equal(decodeText(Uint8Array.from([255, 254, 65, 0, 10, 0, 66, 0])), 'A\nB');
  assert.equal(decodeText(Uint8Array.from([254, 255, 0, 65, 0, 66])), 'AB');
  assert.equal(decodeText(Uint8Array.from([0, 1, 2])), null);
  assert.equal(decodeText(Uint8Array.from([255, 255, 255])), null);
  assert.equal(normalizeText('a\rb\r\nc'), 'a\nb\nc');
  assert.deepEqual(textLines(''), []);
});

test('user content is escaped and oversized tables are rejected', () => {
  assert.equal(escapeHTML('<img src="x" onerror=\'bad\'>&'), '&lt;img src=&quot;x&quot; onerror=&#39;bad&#39;&gt;&amp;');
  assert.throws(() => checkTableSize([Array(501).fill('')]), /too large/);
});
