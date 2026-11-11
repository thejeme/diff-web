// Expensive spreadsheet parsing and archive inflation stay off the UI thread.
self.onmessage = ({ data: { kind, buffer } }) => {
  try {
    if (kind === 'workbook') {
      importScripts('./vendor/xlsx.full.min.js');
      const book = XLSX.read(buffer, { type: 'array', cellHTML: false, cellFormula: false });
      let total = 0;
      const sheets = book.SheetNames.map(name => {
        const sheet = book.Sheets[name];
        if (sheet['!ref']) {
          const range = XLSX.utils.decode_range(sheet['!ref']);
          const rows = range.e.r + 1, columns = range.e.c + 1;
          total += rows * columns;
          if (rows > 20000 || columns > 500 || total > 200000) {
            throw new Error('This workbook is too large to display. Use up to 20,000 rows, 500 columns, and 200,000 cells in total.');
          }
        }
        return { name, rows: XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', blankrows: true, range: 0 }) };
      });
      self.postMessage({ result: sheets });
    } else {
      importScripts('./vendor/fflate/umd/index.js');
      let total = 0;
      const files = fflate.unzipSync(new Uint8Array(buffer), {
        filter: entry => {
          const wanted = /^(word\/document\.xml|ppt\/slides\/slide\d+\.xml|ppt\/presentation\.xml|ppt\/_rels\/presentation\.xml\.rels|content\.xml|META-INF\/container\.xml)$/.test(entry.name) ||
            /\.(opf|xhtml|html|htm)$/i.test(entry.name);
          if (wanted) {
            total += entry.originalSize;
            if (total > 32 * 1024 * 1024 || entry.originalSize > 8 * 1024 * 1024) {
              throw new Error('The document expands to too much text. Try a smaller file.');
            }
          }
          return wanted;
        }
      });
      const result = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, fflate.strFromU8(bytes)]));
      self.postMessage({ result });
    }
  } catch (error) {
    self.postMessage({ error: error.message || 'This file could not be read.' });
  }
};
