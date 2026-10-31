/**
 * Console player: DOM wiring for the docked console, its panel (bottom sheet on
 * phones, popover from 1024px), the speed and sleep chips, scrub tracks and the
 * mirrored controls in the panel and Settings. Playback logic stays in app.js;
 * this module only clicks app.js's buttons, sets its canonical inputs and reads
 * STATE through window.MPW_BRIDGE.
 */
import { trapTab } from './ui-interactions.js';

const $ = (id) => document.getElementById(id);
const bridge = () => window.MPW_BRIDGE || null;
const appState = () => window.STATE || null;
const WIDE = window.matchMedia('(min-width: 1024px)');

const SPEED_PRESETS = [0.75, 1, 1.25, 1.5, 1.75, 2];
const SLEEP_CYCLE = [null, 15, 30, 60, 'chapter'];
const VOLUME_KEY = 'player-volume';
const LONG_PRESS_MS = 450;

function uiLang() {
    try { return localStorage.getItem('ui-lang') === 'vi' ? 'vi' : 'en'; } catch (_) { return 'en'; }
}

function t(key, fallback, vars = null) {
    const text = window.translations?.[uiLang()]?.[key] ?? fallback;
    return vars ? text.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? '')) : text;
}

function haptic(ms) {
    window.AudioHapticFX?.trigger?.(ms);
}

// ── Speed ────────────────────────────────────────────────────────────────────
function formatSpeed(value) {
    const v = Math.round(Number(value) * 100) / 100;
    return `${Number.isInteger(v * 10) ? v.toFixed(1) : v.toFixed(2)}×`;
}

function readStoredSpeed() {
    try {
        const saved = JSON.parse(localStorage.getItem('reader-settings-v1') || '{}');
        return Number(saved.speed) || 1;
    } catch (_) {
        return 1;
    }
}

function currentSpeed() {
    return Number(appState()?.settings?.speed) || Number($('speed-range')?.value) || readStoredSpeed();
}

function setSpeed(value) {
    const range = $('speed-range');
    if (!range) return;
    const min = Number(range.min) || 0.5;
    const max = Number(range.max) || 3;
    const next = Math.min(max, Math.max(min, Math.round(value * 20) / 20));
    range.value = String(next);
    range.dispatchEvent(new Event('input'));
    paintSpeed();
    return next;
}

function paintSpeed() {
    const speed = currentSpeed();
    const label = formatSpeed(speed);
    const chip = $('speak-speed-chip');
    if (chip) {
        chip.textContent = label;
        chip.dataset.on = String(Math.abs(speed - 1) > 0.001);
        chip.setAttribute('aria-label', t('speed-chip-label', 'Tốc độ đọc {v}. Chạm để đổi, nhấn giữ để chỉnh từng 0.05', { v: label }));
    }
    const out = $('cpanel-speed');
    if (out) out.textContent = label;
    const stepperOut = $('speed-stepper-val');
    if (stepperOut) stepperOut.textContent = `${(Math.round(speed * 100) / 100).toFixed(2)}×`;
    const val = $('speed-val');
    if (val) val.textContent = label;
}

function cycleSpeed() {
    const speed = currentSpeed();
    let index = SPEED_PRESETS.findIndex(s => Math.abs(s - speed) < 0.001);
    index = index === -1 ? SPEED_PRESETS.findIndex(s => s > speed) : (index + 1) % SPEED_PRESETS.length;
    if (index === -1) index = 0;
    const next = setSpeed(SPEED_PRESETS[index]);
    haptic(10);
    window.APP_STATUS?.toast(t('speed-toast', 'Tốc độ đọc: {v}', { v: formatSpeed(next) }), 'info');
}

let stepperOpen = false;

function onStepperOutside(event) {
    if ($('speed-stepper')?.contains(event.target) || $('speak-speed-chip')?.contains(event.target)) return;
    setStepper(false);
}

function onStepperKey(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    setStepper(false, { restoreFocus: true });
}

