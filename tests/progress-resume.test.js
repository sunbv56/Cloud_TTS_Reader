const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const appJs = fs.readFileSync(
    path.join(__dirname, '..', 'static', 'app.js'),
    'utf8'
);

function functionBody(source, signature, nextSignature) {
    const start = source.indexOf(signature);
    assert.notEqual(start, -1, `${signature} must exist`);
    const end = nextSignature ? source.indexOf(nextSignature, start + signature.length) : source.length;
    return source.slice(start, end === -1 ? source.length : end);
}

test('progress read failures do not fall back to destructive chapter-zero saves', () => {
    const loadProgress = functionBody(appJs, 'async function loadProgress(bookId)', '\nfunction getTotalChunks');
    const loadBook = functionBody(appJs, 'async function loadBook(bookData, bookId, filename, fallbackProgress = null)', '\nasync function fetchSegment');

    assert.match(loadProgress, /throw err;/);
    assert.match(loadBook, /progress = await loadProgress\(STATE\.currentBookId\);/);
    assert.match(loadBook, /using library snapshot/);
    assert.match(loadBook, /!hasSavedProgressCursor\(progress\)\)+\s*&& hasSavedProgressCursor\(fallbackProgress\)/);
    assert.match(loadBook, /Point-read missing cursor; using library snapshot/);
    assert.match(loadBook, /if \(loadGeneration !== STATE\.loadGeneration\) return false;/);
    assert.doesNotMatch(loadBook, /loadProgress\(STATE\.currentBookId\)[\s\S]{0,300}catch[\s\S]{0,100}currentChapterIndex = 0/);
});

test('partial library documents and reset pauses cannot corrupt another book cursor', () => {
    const reset = functionBody(appJs, 'async function resetAudioEngine()', '\n// Keep only the content needed');
    const storageLoad = functionBody(appJs, 'async function loadBookFromStorage(bookId, bookData)', '\n// --- Auth state is now handled inside startFirebase');
    const refreshLibrary = functionBody(appJs, 'async function refreshLibrary()', '\n/** Download the canonical source TXT');

    assert.match(reset, /STATE\.isTransitioning = true;[\s\S]*audio\.pause\(\);/);
    assert.doesNotMatch(storageLoad, /STATE\.currentBookId = bookId;\s*updateLibraryHighlight\(\);/);
    assert.match(refreshLibrary, /hasBookProgressIdentity\(\{ \.\.\.data, filename \}\)/);
    assert.match(refreshLibrary, /Skipping incomplete library document/);
    assert.match(refreshLibrary, /getProgressPercent\(data\)\.toFixed\(1\)/);
    assert.match(appJs, /rawCursor !== undefined && rawCursor !== null && rawCursor !== ''/);
});

test('story and image metadata are shape-checked before use', () => {
    const storageLoad = functionBody(appJs, 'async function loadBookFromStorage(bookId, bookData)', '\n// --- Auth state is now handled inside startFirebase');
    const manifest = functionBody(appJs, 'async function loadImageManifest(bookId)', '\nasync function saveImageManifest');

    assert.match(storageLoad, /hasUsableSegmentedMetadata/);
    assert.match(storageLoad, /Ignoring incomplete segmented metadata/);
    assert.match(manifest, /Array\.isArray\(normalized\.images\)/);
});

test('progress saves are serialized and playback is tied to the active load', () => {
    const saveProgress = functionBody(appJs, 'async function saveProgress(force = false)', '\nasync function loadProgress');
    const progressWriter = functionBody(appJs, 'function enqueueProgressSnapshot(snapshot, version, retryAttempt = 0)', '\nfunction retryPendingProgressSaveNow');
    const playback = functionBody(appJs, 'async function playFromSentence(index', '\nfunction highlightSentence');

    assert.match(saveProgress, /bookId: STATE\.currentBookId,/);
    assert.match(saveProgress, /const version = \+\+STATE\.progressSaveVersion;/);
    assert.match(progressWriter, /STATE\.progressSaveChain\.then\(write, write\)/);
    assert.match(playback, /expectedLoadGeneration = STATE\.loadGeneration/);
    assert.match(playback, /expectedBookId === STATE\.currentBookId/);
    assert.match(playback, /if \(!isCurrentPlayback\(\)\) return;/);
    assert.match(playback, /await audio\.play\(\);/);
    assert.match(playback, /Auto-play blocked; waiting for user gesture/);
});

