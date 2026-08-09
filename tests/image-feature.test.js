import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../static/app.js', import.meta.url), 'utf8');
const manager = fs.readFileSync(new URL('../static/js/image-manager.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../static/index.html', import.meta.url), 'utf8');
const rules = fs.readFileSync(new URL('../../storage.rules', import.meta.url), 'utf8');

test('illustrations are normalised to bounded WebP files', () => {
    assert.match(manager, /IMAGE_MAX_BYTES = 150 \* 1024/);
    assert.match(manager, /image\/webp/);
    assert.match(manager, /toBlob/);
    assert.match(manager, /width \* 0\.85/);
    assert.match(manager, /\.image/);
});

test('image upload uses per-book Storage paths and no new database collection', () => {
    assert.match(app, /users\/\$\{STATE\.user\.uid\}\/images/);
    assert.match(app, /uploadBookImages/);
    assert.match(app, /loadImageManifest/);
    assert.match(app, /imageManifestCache/);
    assert.match(app, /getDownloadURL\(imageManifestRef\(bookId\)\)/);
    assert.match(app, /has_images: false/);
    assert.match(app, /start empty instead of making an expected 404 request/);
    assert.match(app, /deleteBookImages/);
    assert.match(app, /replaceBookImage/);
    assert.match(app, /removeBookImage/);
    assert.match(app, /clipboardData/);
    assert.match(app, /dataTransfer/);
    assert.match(app, /uploadInputTarget = 'discovery'/);
    assert.match(app, /Drag-and-drop is intentionally TXT-only/);
    assert.match(app, /input\.accept = '\.txt'/);
    assert.match(app, /book-text-input/);
    assert.match(app, /book-image-input/);
    assert.match(app, /confirm-upload-files-btn/);
    assert.match(html, /id="image-input"/);
    assert.match(html, /id="image-manager-modal"/);
    assert.match(html, /id="upload-files-modal"/);
    assert.match(html, /id="discovery-drop-zone"/);
    assert.match(html, /Định dạng: <b>\.txt, \.epub, \.pdf<\/b>/);
});

test('Storage rules enforce WebP and 150 KB asset limits', () => {
    assert.match(rules, /images\/\{bookId\}\/assets/);
    assert.match(rules, /contentType == 'image\/webp'/);
    assert.match(rules, /size <= 150 \* 1024/);
});