function setStepper(open, { restoreFocus = false } = {}) {
    const stepper = $('speed-stepper');
    if (!stepper || stepperOpen === open) return;
    stepperOpen = open;
    stepper.hidden = !open;
    $('speak-speed-chip')?.setAttribute('aria-expanded', String(open));
    if (open) {
        paintSpeed();
        // Sit above the chip, kept inside the console row.
        const chip = $('speak-speed-chip');
        const row = $('media-player');
        if (chip && row) {
            const width = stepper.offsetWidth;
            const centre = chip.offsetLeft + chip.offsetWidth / 2;
            const left = Math.max(8, Math.min(row.clientWidth - width - 8, centre - width / 2));
            stepper.style.left = `${left}px`;
            stepper.style.right = 'auto';
        }
        document.addEventListener('pointerdown', onStepperOutside, true);
        document.addEventListener('keydown', onStepperKey, true);
        stepper.querySelector('button')?.focus({ preventScroll: true });
    } else {
        document.removeEventListener('pointerdown', onStepperOutside, true);
        document.removeEventListener('keydown', onStepperKey, true);
        if (restoreFocus) $('speak-speed-chip')?.focus({ preventScroll: true });
    }
}

function initSpeedChip() {
    const chip = $('speak-speed-chip');
    if (!chip) return;
    let pressTimer = null;
    let longPressed = false;
    const clearPress = () => {
        if (pressTimer) clearTimeout(pressTimer);
        pressTimer = null;
    };
    chip.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        longPressed = false;
        clearPress();
        pressTimer = setTimeout(() => {
            pressTimer = null;
            longPressed = true;
            haptic(10);
            setStepper(true);
        }, LONG_PRESS_MS);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(type => chip.addEventListener(type, clearPress));
    chip.addEventListener('contextmenu', (event) => event.preventDefault());
    chip.addEventListener('click', (event) => {
        event.stopPropagation();
        if (longPressed) {
            longPressed = false;
            return;
        }
        if (stepperOpen) {
            setStepper(false);
            return;
        }
        cycleSpeed();
    });
    // Keyboard equivalent of the long press.
    chip.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            event.stopPropagation();
            setSpeed(currentSpeed() + (event.key === 'ArrowUp' ? 0.05 : -0.05));
        }
    });

    document.addEventListener('click', (event) => {
        const step = event.target.closest('[data-speed-step]');
        if (!step) return;
        event.stopPropagation();
        setSpeed(currentSpeed() + Number(step.dataset.speedStep));
    });
    $('speed-range')?.addEventListener('input', paintSpeed);
}

// ── Pitch & volume ───────────────────────────────────────────────────────────
function paintPitch() {
    const range = $('pitch-range');
    const out = $('cpanel-pitch');
    if (!range || !out) return;
    const v = Number(range.value) || 0;
    out.textContent = `${v >= 0 ? '+' : ''}${v} Hz`;
}

function initPitch() {
    document.addEventListener('click', (event) => {
        const step = event.target.closest('[data-pitch-step]');
        if (!step) return;
        const range = $('pitch-range');
        if (!range) return;
        const next = Math.min(Number(range.max), Math.max(Number(range.min), Number(range.value) + Number(step.dataset.pitchStep)));
        range.value = String(next);
        range.dispatchEvent(new Event('input'));
    });
    $('pitch-range')?.addEventListener('input', paintPitch);
}

function applyVolume(percent, persist = true) {
    const value = Math.min(100, Math.max(0, Math.round(Number(percent))));
    const audio = bridge()?.audio || $('main-audio');
    if (audio) audio.volume = value / 100;
    const label = `${value}%`;
    ['volume-val', 'cpanel-volume-val'].forEach(id => { const el = $(id); if (el) el.textContent = label; });
    if (persist) {
        try { localStorage.setItem(VOLUME_KEY, String(value)); } catch (_) {}
    }
}

function initVolume() {
    const range = $('volume-range');
    if (!range) return;
    let stored = 100;
    try { stored = Number(localStorage.getItem(VOLUME_KEY) ?? 100); } catch (_) {}
    if (!Number.isFinite(stored)) stored = 100;
    range.value = String(stored);
    applyVolume(stored, false);
    range.addEventListener('input', () => applyVolume(range.value));
}

