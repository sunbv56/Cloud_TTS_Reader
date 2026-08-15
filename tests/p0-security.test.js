const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const mainPy = fs.readFileSync(path.join(root, 'main.py'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'static', 'app.js'), 'utf8');

test('protected backend routes verify Firebase ownership', () => {
    assert.match(mainPy, /def _authorization_error\(request: Request, user_id: str\)/);
    assert.match(mainPy, /auth\.verify_id_token\(token\)/);

    const protectedRoutes = [
        'upload_story', 'get_story_metadata', 'migrate_legacy_story', 'get_segment_data',
        'get_image_manifest', 'put_image_manifest', 'upload_story_image',
        'replace_story_image', 'get_story_image', 'delete_story_image',
        'delete_story_images', 'get_story_file', 'delete_story_storage',
        'get_chapter_sentences', 'append_chapter', 'delete_chapters',
        'get_chapter_content', 'update_chapter', 'parse_import', 'append_chapters'
    ];
    for (const route of protectedRoutes) {
        const start = mainPy.indexOf(`async def ${route}`);
        assert.notEqual(start, -1, `${route} must exist`);
        const body = mainPy.slice(start, mainPy.indexOf('\n@app.', start + 1));
        if (route === 'upload_story_image' || route === 'replace_story_image') {
            assert.match(body, /_save_image_object\(request, userId, storyId, imageId, file\)/, `${route} must use the protected image helper`);
        } else {
            assert.match(body, /_authorization_error(?:_async)?\(request, userId\)/, `${route} must verify owner`);
        }
    }
});

test('frontend sends ID tokens to protected backend routes', () => {
    assert.match(appJs, /async function authFetch\(url, options = \{\}\)/);
    assert.match(appJs, /headers\.set\('Authorization', `Bearer \$\{token\}`\)/);
    for (const route of [
        '/api/upload-story', '/api/append-chapters', '/api/delete-chapters',
        '/api/get-chapter-sentences', '/api/get-chapter-content', '/api/update-chapter'
    ]) {
        const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        assert.match(appJs, new RegExp(`authFetch\\(['"]${escaped}`), `${route} must use authFetch`);
    }
    assert.match(appJs, /socket\.send\(JSON\.stringify\(\{ type: "AUTH", token \}\)\)/);
});

test('P0 resource limits are present and bounded', () => {
    assert.match(mainPy, /MAX_UPLOAD_BYTES = int\(os\.getenv/);
    assert.match(mainPy, /MAX_TTS_TEXT_CHARS = int\(os\.getenv/);
    assert.match(mainPy, /asyncio\.Queue\(maxsize=MAX_WS_QUEUE\)/);
    assert.match(mainPy, /min\(requested_workers, MAX_WS_WORKERS\)/);
    assert.match(mainPy, /min\(3, int\(os\.getenv\("MAX_WS_WORKERS", "3"\)\)\)/);
    assert.match(mainPy, /min\(24, int\(os\.getenv\("MAX_WS_QUEUE", "24"\)\)\)/);
    assert.match(mainPy, /File exceeds the \{max_bytes\} byte limit/);
});

test('backend validates text uploads and bounds TTS reads', () => {
    assert.match(mainPy, /def _validate_text_upload\(upload: UploadFile\)/);
    assert.match(mainPy, /Only \.txt, \.epub and \.pdf files are supported/);
    assert.match(mainPy, /def _detect_text_encoding\(file_path: str\)/);
    assert.match(mainPy, /TTS_CHUNK_TIMEOUT_SECONDS = float\(os\.getenv/);
    assert.match(mainPy, /async def _iter_tts_chunks\(communicate\)/);
    assert.match(mainPy, /asyncio\.wait_for\(/);
    assert.match(mainPy, /def _validate_supported_text_encoding\(file_path: str\)/);
    assert.match(mainPy, /Unsupported text encoding/);
    assert.doesNotMatch(mainPy, /sample\.decode\("cp1258"\)/);
});

test('websocket connections are bounded per authenticated user', () => {
    assert.match(mainPy, /MAX_WS_PER_USER = 1/);
    assert.match(mainPy, /_active_ws_by_uid/);
    assert.match(mainPy, /Too many active connections/);
});

test('book loading has bounded network waits and aborts stale selections', () => {
    assert.match(appJs, /class NetworkTimeoutError extends Error/);
    assert.match(appJs, /async function fetchWithTimeout\(/);
    assert.match(appJs, /new AbortController\(\)/);
    assert.match(appJs, /promiseWithTimeout\(getDoc\(storyRef\), 15_000/);
    assert.match(appJs, /STATE\.loadController\?\.abort\(\)/);
    assert.match(appJs, /waitForSourceBufferIdle\(2_000\)/);
    assert.match(appJs, /FOREGROUND_PREFETCH_CHUNKS = 12/);
    assert.match(appJs, /BACKGROUND_PREFETCH_CHUNKS = 16/);
    assert.match(appJs, /numWorkers: 2/);
    assert.match(appJs, /WORKER_STEPS = \[1, 2, 3\]/);
    assert.match(appJs, /function trimReaderContentCache\(activeChapterIndex\)/);
    assert.match(appJs, /closeWebSocketIntentionally\(\);/);
    assert.doesNotMatch(appJs, /\/migrate\?filename=/);
});

test('storage reads leave the event loop and avoid existence round trips', () => {
    assert.match(mainPy, /async def _run_storage\(/);
    assert.match(mainPy, /async def _run_firestore\(/);
    const segmentStart = mainPy.indexOf('async def get_segment_data');
    const segmentBody = mainPy.slice(segmentStart, mainPy.indexOf('\n@app.', segmentStart + 1));
    assert.match(segmentBody, /_run_storage\(/);
    assert.doesNotMatch(segmentBody, /blob\.exists\(\)/);
    assert.match(mainPy, /def parse_chapter_at_index\(/);
    assert.match(mainPy, /_get_or_download_legacy_source/);
    assert.match(mainPy, /_should_segment_book\(total_chapters\)/);
    assert.match(mainPy, /async def _migrate_legacy_story\(/);
    assert.match(mainPy, /segmentationState.*ready/);
    assert.match(mainPy, /segments\/v1/);
});
