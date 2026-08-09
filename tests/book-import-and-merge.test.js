const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const mainPy = fs.readFileSync(path.join(root, 'main.py'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'static', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'static', 'index.html'), 'utf8');

test('book parser supports TXT, EPUB and text PDFs', () => {
    assert.match(mainPy, /ALLOWED_BOOK_EXTENSIONS = \{"\.txt", "\.epub", "\.pdf"\}/);
    assert.match(mainPy, /def parse_epub_chapters\(/);
    assert.match(mainPy, /def parse_pdf_chapters\(/);
    assert.match(mainPy, /def parse_book_file\(/);
    assert.match(mainPy, /PDF has no extractable text/);
});

test('merge uses server preview and saves selected edited chapters together', () => {
    assert.match(mainPy, /@app\.post\("\/api\/parse-import"\)/);
    assert.match(mainPy, /@app\.post\("\/api\/append-chapters"\)/);
    assert.match(appJs, /let mergeSession = null/);
    assert.match(appJs, /\/api\/parse-import/);
    assert.match(appJs, /\/api\/append-chapters/);
    assert.match(appJs, /chapter\.included/);
    assert.match(html, /id="merge-prev-btn"/);
    assert.match(html, /id="merge-next-btn"/);
    assert.match(html, /id="merge-chapter-textarea"/);
});

test('network status and errors have shared UI plumbing', () => {
    assert.match(appJs, /const APP_STATUS/);
    assert.match(appJs, /window\.addEventListener\('offline', updateNetworkStatus\)/);
    assert.match(appJs, /window\.addEventListener\('online'/);
    assert.match(html, /id="network-status"/);
    assert.match(html, /id="app-toast-region"/);
});