// ── Mirrors: panel/Settings copies of a canonical control ────────────────────
function syncMirrors(root = document) {
    root.querySelectorAll('[data-mirror]').forEach(el => {
        const src = $(el.dataset.mirror);
        if (!src) return;
        if (el.tagName === 'SELECT' && el.options.length !== src.options.length) {
            el.replaceChildren(...[...src.options].map(opt => opt.cloneNode(true)));
        }
        el.value = src.value;
        if (!el.dataset.mirrorBound) {
            el.dataset.mirrorBound = '1';
            const type = el.tagName === 'SELECT' ? 'change' : 'input';
            el.addEventListener(type, () => {
                src.value = el.value;
                src.dispatchEvent(new Event(type));
                syncMirrors();
            });
        }
    });
    paintSpeed();
    paintPitch();
}

// ── Sleep timer chip + panel group ───────────────────────────────────────────
let sleepDetail = { active: false, seconds: 0, mode: null };

function sleepShortLabel(detail) {
    if (!detail.active) return t('state-off', 'Tắt');
    if (detail.mode === 'chapter') return t('sleep-chapter-short', 'hết ch.');
    return detail.seconds > 60 ? `${Math.ceil(detail.seconds / 60)}′` : `${detail.seconds}s`;
}

function paintSleep(detail = sleepDetail) {
    sleepDetail = detail;
    const short = sleepShortLabel(detail);
    const chip = $('sleep-chip');
    const chipLabel = $('sleep-chip-label');
    if (chip) {
        chip.dataset.on = String(!!detail.active);
        chip.setAttribute('aria-label', t('sleep-chip-label', 'Hẹn giờ tắt: {v}. Chạm để đổi', { v: short }));
    }
    if (chipLabel) {
        if (detail.active) delete chipLabel.dataset.i18n;
        else chipLabel.dataset.i18n = 'state-off';
        chipLabel.textContent = short;
    }
    const state = $('cpanel-sleep-state');
    if (state) {
        state.dataset.on = String(!!detail.active);
        if (detail.active) delete state.dataset.i18n;
        else state.dataset.i18n = 'state-off';
        state.textContent = short;
    }
    document.querySelectorAll('#console-panel [data-sleep]').forEach(btn => {
        if (btn.dataset.sleep === 'off') return;
        const value = btn.dataset.sleep === 'chapter' ? 'chapter' : Number(btn.dataset.sleep);
        btn.setAttribute('aria-pressed', String(!!detail.active && detail.mode === value));
    });
    const active = $('cpanel-sleep-active');
    if (active) active.hidden = !detail.active;
    const remaining = $('cpanel-sleep-remaining');
    if (remaining && detail.active) {
        if (detail.mode === 'chapter') {
            remaining.textContent = t('sleep-end-chapter', 'Hết chương');
        } else {
            const m = Math.floor(detail.seconds / 60);
            const s = String(detail.seconds % 60).padStart(2, '0');
            remaining.textContent = `${m}:${s}`;
        }
    }
}

function applySleep(value) {
    if (value === null || value === 'off') window.cancelSleepTimer?.();
    else if (value === 'chapter') window.setSleepTimerEndOfChapter?.();
    else window.setSleepTimerPreset?.(Number(value));
}

function cycleSleep() {
    const mode = appState()?.sleepTimer ? appState().sleepTimerMode : null;
    const index = SLEEP_CYCLE.indexOf(mode);
    const next = SLEEP_CYCLE[(index + 1) % SLEEP_CYCLE.length];
    applySleep(next);
    haptic(10);
}

