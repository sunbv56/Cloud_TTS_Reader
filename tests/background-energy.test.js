const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const appJs = read('static', 'app.js');
const miniPlayerJs = read('static', 'js', 'mini-player-widget.js');
const miniPlayerCss = read('static', 'css', 'mini-player.css');
const serviceWorker = read('static', 'sw.js');

test('background prefetch has a bounded energy budget', () => {
    const match = appJs.match(/BACKGROUND_PREFETCH_CHUNKS\s*=\s*(\d+)/);
    assert.ok(match, 'a named background prefetch budget is required');
    assert.ok(Number(match[1]) <= 100);
    assert.doesNotMatch(appJs, /prefetchNext\(lastChap,\s*lastIdx,\s*500/);
});

test('silent oscillator keepalive is not used', () => {
    assert.doesNotMatch(appJs, /createOscillator|enableNoSleepAudio/);
});

test('intentional websocket close does not reconnect', () => {
    const closeHandler = appJs.slice(
        appJs.indexOf('STATE.ws.onclose'),
        appJs.indexOf('async function waitForWebSocket')
    );
    assert.match(appJs, /socket\._intentionalClose/);
    assert.match(closeHandler, /STATE\.isPlaying \|\| STATE\.isDownloading/);
    assert.doesNotMatch(closeHandler, /STATE\.isPlaying \|\| STATE\.chunkTimings\.length > 0/);
});

test('websocket wait reports both success and timeout', () => {
    assert.match(appJs, /readyState === WebSocket\.OPEN\) return true/);
    assert.match(appJs, /WebSocket connection timeout\."\);\s*resolve\(false\)/);
});

test('native PiP keeps one polished full layout', () => {
    assert.match(miniPlayerJs, /full:\s*\{\s*width:\s*640,\s*height:\s*260\s*\}/);
    assert.match(miniPlayerJs, /PIP_FRAME_RATE\s*=\s*1/);
    assert.match(miniPlayerJs, /openBestPiP\(\)/);
    assert.match(miniPlayerJs, /const headerText = \[chapterTitle, bookTitle\]/);
    assert.doesNotMatch(miniPlayerJs, /NOW READING\s+•\s+CLOUD TTS/);
    assert.doesNotMatch(miniPlayerJs, /artSize|fillText\('♪'/);
    assert.match(miniPlayerJs, /function fitText\(/);
    assert.match(miniPlayerJs, /fitText\(ctx, pair\?\.current/);
    assert.match(miniPlayerJs, /id="mpw-pip-btn"/);
    assert.doesNotMatch(miniPlayerJs, /compact|mpw-pip-round-btn|mpw-player-round-pip-btn|drawCompactPipFrame/);
    assert.doesNotMatch(miniPlayerCss, /mpw-pip-compact|mpw-player-round-pip-btn/);
    assert.doesNotMatch(miniPlayerJs, /captureStream\(5\)/);
});

test('in-app player can collapse to a circle', () => {
    assert.match(miniPlayerJs, /id="mpw-collapse-btn"/);
    assert.match(miniPlayerJs, /mpw-collapsed/);
    assert.match(miniPlayerCss, /#mini-player-widget\.mpw-collapsed/);
});

test('service worker updates the shell and caches mini-player assets', () => {
    assert.match(serviceWorker, /cloud-tts-v4-pip-redesign/);
    assert.match(serviceWorker, /\/static\/js\/mini-player-widget\.js/);
    assert.match(serviceWorker, /\/static\/css\/mini-player\.css/);
    assert.match(serviceWorker, /self\.skipWaiting\(\)/);
    assert.match(serviceWorker, /clients\.claim\(\)/);
});