test('failed automatic progress saves retain the exact snapshot and retry', () => {
    const retry = functionBody(appJs, 'function scheduleProgressSaveRetry(snapshot, version, error, attempt = 0)', '\nfunction enqueueProgressSnapshot');
    const writer = functionBody(appJs, 'function enqueueProgressSnapshot(snapshot, version, retryAttempt = 0)', '\nfunction retryPendingProgressSaveNow');
    const pauseTimeout = functionBody(appJs, 'async function handlePauseTimeout()', '\nasync function handlePlaybackStall');

    assert.match(retry, /STATE\.pendingProgressRetry = \{ snapshot, version, attempt: retryAttempt \}/);
    assert.match(retry, /setTimeout\(retryPendingProgressSaveNow, delayMs\)/);
    assert.match(writer, /code: err\?\.code \|\| 'unknown'/);
    assert.match(writer, /scheduleProgressSaveRetry\(snapshot, version, err, retryAttempt\)/);
    assert.match(pauseTimeout, /progressSaved = await saveProgress\(true\);/);
    assert.match(pauseTimeout, /Chưa lưu tiến độ — đang tự thử lại/);
});

test('out-of-range saved positions resume at the last sentence', () => {
    const indices = functionBody(appJs, 'function getLocalIndices(globalIdx)', '\nasync function refreshLibrary');

    assert.match(indices, /const lastNonEmptyChapter = -1|let lastNonEmptyChapter = -1/);
    assert.match(indices, /if \(lastNonEmptyChapter >= 0\)/);
    assert.match(indices, /lastNonEmptyLength - 1/);
});

test('book settings are force-saved instead of being skipped by progress batching', () => {
    const settings = functionBody(appJs, '// --- Settings ---', '\nfunction applyTypographySettings');

    assert.match(settings, /const scheduleBookSettingsSave = debounce/);
    assert.match(settings, /saveProgress\(true\)/);
    assert.match(settings, /STATE\.settings\.voice = e\.target\.value;[\s\S]*scheduleBookSettingsSave\(\)/);
    assert.match(settings, /STATE\.settings\.speed = parseFloat\(e\.target\.value\);[\s\S]*scheduleBookSettingsSave\(\)/);
    assert.doesNotMatch(settings, /saveProgress\(false\)/);
});

test('story metadata is authoritative for the B2 master-file key', () => {
    const storageLoad = functionBody(appJs, 'async function loadBookFromStorage(bookId, bookData)', '\n// --- Auth state is now handled inside startFirebase');

    assert.match(storageLoad, /const progressFilename = bookData\.filename;/);
    assert.match(storageLoad, /const filename = bookInfo\?\.filename \|\| progressFilename/);
    assert.match(storageLoad, /\[Storage identity\] Loading master file/);
});

test('renaming a book verifies the persisted title before refreshing the library', () => {
    const titleEditor = functionBody(appJs, 'async function editTitle()', '\naudio.onended');

    assert.match(titleEditor, /const saved = await saveProgress\(true\);/);
    assert.match(titleEditor, /const storedProgress = await loadProgress\(STATE\.currentBookId\);/);
    assert.match(titleEditor, /storedProgress\?\.title !== newTitle/);
});

test('manual save does not show success when the progress write returns false', () => {
    const manualSave = functionBody(appJs, 'async function triggerManualSave()', '\n// --- Stall Detection Logic');

    assert.match(manualSave, /const \[progressSaved, statsSaved\] = await Promise\.all/);
    assert.match(manualSave, /if \(progressSaved !== true\)/);
    assert.match(manualSave, /const persistedProgress = await loadProgress\(expectedBookId\);/);
    assert.match(manualSave, /Firestore read-back mismatch/);
    assert.match(manualSave, /APP_STATUS\.error\(e, 'Không thể lưu tiến độ lên Firestore\.'\)/);
});

test('Firestore rules cover stats reads and story metadata reads without client story writes', () => {
    const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'firestore.rules'), 'utf8');

    assert.match(rules, /match \/users\/\{userId\}\/stats\/\{document=\*\*\}/);
    assert.match(rules, /match \/users\/\{userId\}\/stories\/\{storyId\}/);
    assert.match(rules, /allow read: if request\.auth != null && request\.auth\.uid == userId;/);
    assert.match(rules, /allow write: if false;/);
});