function initSleep() {
    $('sleep-chip')?.addEventListener('click', (event) => {
        event.stopPropagation();
        cycleSleep();
    });
    $('console-panel')?.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-sleep]');
        if (!btn) return;
        const value = btn.dataset.sleep;
        const isCurrent = btn.getAttribute('aria-pressed') === 'true';
        applySleep(isCurrent ? 'off' : value);
    });
    $('cpanel-sleep-custom')?.addEventListener('submit', (event) => {
        event.preventDefault();
        const input = $('cpanel-sleep-min');
        if (window.startSleepTimerFromCustom?.(input?.value) && input) input.value = '';
    });
    document.addEventListener('sleeptimerchange', (event) => paintSleep(event.detail));
    window.addEventListener('uilanguagechange', () => {
        paintSleep();
        paintSpeed();
        paintChapterLabels();
    });
}

// ── Status line ──────────────────────────────────────────────────────────────
function statusTone(text) {
    const s = (text || '').trim();
    if (!s || /^(Ready|Streaming|Paused|System Ready|Changes saved!|Đã xóa!)$/i.test(s)) return 'quiet';
    if (/^(Lỗi|Error|Config Error)|RAM\/ROM|Chưa lưu/i.test(s)) return 'error';
    if (/^Session Expired|^Sleep Timer|Disconnected|failed|không phản hồi|Bấm Play|Ngoại tuyến|^Offline/i.test(s)) return 'warn';
    return 'busy';
}

function paintStatus() {
    const indicator = $('status-indicator');
    if (!indicator) return;
    const text = indicator.textContent;
    const tone = statusTone(text);
    $('media-player')?.setAttribute('data-status-tone', tone);
    const panelStatus = $('cpanel-status');
    if (panelStatus) {
        panelStatus.textContent = text;
        panelStatus.dataset.tone = tone;
    }
}

// ── Chapter labels, progress, play state ─────────────────────────────────────
function chapterInfo() {
    const state = appState();
    const book = state?.currentBook;
    if (!book) return null;
    const total = book.chapters?.length || 0;
    const index = state.currentChapterIndex || 0;
    const chapter = book.chapters?.[index] || {};
    return {
        index,
        total,
        title: chapter.title || '',
        sentences: chapter.count || chapter.sentences?.length || 0,
        sentence: Math.max(0, state.currentSentenceIndex || 0)
    };
}

function paintChapterLabels() {
    const info = chapterInfo();
    const label = $('console-chapter');
    if (label) label.textContent = info ? `C.${info.index + 1} ·` : '';
    const book = $('cpanel-book');
    if (book) book.textContent = $('player-author')?.textContent || 'Cloud TTS';
    const chapter = $('cpanel-chapter');
    if (chapter) chapter.textContent = info ? `C.${info.index + 1} · ${info.title}` : t('no-book-playing', 'Chưa phát truyện nào');
    const pos = $('cpanel-chpos');
    if (pos) pos.textContent = info ? `C.${info.index + 1} / ${info.total}` : '—';
    const prev = $('cpanel-prev-ch');
    if (prev) prev.textContent = info && info.index > 0 ? `C.${info.index}` : '—';
    const next = $('cpanel-next-ch');
    if (next) next.textContent = info && info.index < info.total - 1 ? `C.${info.index + 2}` : '—';
}

let scrubbing = null;

function progressPercent() {
    const width = $('progress-bar')?.style.width || '0%';
    return Math.max(0, Math.min(100, parseFloat(width) || 0));
}

function paintProgress() {
    if (scrubbing) return;
    const info = chapterInfo();
    const pct = progressPercent();
    const fill = document.querySelector('#cpanel-track .track__fill');
    if (fill) fill.style.width = `${pct}%`;
    const count = $('current-time-mock')?.textContent || '0 / 0';
    const panelCount = $('cpanel-count');
    if (panelCount) panelCount.textContent = t('sentence-of', 'Câu {v}', { v: count });
    const now = info ? info.sentence + 1 : 1;
    const max = info ? Math.max(1, info.sentences) : 1;
    [$('cpanel-track'), WIDE.matches ? $('progress-container') : null].forEach(track => {
        if (!track) return;
        track.setAttribute('aria-valuemax', String(max));
        track.setAttribute('aria-valuenow', String(now));
        track.setAttribute('aria-valuetext', t('sentence-of', 'Câu {v}', { v: `${now} / ${max}` }));
    });
}

function paintPlayState() {
    const state = $('play-btn')?.dataset.state || 'paused';
    const panelPlay = $('cpanel-play');
    if (panelPlay) {
        panelPlay.dataset.state = state;
        panelPlay.setAttribute('aria-label', state === 'playing' ? t('pause', 'Tạm dừng') : t('play', 'Phát'));
    }
}

function paintNavDisabled() {
    document.querySelectorAll('#console-panel [data-cpanel-click]').forEach(btn => {
        const src = $(btn.dataset.cpanelClick);
        if (src && btn.dataset.cpanelClick !== 'toc-download-btn' && btn.dataset.cpanelClick !== 'play-btn') btn.disabled = !!src.disabled;
    });
    const playDisabled = !appState()?.currentBook;
    const panelPlay = $('cpanel-play');
    if (panelPlay) panelPlay.disabled = playDisabled;
}

function paintDownload() {
    const box = $('cpanel-download');
    if (!box) return;
    const visible = !!appState()?.isDownloading || !$('toc-download-progress')?.classList.contains('hidden');
    box.hidden = !visible;
    if (!visible) return;
    $('cpanel-download-pct').textContent = $('toc-download-percent')?.textContent || '0%';
    $('cpanel-download-info').textContent = $('toc-download-chapter-info')?.textContent || '';
    const bar = $('cpanel-download-bar');
    if (bar) bar.style.width = $('toc-download-progress-bar')?.style.width || '0%';
}

function observe(id, callback, options) {
    const el = $(id);
    if (el) new MutationObserver(callback).observe(el, options);
}

function initObservers() {
    const text = { childList: true, characterData: true, subtree: true };
    observe('status-indicator', paintStatus, text);
    observe('player-title', paintChapterLabels, text);
    observe('player-author', paintChapterLabels, text);
    observe('progress-bar', paintProgress, { attributes: true, attributeFilter: ['style'] });
    observe('current-time-mock', paintProgress, text);
    observe('play-btn', paintPlayState, { attributes: true, attributeFilter: ['data-state'] });
    ['prev-btn', 'next-btn', 'prev-chunk-btn', 'next-chunk-btn'].forEach(id => {
        observe(id, paintNavDisabled, { attributes: true, attributeFilter: ['disabled'] });
    });
    observe('toc-download-progress', paintDownload, { attributes: true, attributeFilter: ['class'], childList: true, characterData: true, subtree: true });
}

// ── Scrub (panel track always; console track from 1024px) ───────────────────
function scrubIndexAt(track, clientX) {
    const info = chapterInfo();
    if (!info || !info.sentences) return null;
    const rect = track.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.min(info.sentences - 1, Math.max(0, Math.round(ratio * (info.sentences - 1))));
}

function previewScrub(track, index) {
    const info = chapterInfo();
    if (!info) return;
    const pct = info.sentences > 1 ? ((index + 1) / info.sentences) * 100 : 100;
    const fill = track.querySelector('.track__fill, .console-progress__bar');
    if (fill) fill.style.width = `${pct}%`;
    const label = `${index + 1} / ${info.sentences}`;
    track.setAttribute('aria-valuenow', String(index + 1));
    track.setAttribute('aria-valuetext', t('sentence-of', 'Câu {v}', { v: label }));
    if (track.id === 'cpanel-track') {
        const count = $('cpanel-count');
        if (count) count.textContent = t('sentence-of', 'Câu {v}', { v: label });
    } else {
        const count = $('current-time-mock');
        if (count) count.dataset.preview = label;
    }
}

function commitScrub(index) {
    const state = appState();
    if (index === null || !state?.currentBook) return;
    if (index !== state.currentSentenceIndex) bridge()?.playFromSentence?.(index);
}

function bindScrub(track, { wideOnly = false } = {}) {
    if (!track) return;
    let keyTimer = null;
    let pending = null;
    track.addEventListener('pointerdown', (event) => {
        if (wideOnly && !WIDE.matches) return;
        if (event.button !== 0) return;
        const index = scrubIndexAt(track, event.clientX);
        if (index === null) return;
        event.preventDefault();
        track.setPointerCapture?.(event.pointerId);
        const fill = track.querySelector('.track__fill, .console-progress__bar');
        scrubbing = { track, index, width: fill?.style.width || '' };
        track.dataset.scrubbing = 'true';
        previewScrub(track, index);
    });
    track.addEventListener('pointermove', (event) => {
        if (scrubbing?.track !== track) return;
        const index = scrubIndexAt(track, event.clientX);
        if (index === null) return;
        scrubbing.index = index;
        previewScrub(track, index);
    });
    const end = (commit) => {
        if (scrubbing?.track !== track) return;
        const { index, width } = scrubbing;
        scrubbing = null;
        if (!commit) {
            const fill = track.querySelector('.track__fill, .console-progress__bar');
            if (fill) fill.style.width = width;
        }
        delete track.dataset.scrubbing;
        const count = $('current-time-mock');
        if (count) delete count.dataset.preview;
        if (commit) commitScrub(index);
        paintProgress();
    };
    track.addEventListener('pointerup', () => end(true));
    track.addEventListener('pointercancel', () => end(false));
    track.addEventListener('keydown', (event) => {
        if (wideOnly && !WIDE.matches) return;
        const info = chapterInfo();
        if (!info || !info.sentences) return;
        const base = pending ?? info.sentence;
        const steps = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -10, PageUp: 10 };
        let next = null;
        if (event.key in steps) next = base + steps[event.key];
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = info.sentences - 1;
        if (next === null) return;
        event.preventDefault();
        event.stopPropagation();
        pending = Math.min(info.sentences - 1, Math.max(0, next));
        scrubbing = { track, index: pending };
        previewScrub(track, pending);
        clearTimeout(keyTimer);
        keyTimer = setTimeout(() => {
            const target = pending;
            pending = null;
            scrubbing = null;
            commitScrub(target);
            paintProgress();
        }, 500);
    });
}

function syncConsoleTrackRole() {
    const track = $('progress-container');
    if (!track) return;
    if (WIDE.matches) {
        track.setAttribute('role', 'slider');
        track.setAttribute('tabindex', '0');
        track.setAttribute('aria-label', t('scrub-label', 'Tua trong chương'));
        track.removeAttribute('aria-hidden');
    } else {
        ['role', 'tabindex', 'aria-label', 'aria-valuenow', 'aria-valuemax', 'aria-valuemin', 'aria-valuetext'].forEach(a => track.removeAttribute(a));
        track.setAttribute('aria-hidden', 'true');
    }
    paintProgress();
}

// ── Panel ────────────────────────────────────────────────────────────────────
let panelOpen = false;
let panelReturnFocus = null;

function onPanelOutside(event) {
    const panel = $('console-panel');
    if (panel?.contains(event.target) || $('console-panel-btn')?.contains(event.target)) return;
    // Clicking another console control keeps the popover; clicking elsewhere closes it.
    if (WIDE.matches && $('media-player')?.contains(event.target)) return;
    closePanel({ restoreFocus: false });
}

function onPanelKey(event) {
    if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closePanel();
        return;
    }
    if (!WIDE.matches) trapTab($('console-panel'), event);
}

function syncPanelLayout() {
    const scrim = $('console-panel-scrim');
    const panel = $('console-panel');
    if (!panel) return;
    if (scrim) scrim.hidden = !panelOpen || WIDE.matches;
    panel.setAttribute('aria-modal', String(!WIDE.matches));
}

function openPanel() {
    const panel = $('console-panel');
    if (!panel || panelOpen) return;
    if ($('media-player-shell')?.classList.contains('player-discovery-dock')) return;
    setStepper(false);
    panelOpen = true;
    panelReturnFocus = document.activeElement;
    paintChapterLabels();
    paintProgress();
    paintPlayState();
    paintNavDisabled();
    paintStatus();
    paintDownload();
    paintSleep();
    syncMirrors(panel);
    panel.hidden = false;
    syncPanelLayout();
    $('console-panel-btn')?.setAttribute('aria-expanded', 'true');
    document.addEventListener('keydown', onPanelKey, true);
    document.addEventListener('pointerdown', onPanelOutside, true);
    $('cpanel-close')?.focus({ preventScroll: true });
}

function closePanel({ restoreFocus = true } = {}) {
    const panel = $('console-panel');
    if (!panel || !panelOpen) return false;
    panelOpen = false;
    panel.hidden = true;
    syncPanelLayout();
    $('console-panel-btn')?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onPanelKey, true);
    document.removeEventListener('pointerdown', onPanelOutside, true);
    if (restoreFocus && panelReturnFocus?.isConnected) panelReturnFocus.focus({ preventScroll: true });
    panelReturnFocus = null;
    return true;
}

// Vertical swipe: up on the phone console opens the panel, down on its head closes it.
function bindSwipe(el, direction, action, { ignore = 'button, select, input, label, a, [role="slider"]' } = {}) {
    if (!el) return;
    let startY = null;
    el.addEventListener('pointerdown', (event) => {
        if (WIDE.matches || event.target.closest(ignore)) return;
        startY = event.clientY;
    });
    el.addEventListener('pointerup', (event) => {
        if (startY === null) return;
        const dy = event.clientY - startY;
        startY = null;
        if ((direction === 'up' && dy < -30) || (direction === 'down' && dy > 50)) action();
    });
    el.addEventListener('pointercancel', () => { startY = null; });
}

function initPanel() {
    $('console-panel-btn')?.addEventListener('click', (event) => {
        event.stopPropagation();
        if (panelOpen) closePanel();
        else openPanel();
    });
    $('cpanel-close')?.addEventListener('click', () => closePanel());
    $('console-panel-scrim')?.addEventListener('click', () => closePanel({ restoreFocus: false }));

    $('console-panel')?.addEventListener('click', (event) => {
        const proxy = event.target.closest('[data-cpanel-click]');
        if (!proxy || proxy.disabled) return;
        $(proxy.dataset.cpanelClick)?.click();
    });

    $('cpanel-pocket')?.addEventListener('click', () => {
        closePanel({ restoreFocus: false });
        (bridge()?.applyLiteMode || window.applyLiteMode)?.(true);
    });
    $('cpanel-advanced')?.addEventListener('click', () => {
        closePanel({ restoreFocus: false });
        window.SettingsSheet?.open('advanced');
    });

    const pip = $('cpanel-pip');
    if (pip && (document.pictureInPictureEnabled || 'documentPictureInPicture' in window)) {
        pip.hidden = false;
        pip.addEventListener('click', () => {
            closePanel({ restoreFocus: false });
            $('mpw-player-pip-btn')?.click();
        });
    }

    bindSwipe($('media-player'), 'up', openPanel);
    bindSwipe(document.querySelector('#console-panel .sheet__grab'), 'down', () => closePanel());
    bindSwipe(document.querySelector('#console-panel .cpanel__head'), 'down', () => closePanel());

    WIDE.addEventListener('change', () => {
        syncPanelLayout();
        syncConsoleTrackRole();
        setStepper(false);
    });
}

function paintAll() {
    paintSpeed();
    paintPitch();
    paintSleep();
    paintStatus();
    paintChapterLabels();
    paintProgress();
    paintPlayState();
    paintNavDisabled();
    syncConsoleTrackRole();
    const volume = $('volume-range');
    if (volume) applyVolume(volume.value, false);
}

export function initConsolePlayer() {
    initSpeedChip();
    initPitch();
    initVolume();
    initSleep();
    initObservers();
    initPanel();
    bindScrub($('cpanel-track'));
    bindScrub($('progress-container'), { wideOnly: true });
    paintAll();
    // app.js runs after this module: repaint once its STATE and bridge exist.
    document.addEventListener('mpw-bridge-ready', paintAll, { once: true });
    document.addEventListener('playersettingschange', () => {
        syncMirrors();
        paintSpeed();
    });
    $('voice-select')?.addEventListener('change', () => syncMirrors());
}

if (typeof window !== 'undefined') {
    window.ConsolePlayer = { openPanel, closePanel, syncMirrors, setSpeed };
}
