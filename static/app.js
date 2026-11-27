// Firebase Modules
import { initializeFirestore, getFirestore, waitForPendingWrites, terminate, doc, setDoc, getDoc, deleteDoc, serverTimestamp, collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { compressImageForStorage, IMAGE_MAX_BYTES } from "./js/image-manager.js";
import { toggleSidebar, trapTab, paintRange, normalizeThemeId, applyTheme as applyThemeTokens, ensureReaderFont, readerFontStack, DEFAULT_READER_FONT } from "./js/modules/ui-interactions.js";
import { AccountSessions } from "./js/modules/account-sessions.js";
import { createAccountMenu } from "./js/modules/account-menu.js";
import { displayTitle, shortChapterTitle } from "./js/modules/utils.js";
import { openLayer, closeLayer } from "./js/modules/layer-history.js";

// Firebase placeholders (Initialized via API); swapped on account switch
let app, auth, db;
let accountSessions = null;
let accountMenu = null;

// Keep enough compressed audio for background playback without dispatching
// hundreds of TTS jobs at once. The old 150/500-chunk policy caused large
// network, MSE and server bursts on phones.
const FOREGROUND_PREFETCH_CHUNKS = 12;
const BACKGROUND_PREFETCH_CHUNKS = 16;
// Keep the MSE forward buffer bounded. Browser SourceBuffer quotas are
// implementation-dependent, so a time budget is safer than a chunk count.
const MAX_BUFFER_AHEAD_SECONDS = 180;
// Prefetch window is sized in audio time: ~15 chars/s for the Vietnamese
// voices at +0%, capped at PREFETCH_MAX_COUNT_FACTOR x the sentence count.
const PREFETCH_AHEAD_SECONDS = 130;
const EST_CHARS_PER_SECOND = 15;
const PREFETCH_MAX_COUNT_FACTOR = 4;
const BUFFER_HISTORY_SECONDS = 10;
// Edge TTS silently caps rate at +100%; anything faster is made up by the
// browser's pitch-preserving playbackRate on top of the 2x audio.
const TTS_MIN_SPEED = 0.5;
const TTS_MAX_SPEED = 2;
const MIN_PLAYBACK_RATE = 0.25;
const MAX_PLAYBACK_RATE = 4;

// App State
let STATE = {
    user: null,
    currentBook: null,
    currentBookId: null,
    currentFilename: null,
    imageManifest: null,
    imageManifestCache: new Map(),
    imageURLCache: new Map(),
    coverResolved: new Map(),
    libraryTocCache: new Map(),
    pendingImageFiles: [],
    uploadImagesChoice: false,
    uploadInputTarget: 'sidebar',
    pendingUploadTextFile: null,
    pendingUploadImageFiles: [],
    imageEditTargetId: null,
    currentChapterIndex: 0,
    currentSentenceIndex: 0,
    lastSavedChunkIndex: -1,
    strictSyncMode: false, // Automatic sync triggers enabled
    isPlaying: false,
    isStalled: false, // Emergency stop flag
    pendingClockReset: false, // Hardware clock sync flag
    metadata: [],
    fetchingSet: new Set(), // indices being fetched
    ws: null,
    metadataQueue: [], // Temporary store for metadata before binary arrive
    settings: {
        voice: "vi-VN-HoaiMyNeural",
        speed: 1.0,
        pitch: "+0Hz",
        volume: "+0%",
        numWorkers: 2,
        useProxy: true, // allow the server's Edge proxy route
        gttsFallback: false, // use Google TTS when Edge fails
        fontSize: (function () {
            const saved = localStorage.getItem('reader-font-size');
            if (saved) return parseInt(saved, 10);
            return window.innerWidth < 480 ? 18 : 20;
        })(),
        textColor: "default"
    },
    theme: (function () {
        try {
            return normalizeThemeId(localStorage.getItem('reader-theme'));
        } catch (_) {
            return normalizeThemeId(null);
        }
    })(),
    isTransitioning: false,
    isSwitchingChapter: false,
    chapterSwitchSeq: 0,
    // MSE State
    mediaSource: null,
    sourceBuffer: null,
    appendQueue: [],
    chunkTimings: [], // { index, startTime, duration }
    isAppending: false,
    sessionId: 0,
    lastAppendedIndex: -1,
    lastAppendedChapter: 0,
    // Progressive sentences arrive as parts 0..n-1. lastAppendedPartKey/Part
    // track the sentence currently being filled; completedParts holds the part
    // count reported by PREFETCH_DONE, partialAudio the parts for offline cache.
    lastAppendedPartKey: null,
    lastAppendedPart: -1,
    completedParts: new Map(),
    partialAudio: new Map(),
    isFirstChunkOfSession: false,
    prefetchTimeout: null,
    appendRetryTimeout: null,
    prefetchBatchStatus: {
        completed: 0,
        total: 0
    },
    wakeLockEnabled: localStorage.getItem('wakeLockEnabled') === 'true',
    wakeLockSentinel: null,
    zenModeEnabled: localStorage.getItem('zen-mode-enabled') === 'true',
    // Sleep Timer & Stall Detection
    sleepTimer: null,
    sleepTimerEnd: 0,
    sleepTimerMode: null,
    sleepTimerTarget: null,
    // Set when the sleep timer or idle timeout closed the socket on purpose:
    // background prefetches must not reopen it until the user plays again.
    socketParked: false,
    lastPlaybackTime: 0,
    lastPlaybackTick: 0,
    stallCount: 0,
    pauseCount: 0,
    pauseTimeoutHandled: false,
    // Offline Download
    isDownloading: false,
    downloadBuffer: new Map(),
    downloadExpected: 0,
    downloadPendingQueue: [],
    downloadInFlight: new Set(),
    downloadResolve: null,
    downloadReject: null,
    downloadChunkMeta: new Map(), // key -> { chapterIndex, index, text, voice, rate, pitch, volume } for retry
    downloadRetryCount: new Map(), // key -> retry attempt count
    streamingRetryCount: new Map(), // key -> retry attempt count for streaming
    _stallRecoveryCount: 0, // tracking recovery attempts
    // Segmentation & Pagination
    isSegmented: false,
    segmentFormatVersion: 0,
    segmentSize: 100,
    segmentsCount: 0,
    currentSegmentIndex: -1,
    loadedSegments: new Set(), // indices of segments currently in memory
    // Performance Optimization State
    loadGeneration: 0,
    selectionGeneration: 0,
    loadController: null,
    progressSaveChain: Promise.resolve(),
    progressSaveVersion: 0,
    progressRetryTimer: null,
    pendingProgressRetry: null,
    lastProgressSaveError: null,
    heartbeatInterval: null,
    lastHighlightedIndex: -1,
    lastOntimeUpdateTick: 0,
    // Lite Mode: JS-level flag (avoids repeated DOM class checks)
    isLiteMode: false,
    // UI render cache: prevents redundant DOM writes
    lastProgressWidth: null,
    lastCurrentMock: null,
    lastTimeStr: null,
    // Statistics
    stats: {
        streak: 0,
        totalTime: 0,
        lastReadDate: 'never',
        booksCompleted: 0
    }
};

window.STATE = STATE;

const DEFAULT_SETTINGS = JSON.parse(JSON.stringify(STATE.settings));

// ── Local-only settings ─────────────────────────────────────────────────────
// Giọng đọc / tốc độ / pitch / màu chữ... lưu trên máy này (localStorage),
// áp dụng cho mọi truyện, KHÔNG đồng bộ theo từng sách qua Firestore nữa.
const LOCAL_SETTINGS_KEY = 'reader-settings-v1';

(function restoreLocalSettings() {
    try {
        const saved = JSON.parse(localStorage.getItem(LOCAL_SETTINGS_KEY) || 'null');
        if (saved && typeof saved === 'object') {
            delete saved.fontSize; // fontSize có khoá riêng 'reader-font-size'
            STATE.settings = { ...STATE.settings, ...saved };
        }
    } catch (_) { /* JSON hỏng -> giữ mặc định */ }
})();

const NETWORK_DEFAULT_TIMEOUT_MS = 20_000;
const NETWORK_DEFAULT_RETRIES = 2;

class NetworkTimeoutError extends Error {
    constructor(url, timeoutMs) {
        super(`Request timed out after ${timeoutMs}ms: ${url}`);
        this.name = 'NetworkTimeoutError';
        this.retryable = true;
    }
}

function promiseWithTimeout(promise, timeoutMs, message) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new NetworkTimeoutError(message, timeoutMs)), timeoutMs);
        })
    ]).finally(() => clearTimeout(timer));
}

function shouldRetryNetworkError(error) {
    return error instanceof NetworkTimeoutError || error?.name === 'TypeError' || error?.retryable === true;
}

function createLoadTrace(bookId) {
    const started = performance.now();
    return label => console.debug(`[LoadTiming] book=${bookId} step=${label} elapsed_ms=${(performance.now() - started).toFixed(1)}`);
}

async function fetchWithTimeout(url, options = {}, config = {}) {
    const timeoutMs = config.timeoutMs ?? NETWORK_DEFAULT_TIMEOUT_MS;
    const retries = config.retries ?? NETWORK_DEFAULT_RETRIES;
    const externalSignal = options.signal;
    let lastError;

    for (let attempt = 0; attempt <= retries; attempt++) {
        if (externalSignal?.aborted) throw new DOMException('Request aborted', 'AbortError');
        const controller = new AbortController();
        const abortForwarder = () => controller.abort(externalSignal.reason);
        externalSignal?.addEventListener('abort', abortForwarder, { once: true });
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, { ...options, signal: controller.signal });
            if (response.ok || ![502, 503, 504].includes(response.status) || attempt === retries) return response;
            lastError = new Error(`HTTP ${response.status}`);
            lastError.retryable = true;
        } catch (error) {
            if (externalSignal?.aborted) throw error;
            if (error.name === 'AbortError') {
                lastError = new NetworkTimeoutError(url, timeoutMs);
            } else {
                lastError = error;
            }
            if (!shouldRetryNetworkError(lastError) || attempt === retries) throw lastError;
        } finally {
            clearTimeout(timer);
            externalSignal?.removeEventListener('abort', abortForwarder);
        }
        await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1) + Math.random() * 250));
    }
    throw lastError;
}

// --- Offline & Cache Manager (IndexedDB) ---
const OFFLINE_MANAGER = {
    dbName: 'CloudTTSReaderDB',
    dbVersion: 1,
    storeName: 'audio_cache',
    _db: null,
    _dbPromise: null,
    speeds: new Map(),

    async init() {
        if (this._db) return;
        if (this._dbPromise) return this._dbPromise;

        this._dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);
            request.onerror = () => {
                this._dbPromise = null;
                reject(request.error);
            };
            request.onsuccess = () => {
                this._db = request.result;
                resolve();
            };
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName);
                }
            };
        });
        return this._dbPromise;
    },

    async saveBlob(bookId, chIndex, sIndex, blob) {
        await this.init();
        if (!this._db) return;
        const key = `${bookId}_${chIndex}_${sIndex}`;
        return new Promise((resolve, reject) => {
            const tx = this._db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            store.put(blob, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    },

    async getBlob(bookId, chIndex, sIndex) {
        await this.init();
        if (!this._db) return null;
        const key = `${bookId}_${chIndex}_${sIndex}`;
        return new Promise((resolve, reject) => {
            const tx = this._db.transaction(this.storeName, 'readonly');
            const store = tx.objectStore(this.storeName);
            const request = store.get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    },

    async clearCache() {
        this.speeds.clear();
        await this.init();
        return new Promise((resolve, reject) => {
            const tx = this._db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            const request = store.clear();
            request.onsuccess = () => {
                this.updateUsageUI();
                resolve();
            };
            request.onerror = () => reject(request.error);
        });
    },

    async updateUsageUI() {
        await this.init();
        const tx = this._db.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        const request = store.getAll();
        request.onsuccess = () => {
            const blobs = request.result;
            const totalBytes = blobs.reduce((sum, b) => sum + b.size, 0);
            const mb = (totalBytes / (1024 * 1024)).toFixed(2);
            const el = document.getElementById('offline-usage-text');
            if (el) el.innerText = `${mb} MB`;
        };
    }
};

// --- Statistics & Insights Manager ---
const STATS_MANAGER = {
    _lastActiveTime: 0,
    _syncTimer: null,
    _saveChain: Promise.resolve(),
    // Stats are only written back for the account they were loaded from, so
    // unloaded zeros never overwrite a real streak.
    _loadedUid: null,

    init() {
        this._lastActiveTime = Date.now();
        // Start tracking only when playing
        setInterval(() => this.track(), 10000); // Track every 10s
    },

    async track() {
        const now = Date.now();
        const deltaMs = now - this._lastActiveTime;
        this._lastActiveTime = now;

        if (!STATE.isPlaying || !STATE.user || this._loadedUid !== STATE.user.uid) return;

        // Add to local state
        STATE.stats.totalTime += Math.floor(deltaMs / 1000);

        // Update Streak
        const today = new Date().toDateString();
        if (STATE.stats.lastReadDate !== today) {
            const lastDate = new Date(STATE.stats.lastReadDate);
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);

            if (lastDate.toDateString() === yesterday.toDateString()) {
                STATE.stats.streak += 1;
            } else if (STATE.stats.lastReadDate === 'never') {
                STATE.stats.streak = 1;
            } else {
                // If it's not today and not yesterday, reset
                STATE.stats.streak = 1;
            }
            STATE.stats.lastReadDate = today;
        }

        this.updateUI();
        this.scheduleSync();
    },

    updateUI() {
        const streakEl = document.getElementById('stat-streak');
        const timeEl = document.getElementById('stat-total-time');

        if (streakEl) {
            streakEl.innerText = STATE.stats.streak;
            const label = streakEl.nextElementSibling;
            if (label?.dataset.i18n?.startsWith('day-streak')) {
                label.dataset.i18n = STATE.stats.streak === 1 ? 'day-streak-one' : 'day-streak';
                label.textContent = tr(label.dataset.i18n, 'days in a row');
            }
        }
        if (timeEl) {
            const mins = Math.floor(STATE.stats.totalTime / 60);
            timeEl.innerText = mins > 60
                ? tr('hours-n', '{n} giờ', { n: (mins / 60).toFixed(1) })
                : tr('minutes-n', '{n} phút', { n: mins });
        }
    },

    scheduleSync() {
        if (this._syncTimer) return;
        this._syncTimer = setTimeout(async () => {
            this._syncTimer = null;
            await this.syncToFirestore();
        }, 30000); // Sync every 30s
    },

    async syncToFirestore(force = false) {
        if (!STATE.user || this._loadedUid !== STATE.user.uid || (STATE.strictSyncMode && !force)) return false;
        const userId = STATE.user.uid;
        const firestore = db;
        const statsSnapshot = { ...STATE.stats };
        const write = async () => {
            try {
                const statsRef = doc(firestore, 'users', userId, 'stats', 'reading');
                await setDoc(statsRef, statsSnapshot, { merge: true });
                return true;
            } catch (err) {
                console.warn('[Stats] Sync failed:', err);
                return false;
            }
        };

        // Keep an older asynchronous write from finishing after a newer one
        // with a stale full snapshot.
        const queuedWrite = this._saveChain.then(write, write);
        this._saveChain = queuedWrite.catch(() => { });
        return queuedWrite;
    },

    async load() {
        if (!STATE.user) return;
        const uid = STATE.user.uid;
        try {
            const statsRef = doc(db, 'users', uid, 'stats', 'reading');
            const snap = await getDoc(statsRef);
            if (STATE.user?.uid !== uid) return;
            if (snap.exists()) {
                STATE.stats = { ...STATE.stats, ...snap.data() };
            }
            this._loadedUid = uid;
            this.updateUI();
        } catch (err) {
            console.warn('[Stats] Load failed:', err);
        }
    }
};

// --- Firebase Initialization ---
async function startFirebase() {
    try {
        const response = await fetchWithTimeout('/api/firebase-config', {}, { timeoutMs: 10_000, retries: 2 });
        const firebaseConfig = await response.json();

        if (!firebaseConfig.apiKey) {
            console.error("Firebase Configuration is missing! Check your environment variables.");
            document.getElementById('status-indicator').innerText = tr('status-config-error', 'Config Error');
            return;
        }

        if (!accountSessions) {
            accountSessions = new AccountSessions(firebaseConfig, {
                onSession: handleAccountSession,
                beforeLeave: () => leaveAccount({ save: true }),
                onAccountsChange: () => accountMenu?.render()
            });
            accountMenu = createAccountMenu({
                sessions: accountSessions,
                onError: message => APP_STATUS.error(message),
                onStatus: text => APP_STATUS.set(text),
                onSync: () => { void syncLibraryNow(); },
                syncLabel: librarySyncLabel
            });
            await accountSessions.start();
        }

        console.log("Firebase initialized successfully via API");
    } catch (err) {
        console.error("Failed to initialize Firebase:", err);
        accountSessions = null;
        setTimeout(startFirebase, 5000); // Retry, bounded by fetchWithTimeout
    }
}

function attachFirestore(firebaseApp) {
    try {
        return initializeFirestore(firebaseApp, {
            experimentalForceLongPolling: true,
            useFetchStreams: false,
        });
    } catch (e) {
        return getFirestore(firebaseApp);
    }
}

async function handleAccountSession(session) {
    if (!session) {
        await leaveAccount({ save: false });
        accountMenu?.render();
        renderSignedOutLibrary();
        return;
    }

    app = session.app;
    auth = session.auth;
    db = attachFirestore(app);
    STATE.user = session.user;
    accountMenu?.render();

    void STATS_MANAGER.load();
    await refreshLibrary();
    initWebSocket();
    APP_STATUS.set(tr('status-ready', 'Ready'));
}

/**
 * Detach everything tied to the current account before another one becomes
 * active: flush its progress and stats, stop playback, close the open book and
 * drop per-user caches so nothing is written to or shown for the next account.
 */
async function leaveAccount({ save }) {
    // Cancel book loads, uploads and downloads that belong to this account
    // before anything else, so none of them can finish under the next one.
    STATE.loadController?.abort();
    STATE.selectionGeneration++;
    STATE.loadGeneration++;
    if (STATE.isDownloading) stopDownload();

    const leavingDb = db;
    if (save && STATE.user && leavingDb) {
        const flush = Promise.allSettled([saveProgress(true), STATS_MANAGER.syncToFirestore(true)])
            .then(() => waitForPendingWrites(leavingDb));
        await promiseWithTimeout(flush, 6_000, 'Account switch flush')
            .catch(err => console.warn('[Accounts] Flush before leaving account incomplete:', err));
    }
    // Writes still stuck behind an offline/slow Firestore must not block or
    // reach the next account.
    STATE.progressSaveVersion++;
    STATE.progressSaveChain = Promise.resolve();
    STATS_MANAGER._saveChain = Promise.resolve();
    STATS_MANAGER._loadedUid = null;
    db = null;
    if (leavingDb) terminate(leavingDb).catch(err => console.warn('[Accounts] Firestore terminate failed:', err));

    if (STATE.progressRetryTimer) clearTimeout(STATE.progressRetryTimer);
    STATE.progressRetryTimer = null;
    STATE.pendingProgressRetry = null;
    if (STATS_MANAGER._syncTimer) clearTimeout(STATS_MANAGER._syncTimer);
    STATS_MANAGER._syncTimer = null;

    if (STATE.currentBookId) {
        await stopPlaybackSession();
        closeCurrentBook();
    } else {
        closeWebSocketIntentionally();
    }

    STATE.user = null;
    STATE.stats = { streak: 0, totalTime: 0, lastReadDate: 'never', booksCompleted: 0 };
    STATS_MANAGER.updateUI();
    STATE.imageManifest = null;
    STATE.imageManifestCache.clear();
    STATE.imageURLCache.forEach(url => URL.revokeObjectURL(url));
    STATE.imageURLCache.clear();
    STATE.coverResolved.clear();
    STATE.libraryTocCache.clear();
    discoveryLibrary = [];
    // Never show the previous account's shelf while the next one loads.
    libraryView.refreshSeq += 1;
    libraryView.status = 'idle';
    libraryView.syncedAt = 0;
    libraryView.expanded = { sidebar: null, shelf: null };
    renderLibraryViews();
    auth = null;
    app = null;
}

function renderSignedOutLibrary() {
    libraryView.refreshSeq += 1;
    libraryView.status = 'signed-out';
    libraryView.expanded = { sidebar: null, shelf: null };
    discoveryLibrary = [];
    STATE.libraryTocCache.clear();
    const discoverySearchInput = document.getElementById('discovery-search');
    if (discoverySearchInput) discoverySearchInput.value = '';
    renderLibraryViews();
}

/** Fetch helper for backend endpoints that access the authenticated user's data. */
// authFetch's own messages already tell the user what to do; callers show them as-is.
function userFacingError(message) {
    const error = new Error(message);
    error.userFacing = true;
    return error;
}

async function authFetch(url, options = {}) {
    const user = STATE.user || auth?.currentUser;
    if (!user) throw new Error('Authentication required');
    const { timeoutMs = NETWORK_DEFAULT_TIMEOUT_MS, retries, ...requestOptions } = options;
    const headers = new Headers(requestOptions.headers || {});
    try {
        let token = await promiseWithTimeout(user.getIdToken(), 10_000, 'Firebase token');
        headers.set('Authorization', `Bearer ${token}`);
        let response = await fetchWithTimeout(url, { ...requestOptions, headers }, {
            timeoutMs,
            retries: retries ?? (requestOptions.method && requestOptions.method.toUpperCase() !== 'GET' ? 0 : NETWORK_DEFAULT_RETRIES)
        });
        if (response.status === 401) {
            // A local server restart can coincide with an old cached Firebase
            // token. Force one refresh before asking the user to log in again.
            token = await promiseWithTimeout(user.getIdToken(true), 10_000, 'Firebase token refresh');
            headers.set('Authorization', `Bearer ${token}`);
            response = await fetchWithTimeout(url, { ...requestOptions, headers }, { timeoutMs, retries: 0 });
        }
        if (response.status === 401) throw userFacingError(tr('auth-expired', 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.'));
        if (response.status === 403) throw userFacingError(tr('auth-forbidden', 'Bạn không có quyền thực hiện thao tác này.'));
        return response;
    } catch (error) {
        if (error instanceof NetworkTimeoutError) {
            const timeoutError = userFacingError(tr('net-timeout', 'Máy chủ phản hồi quá lâu. Hãy thử lại.'));
            timeoutError.code = 'NETWORK_TIMEOUT';
            timeoutError.cause = error;
            throw timeoutError;
        }
        if (error instanceof TypeError) throw userFacingError(tr('net-unreachable', 'Không thể kết nối máy chủ. Hãy kiểm tra mạng và thử lại.'));
        throw error;
    }
}

const AudioHapticFX = {
    audioCtx: null,
    // Settings → "Rung và tiếng bấm" turns both off ('ui-feedback' = 'off').
    isMuted: (() => { try { return localStorage.getItem('ui-feedback') === 'off'; } catch (_) { return false; } })(),
    initCtx() {
        if (!this.audioCtx) {
            const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
            if (AudioCtxClass) {
                this.audioCtx = new AudioCtxClass();
            }
        }
        if (this.audioCtx && this.audioCtx.state === 'suspended') {
            this.audioCtx.resume().catch(() => {});
        }
    },
    haptic(ms = 12) {
        if (this.isMuted) return;
        if (typeof navigator !== 'undefined' && navigator.vibrate) {
            try { navigator.vibrate(ms); } catch (e) {}
        }
    },
    clickSound() {
        if (this.isMuted) return;
        try {
            this.initCtx();
            if (!this.audioCtx) return;
            const osc = this.audioCtx.createOscillator();
            const gain = this.audioCtx.createGain();
            const now = this.audioCtx.currentTime;
            osc.type = 'sine';
            osc.frequency.setValueAtTime(1200, now);
            osc.frequency.exponentialRampToValueAtTime(360, now + 0.015);
            gain.gain.setValueAtTime(0.035, now);
            gain.gain.exponentialRampToValueAtTime(0.0008, now + 0.015);
            osc.connect(gain);
            gain.connect(this.audioCtx.destination);
            osc.start(now);
            osc.stop(now + 0.016);
        } catch (e) {}
    },
    trigger(ms = 12) {
        this.haptic(ms);
        this.clickSound();
    }
};

window.AudioHapticFX = AudioHapticFX;

// #play-btn holds both icons; data-state picks one. The console panel mirrors it.
function setPlayIcon(isPlaying) {
    const btn = document.getElementById('play-btn');
    if (!btn) return;
    // The pause that starts a jump must not hide the loading state.
    if (!isPlaying && STATE.playLoading) {
        updateDiscoveryContinueCard();
        return;
    }
    STATE.playLoading = false;
    btn.removeAttribute('aria-busy');
    btn.dataset.state = isPlaying ? 'playing' : 'paused';
    const label = isPlaying ? tr('pause-key', 'Tạm dừng (Space)') : tr('play-key', 'Phát (Space)');
    btn.setAttribute('aria-label', label);
    btn.title = label;
    document.querySelector('#pocket-play-icon use')?.setAttribute('href', isPlaying ? '#i-pause' : '#i-play');
    updateDiscoveryContinueCard();
}

// Between a Play tap and the first sound (often several seconds): show it on the button.
function setPlayLoading() {
    const btn = document.getElementById('play-btn');
    if (!btn) return;
    STATE.playLoading = true;
    btn.dataset.state = 'loading';
    btn.setAttribute('aria-busy', 'true');
    const label = tr('status-buffering', 'Đang nạp âm thanh…');
    btn.setAttribute('aria-label', label);
    btn.title = label;
}

function setAudioWaveState(isPlaying) {
    document.querySelectorAll('.audio-wave-bars').forEach(el => el.classList.toggle('is-playing', !!isPlaying));
}

const TOAST_ACTION_MS = 10000;
// Chapter and image deletes wait out the Undo window before touching storage.
let pendingChapterDelete = null;
const pendingImageDeletes = new Map();
// Image commits run one at a time because each rewrites the shared manifest.
let imageDeleteChain = Promise.resolve();
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)');

function scrollBehavior() {
    return REDUCED_MOTION.matches ? 'auto' : 'smooth';
}

const APP_STATUS = {
    set(text) {
        const indicator = document.getElementById('status-indicator');
        if (!indicator) return;
        indicator.innerText = text;
        indicator.style.color = '';
    },
    toast(message, kind = 'error', { key = null, actions = [], action = null, duration = null, onExpire = null } = {}) {
        const region = document.getElementById('app-toast-region');
        if (!region) return;
        // A single `action` (e.g. "Hoàn tác") is shorthand for one entry in `actions`.
        if (action?.label && typeof action.onClick === 'function') actions = [...actions, action];

        // A keyed toast (e.g. reading speed) replaces its live predecessor instead of stacking.
        if (key) {
            const previous = [...region.children].find(node => node.dataset.toastKey === key && !node.dataset.leaving);
            if (previous?.refreshToast && !actions.length) {
                AudioHapticFX.haptic(14);
                previous.refreshToast(message);
                return;
            }
        }

        AudioHapticFX.haptic(14);

        const icons = { success: 'check', error: 'alert', warning: 'alert', info: 'info' };
        const titles = {
            success: tr('toast-success', 'Thành công'),
            error: tr('toast-error', 'Thông báo lỗi'),
            warning: tr('toast-warning', 'Cảnh báo'),
            info: tr('toast-info', 'Hệ thống')
        };

        const kindClass = `toast-kind-${kind || 'info'}`;
        const iconHtml = iconSVG(icons[kind] || icons.info, 'toast__icon');
        const titleText = titles[kind] || titles.info;
        // Only problems get a heading; info and success are one compact line.
        const brief = kind !== 'error' && kind !== 'warning';
        const plainLength = String(message).replace(/<[^>]*>/g, '').length;
        const shortLife = !kind || kind === 'info' ? Math.min(4800, 2000 + Math.max(0, plainLength - 40) * 40) : 4800;
        const lifetime = duration ?? (actions.length ? TOAST_ACTION_MS : shortLife);

        const toast = document.createElement('div');
        toast.className = `toast ${kindClass}${brief ? ' toast--brief' : ''}`;
        toast.style.setProperty('--toast-life', `${lifetime}ms`);
        toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
        if (actions.length) toast.dataset.hasAction = 'true';
        toast.innerHTML = `
            ${iconHtml}
            <div class="toast__body">
                ${brief ? '' : `<p class="toast__title">${titleText}</p>`}
                <div class="toast__msg">${message}</div>
            </div>
            <button type="button" class="toast__close" aria-label="${tr('toast-close', 'Đóng')}">${iconSVG('x', 'ic--sm')}</button>
            <div class="toast-progress-track">
                <div class="toast-progress-fill"></div>
            </div>
        `;

        const closeBtn = toast.querySelector('.toast__close');
        if (actions.length) {
            const row = document.createElement('div');
            row.className = 'toast-actions';
            actions.forEach(action => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'toast-action';
                btn.textContent = action.label;
                btn.addEventListener('click', event => {
                    event.stopPropagation();
                    dismiss();
                    action.onClick?.();
                });
                row.appendChild(btn);
            });
            toast.querySelector('.toast__body')?.appendChild(row);
        }
        let removeTimer = null;
        let remaining = lifetime;
        let startedAt = 0;
        let hovered = false;
        const dismiss = () => {
            if (removeTimer) clearTimeout(removeTimer);
            toast.dataset.leaving = 'true';
            toast.remove();
        };
        // Running out or the X accepts the toast (e.g. commits a delete); an action or a keyed replacement does not.
        const expire = () => {
            dismiss();
            onExpire?.();
        };
        const startTimer = () => {
            if (removeTimer) return;
            startedAt = Date.now();
            removeTimer = setTimeout(expire, remaining);
        };
        const pauseTimer = () => {
            if (!removeTimer) return;
            clearTimeout(removeTimer);
            removeTimer = null;
            remaining = Math.max(0, remaining - (Date.now() - startedAt));
        };
        const syncPause = () => {
            const held = hovered || toast.contains(document.activeElement);
            toast.classList.toggle('is-paused', held);
            if (held) pauseTimer(); else startTimer();
        };

        closeBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            expire();
        });
        toast.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') { hovered = true; syncPause(); } });
        toast.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { hovered = false; syncPause(); } });
        toast.addEventListener('focusin', syncPause);
        toast.addEventListener('focusout', syncPause);
        toast.dismissToast = dismiss;
        if (key) {
            toast.dataset.toastKey = key;
            toast.refreshToast = (nextMessage) => {
                const body = toast.querySelector('.toast__msg');
                if (body) body.innerHTML = nextMessage;
                const fill = toast.querySelector('.toast-progress-fill');
                if (fill) {
                    fill.style.animation = 'none';
                    void fill.offsetWidth;
                    fill.style.animation = '';
                }
                if (removeTimer) clearTimeout(removeTimer);
                removeTimer = null;
                remaining = lifetime;
                syncPause();
            };
        }
        if (key) {
            [...region.children]
                .filter(node => node.dataset.toastKey === key && !node.dataset.leaving)
                .forEach(node => (node.dismissToast ? node.dismissToast() : node.remove()));
        }

        // Keep the stack short so it never buries the reader on a phone: drop the oldest first.
        // A toast with an action (Hoàn tác) is never pushed out.
        const maxToasts = window.matchMedia('(max-width: 639.98px)').matches ? 2 : 3;
        const live = [...region.children].filter(node => !node.dataset.leaving);
        const evictable = live.filter(node => !node.dataset.hasAction);
        evictable.slice(0, Math.max(0, Math.min(evictable.length, live.length - maxToasts + 1))).forEach(node => (node.dismissToast ? node.dismissToast() : node.remove()));

        region.appendChild(toast);
        startTimer();
        requestAnimationFrame(() => revealFocusAboveToasts(region));
        return toast;
    },
    error(error, fallback = 'Đã xảy ra lỗi. Vui lòng thử lại.') {
        const message = (typeof error === 'string' ? error : error?.message) || fallback;
        this.set(tr('status-error', 'Lỗi'));
        this.toast(message, 'error');
    }
};
window.APP_STATUS = APP_STATUS;

// A toast must not sit on the control the user just pressed: scroll that control up above the stack.
function revealFocusAboveToasts(region) {
    const el = document.activeElement;
    if (!el || el === document.body || region.contains(el)) return;
    const box = el.getBoundingClientRect();
    const stack = region.getBoundingClientRect();
    if (!box.height || box.bottom <= stack.top || box.top >= stack.bottom || box.right <= stack.left || box.left >= stack.right) return;
    el.style.scrollMarginBottom = `${Math.ceil(window.innerHeight - stack.top) + 8}px`;
    el.scrollIntoView({ block: 'nearest' });
    el.style.scrollMarginBottom = '';
}
let imageManagerBookId = null;
let imageManagerBookTitle = '';

function updateNetworkStatus() {
    const banner = document.getElementById('network-status');
    if (!banner) return;
    banner.classList.toggle('hidden', navigator.onLine);
    APP_STATUS.set(navigator.onLine ? tr('status-ready', 'Ready') : tr('status-offline', 'Ngoại tuyến'));
}
window.addEventListener('offline', updateNetworkStatus);
window.addEventListener('online', () => {
    updateNetworkStatus();
    APP_STATUS.toast(tr('network-back', 'Đã kết nối lại mạng.'), 'success');
    retryPendingProgressSaveNow();
});
updateNetworkStatus();

startFirebase();

// --- Utility Functions ---
let discoveryPlayerWasMinimized = false;
let discoveryPlayerHasDock = false;

function toggleDiscoveryMode(isActive, options = {}) {
    const discoveryMode = document.getElementById('discovery-mode');
    const readerContainer = document.getElementById('reader-container');
    const sidebarContainer = document.getElementById('sidebar-container');
    const playerShell = document.getElementById('media-player-shell');
    const mediaPlayer = document.getElementById('media-player');
    const playerInfoLayer = document.getElementById('player-info-layer');

    document.body.dataset.view = isActive ? 'discovery' : 'reader';
    if (isActive) closeLayer('reader');
    else openLayer('reader', () => toggleDiscoveryMode(true));
    if (isActive && libraryView.orderFrozen) {
        libraryView.orderFrozen = false;
        discoveryLibrary.sort(byRecency);
        renderLibraryViews();
    }

    if (isActive) {
        // Keep the current audio/session context while browsing. Opening a
        // different book still resets it through loadBook as before.
        const hasReaderContext = !!STATE.currentBook;
        if (!hasReaderContext) {
            resetAudioEngine();
        }

        // The console row stays in place; with a book it becomes Home's return
        // dock, without one it is hidden like the reader it belongs to.
        playerShell?.classList.toggle('hidden', !hasReaderContext);
        if (hasReaderContext && playerShell && mediaPlayer) {
            if (!discoveryPlayerHasDock) {
                discoveryPlayerWasMinimized = mediaPlayer.classList.contains('minimized-player');
                discoveryPlayerHasDock = true;
            }
            playerShell.classList.add('player-discovery-dock');
            // Discovery uses the same player as a compact dock.
            toggleMinimize(true);
            playerInfoLayer?.setAttribute('tabindex', '0');
            playerInfoLayer?.setAttribute('aria-label', tr('dock-return-reader', 'Bấm để quay lại trình đọc'));
        }

        // PiP belongs to Reader. Close its floating surface before the player
        // becomes Discovery's return dock.
        if (window.MiniPlayerWidget) window.MiniPlayerWidget.onDiscoveryEnter();

        if (discoveryMode) discoveryMode.classList.remove('hidden');
        updateDiscoveryContinueCard();
        // From 1024px Home hides the library column; its search must not keep filtering unseen.
        const columnSearch = document.getElementById('library-search');
        if (columnSearch?.value && window.matchMedia('(min-width: 1024px)').matches) columnSearch.value = '';
        applyDiscoverySearch();
        // From 1024px CSS hides the column on Home; below that it is the off-canvas drawer, so just close it.
        toggleSidebar(false);
        if (sidebarContainer) sidebarContainer.classList.remove('hidden');
        if (readerContainer) readerContainer.classList.add('hidden');
        // Homepage không được litemode
        document.body.classList.remove('lite-mode');
    } else {
        const wasReturningFromDiscovery = discoveryPlayerHasDock && options.restoreFocus !== false;
        if (discoveryMode) discoveryMode.classList.add('hidden');
        if (sidebarContainer) sidebarContainer.classList.remove('hidden');

        if (playerShell) {
            playerShell.classList.remove('hidden');
            playerShell.classList.remove('player-discovery-dock');
            playerInfoLayer?.removeAttribute('tabindex');
            playerInfoLayer?.removeAttribute('aria-label');
            if (discoveryPlayerHasDock) {
                toggleMinimize(discoveryPlayerWasMinimized);
            }
        }
        if (readerContainer) readerContainer.classList.remove('hidden');
        // Restore lite-mode if enabled in settings
        if (STATE.isLiteMode) document.body.classList.add('lite-mode');

        discoveryPlayerHasDock = false;
        if (window.MiniPlayerWidget) window.MiniPlayerWidget.onDiscoveryExit();
        // Re-establish spatial context at the exact sentence/chunk that was
        // playing before Discovery opened.
        if (wasReturningFromDiscovery) {
            requestAnimationFrame(() => {
                if (!STATE.currentBook) return;
                const current = document.getElementById(`sentence-${STATE.currentSentenceIndex}`);
                if (current) {
                    highlightSentence(STATE.currentSentenceIndex);
                    current.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
                }
            });
        }
    }
}

document.getElementById('reader-back-btn')?.addEventListener('click', () => toggleDiscoveryMode(true));

const logoBtn = document.getElementById('logo-btn');
if (logoBtn) {
    logoBtn.onclick = (e) => {
        // Block discovery mode if Easter Egg was just activated
        if (window._lastEasterEggAt && Date.now() - window._lastEasterEggAt < 1000) return;
        toggleDiscoveryMode(true);
    };
}

// In Discovery, the whole dock is a return target. The play button remains
// the only exception so playback can be controlled without leaving the page.
const discoveryPlayer = document.getElementById('media-player');
const discoveryPlayerShell = document.getElementById('media-player-shell');
const discoveryPlayerInfo = document.getElementById('player-info-layer');
discoveryPlayer?.addEventListener('click', (event) => {
    if (!discoveryPlayerShell?.classList.contains('player-discovery-dock')) return;
    if (event.target.closest('#play-btn')) return;
    toggleDiscoveryMode(false);
});
discoveryPlayerInfo?.addEventListener('keydown', (event) => {
    if (!discoveryPlayerShell?.classList.contains('player-discovery-dock')) return;
    if (event.target.closest('button')) return;
    if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        toggleDiscoveryMode(false);
        document.getElementById('play-btn')?.focus({ preventScroll: true });
    }
});

// ── Library + Home (kệ sách) ────────────────────────────────────────────────
// One snapshot of the user's progress collection feeds three views: the
// mục lục rows in the left column / drawer, Home's list or cover grid, and the
// "Nghe tiếp" card. Filter and sort are shared; each view keeps its own search.
const DISCOVERY_VIEW_STORAGE_KEY = 'cloud-tts-discovery-view';
const LIBRARY_FILTER_KEY = 'cloud-tts-library-filter-v2';
const LIBRARY_SORT_KEY = 'cloud-tts-library-sort';
const LIBRARY_FILTERS = ['listening', 'all', 'done'];
const LIBRARY_SORTS = ['recent', 'title', 'progress'];
const COVER_CONCURRENCY = 3;
const IMAGE_URL_CACHE_LIMIT = 48;
const LIBRARY_TOC_CACHE_LIMIT = 12;
let discoveryLibrary = [];
const BOOK_DELETE_UNDO_MS = TOAST_ACTION_MS;
const pendingBookDeletes = new Map();

function readPref(key, allowed, fallback) {
    try {
        const value = localStorage.getItem(key);
        return allowed.includes(value) ? value : fallback;
    } catch (_) {
        return fallback;
    }
}

function writePref(key, value) {
    try { localStorage.setItem(key, value); } catch (_) { /* private mode */ }
}

const libraryView = {
    status: 'idle',
    filter: readPref(LIBRARY_FILTER_KEY, LIBRARY_FILTERS, 'all'),
    sort: readPref(LIBRARY_SORT_KEY, LIBRARY_SORTS, 'recent'),
    discovery: readPref(DISCOVERY_VIEW_STORAGE_KEY, ['grid', 'list'], window.innerWidth < 768 ? 'list' : 'grid'),
    expanded: { sidebar: null, shelf: null },
    refreshSeq: 0,
    orderFrozen: false,
    manualSync: false,
    syncedAt: 0
};

function byRecency(a, b) {
    return (b.lastListenedAt - a.lastListenedAt) || a.title.localeCompare(b.title, 'vi');
}

function uiLang() {
    try { return localStorage.getItem('ui-lang') === 'vi' ? 'vi' : 'en'; } catch (_) { return 'en'; }
}

function tr(key, fallback, vars = null) {
    const text = window.translations?.[uiLang()]?.[key] ?? fallback ?? key;
    return vars ? text.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? '')) : text;
}

// Picks the "-one" variant of a counted string when n is 1 and that variant exists.
function trCount(key, fallback, n) {
    const oneKey = `${key}-one`;
    const useOne = n === 1 && window.translations?.[uiLang()]?.[oneKey] !== undefined;
    return tr(useOne ? oneKey : key, fallback, { n });
}

window.displayTitle = displayTitle;

function setDisplayTitle(el, text) {
    el.textContent = displayTitle(text);
}

function removeVietnameseTones(str) {
    str = str.normalize('NFD').replace(/[̀-ͯ]/g, "");
    str = str.replace(/[đĐ]/g, m => m === 'đ' ? 'd' : 'D');
    return str;
}

function librarySearchKey(title) {
    const plain = removeVietnameseTones(title.toLowerCase());
    return `${plain} ${plain.replace(/[_-]+/g, ' ')} ${title.toLowerCase()}`;
}

function normalizedQuery(value) {
    return removeVietnameseTones(String(value || '').trim().toLowerCase());
}

function listenedTime(value) {
    if (typeof value === 'number') return value;
    if (typeof value?.toMillis === 'function') return value.toMillis();
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function isBookDone(data) {
    const current = Number(data?.last_read_chunk);
    const total = Number(data?.total_chunks);
    return Number.isFinite(current) && Number.isFinite(total) && total > 0 && current >= total - 1;
}

function escapeHTML(text) {
    return String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// Titles that came from a file name ("Dạ_Hành_Thư_Sinh", "dem-trang-pho-co") read better with spaces.
function prettifyBookTitle(title) {
    let text = String(title || '').trim().replace(/_+/g, ' ');
    if (!/\s/.test(text) && (text.match(/-/g) || []).length >= 2) text = text.replace(/-+/g, ' ');
    return text.replace(/\s+/g, ' ').trim();
}

const CHAPTER_LINE_RE = /^(chương|chuong|chapter|hồi|hoi|quyển|quyen|phần|phan|tập|tap|part|book)\s*[\dIVXLC]+\b/i;

// Best guess for a new book's name: a TXT whose first line is not a chapter heading
// or a sentence usually starts with its title; otherwise use the file name.
async function guessBookTitle(file) {
    const fromName = prettifyBookTitle(String(file?.name || '').replace(/\.[^.]+$/, ''));
    if (!/\.txt$/i.test(file?.name || '')) return fromName;
    try {
        const head = (await file.slice(0, 4096).text()).replace(/^\uFEFF/, '');
        const first = head.split(/\r?\n/).map(line => line.trim()).find(Boolean) || '';
        const looksLikeTitle = first.length >= 2 && first.length <= 80
            && !CHAPTER_LINE_RE.test(first)
            && !/^={3,}$/.test(first)
            && !/[.!?…,;:]$/.test(first);
        return looksLikeTitle ? first : fromName;
    } catch (_) {
        return fromName;
    }
}

function createLibraryEntry(bookId, data) {
    const rawTitle = data.title || data.filename;
    const title = prettifyBookTitle(rawTitle) || rawTitle;
    const done = isBookDone(data);
    return {
        id: bookId,
        data,
        title,
        percent: done ? 100 : getProgressPercent(data),
        done,
        lastListenedAt: listenedTime(data.last_listened_at),
        hasImages: data.has_images === true,
        imagesRev: typeof data.images_rev === 'string' ? data.images_rev : null,
        searchKey: librarySearchKey(rawTitle),
        chapter: null
    };
}

function findLibraryEntry(bookId) {
    return discoveryLibrary.find(entry => entry.id === bookId) || null;
}

function formatPercent(percent) {
    if (percent >= 100) return '100%';
    if (percent <= 0) return '0%';
    return percent < 10 ? `${Math.floor(percent * 10) / 10}%` : `${Math.floor(percent)}%`;
}

const relativeTimeFormats = new Map();
function formatListenedAgo(ms) {
    if (!ms) return tr('not-started', 'chưa nghe');
    const lang = uiLang();
    if (!relativeTimeFormats.has(lang)) {
        relativeTimeFormats.set(lang, new Intl.RelativeTimeFormat(lang, { numeric: 'auto' }));
    }
    const rtf = relativeTimeFormats.get(lang);
    const seconds = (Date.now() - ms) / 1000;
    if (seconds < 60) return tr('just-now', 'vừa xong');
    if (seconds < 3600) return rtf.format(-Math.floor(seconds / 60), 'minute');
    if (seconds < 86400) return rtf.format(-Math.floor(seconds / 3600), 'hour');
    if (seconds < 7 * 86400) return rtf.format(-Math.floor(seconds / 86400), 'day');
    if (seconds < 35 * 86400) return rtf.format(-Math.floor(seconds / (7 * 86400)), 'week');
    return new Date(ms).toLocaleDateString(lang, { day: '2-digit', month: '2-digit', year: '2-digit' });
}

// Chapter cursor for a library row: live state for the open book, otherwise
// the lightweight /toc (titles + sentence counts) fetched when a row expands.
function getLibraryChapter(entry) {
    if (entry.id === STATE.currentBookId && STATE.currentBook?.chapters?.length) {
        const chapters = STATE.currentBook.chapters;
        return {
            index: STATE.currentChapterIndex,
            total: chapters.length,
            titleAt: i => chapters[i]?.title || ''
        };
    }
    const toc = STATE.libraryTocCache.get(entry.id);
    if (!toc) return null;
    const cursor = Math.max(0, Number(entry.data.last_read_chunk) || 0);
    let index = toc.counts.length - 1;
    let seen = 0;
    for (let i = 0; i < toc.counts.length; i++) {
        seen += Number(toc.counts[i]) || 0;
        if (cursor < seen) { index = i; break; }
    }
    return { index: Math.max(0, index), total: toc.titles.length, titleAt: i => toc.titles[i] || '' };
}

// The open book's position moves while it plays; the library snapshot does not.
function entryPercent(entry) {
    if (entry.id !== STATE.currentBookId || !STATE.currentBook || entry.done) return entry.percent;
    const total = getTotalChunks();
    if (!total) return entry.percent;
    const current = getGlobalIndex(STATE.currentChapterIndex, STATE.currentSentenceIndex);
    return Math.max(0, Math.min(100, current / total * 100));
}

function isEntryPlaying(entry) {
    return entry.id === STATE.currentBookId && !!STATE.currentBook && typeof audio !== 'undefined' && !audio.paused;
}

function formatEntryMeta(entry, { withTime = true } = {}) {
    const chapter = getLibraryChapter(entry);
    const parts = [];
    if (chapter) parts.push(`C.${chapter.index + 1}/${chapter.total}`);
    parts.push(formatPercent(entryPercent(entry)));
    if (isEntryPlaying(entry)) parts.push(tr('playing-now', 'đang phát'));
    else if (withTime) parts.push(formatListenedAgo(entry.lastListenedAt));
    return parts.join(' · ');
}

async function fetchLibraryToc(bookId) {
    if (STATE.libraryTocCache.has(bookId)) return STATE.libraryTocCache.get(bookId);
    if (!STATE.user) return null;
    try {
        const response = await authFetch(`/api/stories/${encodeURIComponent(STATE.user.uid)}/${encodeURIComponent(bookId)}/toc`, { timeoutMs: 15_000 });
        if (response.status >= 500) return null;
        const data = response.ok ? await response.json() : null;
        const toc = Array.isArray(data?.titles) && Array.isArray(data?.counts) && data.titles.length
            ? { titles: data.titles, counts: data.counts }
            : null;
        STATE.libraryTocCache.set(bookId, toc);
        while (STATE.libraryTocCache.size > LIBRARY_TOC_CACHE_LIMIT) {
            STATE.libraryTocCache.delete(STATE.libraryTocCache.keys().next().value);
        }
        return toc;
    } catch (err) {
        console.debug('[Library] TOC preview skipped:', bookId, err.message);
        return null;
    }
}

// ── Covers ──────────────────────────────────────────────────────────────────
// Cover = manifest coverId (fallback: first image). Only books with
// has_images === true ask for a manifest; the rest keep the generated text
// cover. Requests start when a cover scrolls near the viewport, at most
// COVER_CONCURRENCY at a time, and reuse STATE.imageURLCache object URLs.
const coverQueue = [];
const coverPending = new Map();
let coverActive = 0;
let coverObserver = null;
// Covers resolved before a library refresh; painted straight away while the
// fresh lookup runs so on-screen covers don't flash back to initials.
let coverPrevious = null;

function titleHue(title) {
    let hash = 0;
    for (const ch of String(title)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    return hash % 360;
}

function titleInitials(title) {
    const words = String(title).replace(/[_\-.]+/g, ' ').split(/\s+/).filter(word => /[\p{L}\p{N}]/u.test(word));
    const letters = words.slice(0, 2).map(word => word.match(/[\p{L}\p{N}]/u)[0]);
    return letters.join('').toLocaleUpperCase('vi') || '·';
}

function createCoverElement(entry, size) {
    const cover = document.createElement('span');
    cover.className = `cover cover--${size} cover--text`;
    cover.setAttribute('aria-hidden', 'true');
    cover.dataset.coverFor = entry.id;
    cover.dataset.coverTitle = entry.title;
    cover.style.setProperty('--cover-h', String(titleHue(entry.title)));
    const initials = document.createElement('span');
    initials.className = 'cover__initials';
    initials.textContent = titleInitials(entry.title);
    cover.append(initials);
    attachCover(cover, entry.id, entry.hasImages);
    return cover;
}

function attachCover(element, bookId, hasImages) {
    if (!hasImages || !STATE.user) return;
    if (STATE.coverResolved.has(bookId)) {
        paintCover(element, STATE.coverResolved.get(bookId));
        return;
    }
    const previous = coverPrevious?.get(bookId);
    if (previous?.url && coverPrevious.liveURLs.has(previous.url)) paintCover(element, previous, { instant: true });
    if (!('IntersectionObserver' in window)) {
        void requestCover(bookId);
        return;
    }
    coverObserver ||= new IntersectionObserver(records => {
        records.forEach(record => {
            if (!record.isIntersecting) return;
            coverObserver.unobserve(record.target);
            void requestCover(record.target.dataset.coverFor);
        });
    }, { rootMargin: '240px 0px' });
    coverObserver.observe(element);
}

function requestCover(bookId) {
    if (!bookId || STATE.coverResolved.has(bookId)) return Promise.resolve(STATE.coverResolved.get(bookId));
    if (coverPending.has(bookId)) return coverPending.get(bookId);
    // Start the manifest lookup now so every cover that comes into view
    // together shares one /covers request; the queue only caps image downloads.
    void loadImageManifest(bookId);
    const pending = new Promise(resolve => {
        coverQueue.push({ bookId, uid: STATE.user?.uid, resolve });
        pumpCoverQueue();
    });
    coverPending.set(bookId, pending);
    return pending;
}

function pumpCoverQueue() {
    while (coverActive < COVER_CONCURRENCY && coverQueue.length) {
        const job = coverQueue.shift();
        coverActive += 1;
        resolveCover(job.bookId)
            .catch(err => {
                console.warn('[Images] Cover hydration warning:', job.bookId, err.message);
                return undefined;
            })
            .then(info => {
                if (STATE.user?.uid !== job.uid) return;
                // undefined = transient failure: leave unresolved so a later render retries.
                if (info !== undefined) STATE.coverResolved.set(job.bookId, info);
                const selector = `[data-cover-for="${CSS.escape(job.bookId)}"]`;
                document.querySelectorAll(selector).forEach(element => paintCover(element, info ?? null));
                if (job.bookId === STATE.currentBookId && info) updateMediaSession();
                job.resolve(info);
            })
            .finally(() => {
                coverActive -= 1;
                coverPending.delete(job.bookId);
                pumpCoverQueue();
            });
    }
}

async function resolveCover(bookId) {
    const manifest = await loadImageManifest(bookId);
    const cover = manifest.images.find(image => image.id === manifest.coverId) || manifest.images[0];
    if (!cover) return manifest._retryable ? undefined : null;
    const url = await getImageURL(bookId, cover, { persist: true });
    if (!url) return undefined;
    return { url, imageId: cover.id, crop: cover.coverCrop || null };
}

function paintCover(element, info, { instant = false } = {}) {
    if (!element) return;
    if (!info) {
        element.querySelector('img.cover__img')?.remove();
        element.dataset.coverStatus = 'empty';
        return;
    }
    let img = element.querySelector('img.cover__img');
    if (!img) {
        img = document.createElement('img');
        img.className = 'cover__img';
        img.alt = '';
        img.decoding = 'async';
        img.draggable = false;
        element.append(img);
    }
    const onLoad = () => {
        applyCoverCrop(img, element, info.crop);
        element.dataset.coverStatus = 'loaded';
    };
    img.onload = onLoad;
    img.onerror = () => {
        element.dataset.coverStatus = 'error';
        img.remove();
    };
    if (img.getAttribute('src') !== info.url) img.src = info.url;
    else if (img.complete && img.naturalWidth) onLoad();
    // Already decoded once (same object URL): show it now, crop follows on load.
    if (instant) element.dataset.coverStatus = 'loaded';
}

// coverCrop is stored normalised (0..1). Show the crop's centre at the box's
// aspect, growing the window when the crop was made for another shape.
function applyCoverCrop(img, box, crop) {
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    const valid = crop && [crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) && crop.width > 0 && crop.height > 0;
    if (!width || !height || !valid) {
        img.removeAttribute('style');
        return;
    }
    const rect = box.getBoundingClientRect();
    const aspect = rect.width > 0 && rect.height > 0 ? rect.width / rect.height : 5 / 7;
    let viewW = Math.max(crop.width * width, crop.height * height * aspect);
    let viewH = viewW / aspect;
    if (viewW > width) { viewW = width; viewH = viewW / aspect; }
    if (viewH > height) { viewH = height; viewW = viewH * aspect; }
    const centerX = (crop.x + crop.width / 2) * width;
    const centerY = (crop.y + crop.height / 2) * height;
    const left = Math.min(Math.max(centerX - viewW / 2, 0), Math.max(0, width - viewW));
    const top = Math.min(Math.max(centerY - viewH / 2, 0), Math.max(0, height - viewH));
    img.style.inset = 'auto';
    img.style.maxWidth = 'none';
    img.style.objectFit = 'fill';
    img.style.width = `${width / viewW * 100}%`;
    img.style.height = `${height / viewH * 100}%`;
    img.style.left = `${-left / viewW * 100}%`;
    img.style.top = `${-top / viewH * 100}%`;
}

// Object URLs leave the cache through these helpers so they are revoked.
function rememberImageURL(imageId, url) {
    STATE.imageURLCache.set(imageId, url);
    trimImageURLCache();
}

function coverURLsInUse() {
    const urls = new Set();
    STATE.coverResolved.forEach(info => { if (info?.url) urls.add(info.url); });
    return urls;
}

function trimImageURLCache() {
    if (STATE.imageURLCache.size <= IMAGE_URL_CACHE_LIMIT) return;
    const keep = coverURLsInUse();
    for (const [imageId, url] of STATE.imageURLCache) {
        if (STATE.imageURLCache.size <= IMAGE_URL_CACHE_LIMIT) break;
        if (keep.has(url)) continue;
        URL.revokeObjectURL(url);
        STATE.imageURLCache.delete(imageId);
    }
}

function releaseImageURL(imageId) {
    const url = STATE.imageURLCache.get(imageId);
    if (!url) return;
    STATE.imageURLCache.delete(imageId);
    STATE.coverResolved.forEach((info, bookId) => {
        if (info?.url === url) STATE.coverResolved.delete(bookId);
    });
    URL.revokeObjectURL(url);
}

// Drop every cached image except covers that are on screen right now.
function releaseImageURLs() {
    const keep = coverURLsInUse();
    for (const [imageId, url] of [...STATE.imageURLCache]) {
        if (keep.has(url)) continue;
        URL.revokeObjectURL(url);
        STATE.imageURLCache.delete(imageId);
    }
}

function paintPlayerArt() {
    const art = document.getElementById('player-art');
    if (!art) return;
    const bookId = STATE.currentBook ? STATE.currentBookId : null;
    if (art.dataset.coverFor !== (bookId || '')) {
        art.querySelector('img.cover__img')?.remove();
        delete art.dataset.coverStatus;
        art.dataset.coverFor = bookId || '';
    }
    if (!bookId) return;
    if (STATE.coverResolved.has(bookId)) {
        paintCover(art, STATE.coverResolved.get(bookId));
        return;
    }
    const entry = findLibraryEntry(bookId);
    if (entry?.hasImages || STATE.imageManifest?.images?.length) void requestCover(bookId);
}

// ── Rows and cards ──────────────────────────────────────────────────────────
let libraryRowSeq = 0;

function iconSVG(name, extraClass = '') {
    return `<svg class="ic ${extraClass}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

function buildProgressRing(entry) {
    const ring = document.createElement('button');
    ring.type = 'button';
    ring.className = 'prog-ring';
    ring.dataset.action = 'play';
    const pct = Math.round(entry.percent * 10) / 10;
    ring.innerHTML = `<svg class="ring__svg" viewBox="0 0 30 30" aria-hidden="true"><circle class="ring__track" cx="15" cy="15" r="12.5"/><circle class="ring__fill" cx="15" cy="15" r="12.5" pathLength="100" stroke-dasharray="${pct} 100"${pct > 0 ? '' : ' data-empty=""'}/></svg>${iconSVG('play', 'ring__play')}${iconSVG('pause', 'ring__pause')}`;
    return ring;
}

function buildLibraryRow(entry, listName) {
    const row = document.createElement('li');
    row.className = 'lib-row';
    row.dataset.bookId = entry.id;
    row.dataset.list = listName;

    const head = document.createElement('div');
    head.className = 'lib-row__head';
    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'lib-row__main';
    main.dataset.action = 'toggle';
    main.setAttribute('aria-expanded', 'false');
    const panelId = `lib-row-x-${++libraryRowSeq}`;
    main.setAttribute('aria-controls', panelId);
    const text = document.createElement('span');
    text.className = 'lib-row__text';
    const title = document.createElement('span');
    title.className = 'lib-row__title';
    setDisplayTitle(title, entry.title);
    const meta = document.createElement('span');
    meta.className = 'lib-row__meta';
    meta.textContent = formatEntryMeta(entry);
    text.append(title, meta);
    main.append(createCoverElement(entry, 'thumb'), text);
    head.append(main, buildProgressRing(entry), buildMoreButton(entry, 'lib-row__more'));

    const details = document.createElement('div');
    details.className = 'lib-row__x';
    details.id = panelId;
    details.hidden = true;
    row.append(head, details);
    return row;
}

function buildShelfCard(entry) {
    const card = document.createElement('li');
    card.className = 'shelf-card';
    card.dataset.bookId = entry.id;
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'shelf-card__open';
    open.dataset.action = 'open';
    const bar = document.createElement('span');
    bar.className = 'shelf-card__bar';
    bar.setAttribute('aria-hidden', 'true');
    const fill = document.createElement('span');
    fill.style.width = `${entry.percent}%`;
    bar.append(fill);
    const title = document.createElement('span');
    title.className = 'shelf-card__title';
    setDisplayTitle(title, entry.title);
    const meta = document.createElement('span');
    meta.className = 'shelf-card__meta';
    meta.textContent = formatEntryMeta(entry, { withTime: false });
    open.append(createCoverElement(entry, 'grid'), bar, title, meta);
    card.append(open, buildMoreButton(entry, 'shelf-card__more'));
    return card;
}

function buildMoreButton(entry, className) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = `icon-btn ${className}`;
    more.dataset.action = 'more';
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    more.setAttribute('aria-label', tr('book-options', 'Tuỳ chọn cho {title}', { title: displayTitle(entry.title) }));
    more.title = tr('book-options-hint', 'Tuỳ chọn (hoặc chuột phải / nhấn giữ)');
    more.innerHTML = iconSVG('dots');
    return more;
}

function buildChapterStrip(entry) {
    const strip = document.createElement('div');
    strip.className = 'strip';
    const chapter = getLibraryChapter(entry);
    if (!chapter) {
        strip.dataset.state = 'loading';
        strip.setAttribute('aria-hidden', 'true');
        ['prev', 'now', 'next'].forEach(kind => {
            const cell = document.createElement('div');
            cell.className = `strip__cell strip__cell--${kind}`;
            cell.innerHTML = '<span class="strip__n">—</span><span class="strip__c">…</span>';
            strip.append(cell);
        });
        return strip;
    }
    strip.setAttribute('aria-label', tr('chapter-strip', 'Chương đang nghe'));
    const cells = [
        { kind: 'prev', index: chapter.index - 1, empty: tr('strip-first', 'Đầu truyện') },
        { kind: 'now', index: chapter.index, empty: '' },
        { kind: 'next', index: chapter.index + 1, empty: tr('strip-last', 'Hết truyện') }
    ];
    cells.forEach(({ kind, index, empty }) => {
        const cell = document.createElement('div');
        cell.className = `strip__cell strip__cell--${kind}`;
        const exists = index >= 0 && index < chapter.total;
        const number = document.createElement('span');
        number.className = 'strip__n';
        number.textContent = exists
            ? `C.${index + 1}${kind === 'now' ? ` · ${tr('strip-now', 'đang nghe')}` : ''}`
            : '—';
        const name = document.createElement('span');
        name.className = 'strip__c';
        name.textContent = exists ? (chapter.titleAt(index) || `${tr('chapter-word', 'Chương')} ${index + 1}`) : empty;
        cell.append(number, name);
        strip.append(cell);
    });
    return strip;
}

function buildRowActions(entry) {
    const actions = document.createElement('div');
    actions.className = 'lib-row__acts';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'btn';
    open.dataset.action = 'open';
    open.textContent = tr('open-reader', 'Mở trang đọc');
    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'btn btn--primary';
    play.dataset.action = 'play';
    play.dataset.role = 'listen';
    actions.append(open, play);
    return actions;
}

function setRowExpanded(row, expanded) {
    const main = row.querySelector('.lib-row__main');
    const details = row.querySelector('.lib-row__x');
    const entry = findLibraryEntry(row.dataset.bookId);
    if (!main || !details || !entry) return;
    main.setAttribute('aria-expanded', String(expanded));
    details.hidden = !expanded;
    if (!expanded) {
        details.replaceChildren();
        return;
    }
    details.replaceChildren(buildChapterStrip(entry), buildRowActions(entry));
    syncLibraryItemState(row, entry);
    if (!getLibraryChapter(entry)) {
        void fetchLibraryToc(entry.id).then(toc => {
            if (!row.isConnected || details.hidden) return;
            if (!toc) {
                details.querySelector('.strip')?.setAttribute('hidden', '');
                return;
            }
            details.querySelector('.strip')?.replaceWith(buildChapterStrip(entry));
            document.querySelectorAll(`[data-book-id="${CSS.escape(entry.id)}"] .lib-row__meta, [data-book-id="${CSS.escape(entry.id)}"] .shelf-card__meta`)
                .forEach(meta => { meta.textContent = formatEntryMeta(entry, { withTime: !meta.classList.contains('shelf-card__meta') }); });
        });
    }
}

function toggleLibraryRow(row) {
    const listName = row.dataset.list;
    const willExpand = row.querySelector('.lib-row__main')?.getAttribute('aria-expanded') !== 'true';
    row.parentElement?.querySelectorAll(':scope > .lib-row').forEach(other => {
        if (other !== row && other.querySelector('.lib-row__main')?.getAttribute('aria-expanded') === 'true') {
            setRowExpanded(other, false);
        }
    });
    setRowExpanded(row, willExpand);
    libraryView.expanded[listName] = willExpand ? row.dataset.bookId : null;
}

// ── Rendering, filter, sort ─────────────────────────────────────────────────
function sortedLibraryEntries() {
    const entries = [...discoveryLibrary];
    if (libraryView.sort === 'title') {
        entries.sort((a, b) => a.title.localeCompare(b.title, 'vi'));
    } else if (libraryView.sort === 'progress') {
        entries.sort((a, b) => (b.percent - a.percent) || (b.lastListenedAt - a.lastListenedAt));
    }
    return entries;
}

function entryPassesFilter(entry) {
    if (libraryView.filter === 'all') return true;
    if (libraryView.filter === 'done') return entry.done;
    // "Đang nghe" = started and not finished; the open book always counts.
    return !entry.done && (entry.lastListenedAt > 0 || entry.percent > 0 || entry.id === STATE.currentBookId);
}

function renderLibraryViews() {
    closeBookMenu();
    coverObserver?.disconnect();
    const bookListEl = document.getElementById('book-list');
    const shelfEl = document.getElementById('discovery-grid');
    const entries = sortedLibraryEntries();
    if (bookListEl) {
        bookListEl.replaceChildren(...entries.map(entry => buildLibraryRow(entry, 'sidebar')));
        bookListEl.setAttribute('aria-busy', String(libraryView.status === 'loading'));
    }
    if (shelfEl) {
        const isGrid = libraryView.discovery === 'grid';
        shelfEl.className = `shelf-list ${isGrid ? 'shelf-list--grid' : 'shelf-list--rows'}`;
        shelfEl.replaceChildren(...entries.map(entry => isGrid ? buildShelfCard(entry) : buildLibraryRow(entry, 'shelf')));
        shelfEl.setAttribute('aria-busy', String(libraryView.status === 'loading'));
    }
    [['sidebar', bookListEl], ['shelf', shelfEl]].forEach(([listName, listEl]) => {
        const expandedId = libraryView.expanded[listName];
        if (!expandedId || !listEl) return;
        const row = listEl.querySelector(`:scope > .lib-row[data-book-id="${CSS.escape(expandedId)}"]`);
        if (row) setRowExpanded(row, true);
        else libraryView.expanded[listName] = null;
    });
    syncLibraryControls();
    applyLibraryFilters();
    updateLibraryHighlight();
}

function syncLibraryControls() {
    document.querySelectorAll('[data-lib-filter] [data-filter]').forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.filter === libraryView.filter));
        button.disabled = libraryView.status === 'signed-out';
    });
    const sort = document.getElementById('discovery-sort');
    if (sort) {
        sort.value = libraryView.sort;
        sort.disabled = libraryView.status === 'signed-out';
    }
    const isList = libraryView.discovery === 'list';
    document.getElementById('discovery-grid-view')?.setAttribute('aria-pressed', String(!isList));
    document.getElementById('discovery-list-view')?.setAttribute('aria-pressed', String(isList));
}

function libraryEmptyState(query, rawQuery, visible) {
    if (libraryView.status === 'signed-out') {
        return { text: tr('library-signed-out', 'Đăng nhập để thấy thư viện và vị trí đang nghe trên mọi máy.'), action: 'sign-in', label: tr('sign-in-google', 'Đăng nhập Google') };
    }
    if (libraryView.status === 'loading' && !discoveryLibrary.length) {
        return { text: tr('library-loading', 'Đang tải thư viện…') };
    }
    if (libraryView.status === 'error') {
        return { text: tr('library-error', 'Không tải được thư viện.'), action: 'retry', label: tr('retry', 'Thử lại') };
    }
    if (libraryView.status === 'ready' && !discoveryLibrary.length) {
        return { text: tr('library-empty', 'Chưa có truyện nào. Thêm file .txt, .epub hoặc .pdf để bắt đầu.'), action: 'add', label: tr('add-book', 'Thêm truyện') };
    }
    if (visible > 0 || libraryView.status !== 'ready') return null;
    if (query) {
        const filterName = tr(`filter-${libraryView.filter}`, libraryView.filter);
        return { text: tr('search-no-match-in', 'Không có truyện nào khớp “{query}” trong {filter}.', { query: rawQuery, filter: filterName }), action: 'clear-search', label: tr('clear-search', 'Xoá tìm kiếm') };
    }
    const key = libraryView.filter === 'done' ? 'filter-empty-done' : 'filter-empty-listening';
    const fallback = libraryView.filter === 'done' ? 'Chưa có truyện nào nghe xong.' : 'Không có truyện đang nghe.';
    return { text: tr(key, fallback), action: 'show-all', label: tr('show-all', 'Xem tất cả') };
}

function setLibraryEmpty(boxId, textId, buttonId, state, scope) {
    const box = document.getElementById(boxId);
    const text = document.getElementById(textId);
    const button = document.getElementById(buttonId);
    if (!box) return;
    box.hidden = !state;
    if (!state) return;
    if (text) text.textContent = state.text;
    if (button) {
        button.hidden = !state.action;
        button.textContent = state.label || '';
        button.dataset.emptyAction = state.action || '';
        button.dataset.scope = scope;
    }
}

function filterLibraryList(listEl, rawQuery) {
    const query = normalizedQuery(rawQuery);
    let visible = 0;
    listEl?.querySelectorAll(':scope > [data-book-id]').forEach(item => {
        const entry = findLibraryEntry(item.dataset.bookId);
        const show = !!entry && entryPassesFilter(entry) && (!query || entry.searchKey.includes(query));
        item.hidden = !show;
        if (show) visible += 1;
    });
    return { query, visible };
}

function applyLibraryFilters() {
    const librarySearch = document.getElementById('library-search');
    const shelfSearch = document.getElementById('discovery-search');
    const sidebar = filterLibraryList(document.getElementById('book-list'), librarySearch?.value);
    const shelf = filterLibraryList(document.getElementById('discovery-grid'), shelfSearch?.value);
    const libraryClear = document.getElementById('library-clear-search');
    const shelfClear = document.getElementById('discovery-search-clear');
    if (libraryClear) libraryClear.hidden = !librarySearch?.value;
    if (shelfClear) shelfClear.hidden = !shelfSearch?.value;
    setLibraryEmpty('library-empty', 'library-empty-text', 'library-empty-btn',
        libraryEmptyState(sidebar.query, librarySearch?.value.trim(), sidebar.visible), 'sidebar');
    // An empty library gets Home's own empty state; a re-sync keeps it instead of flashing the tools.
    const discovery = document.getElementById('discovery-mode');
    const libraryEmpty = !discoveryLibrary.length && (libraryView.status === 'ready'
        || (libraryView.status === 'loading' && !!discovery?.hasAttribute('data-library-empty')));
    discovery?.toggleAttribute('data-library-empty', libraryEmpty);
    const shelfEmpty = document.getElementById('shelf-empty');
    if (shelfEmpty) shelfEmpty.hidden = !libraryEmpty;
    setLibraryEmpty('discovery-search-empty', 'discovery-search-empty-text', 'discovery-clear-search',
        libraryEmpty ? null : libraryEmptyState(shelf.query, shelfSearch?.value.trim(), shelf.visible), 'shelf');
    // A re-sync keeps the old list on screen; say so while it runs.
    const syncing = (libraryView.status === 'loading' || libraryView.manualSync) && discoveryLibrary.length > 0;
    const syncHint = document.getElementById('library-sync-hint');
    if (syncHint) syncHint.hidden = !syncing;
    const count = document.getElementById('discovery-result-count');
    if (count) {
        count.textContent = syncing
            ? tr('library-syncing', 'Đang đồng bộ…')
            : libraryView.status === 'ready' && discoveryLibrary.length
                ? (shelf.visible === discoveryLibrary.length
                    ? trCount('shelf-count-all', '{n} truyện', discoveryLibrary.length)
                    : tr('shelf-count', '{shown}/{total} truyện', { shown: shelf.visible, total: discoveryLibrary.length }))
                : '';
    }
}

// Kept for existing callers.
const applyDiscoverySearch = applyLibraryFilters;
const applyLibrarySearch = applyLibraryFilters;

function setLibraryFilter(filter) {
    if (!LIBRARY_FILTERS.includes(filter)) return;
    libraryView.filter = filter;
    writePref(LIBRARY_FILTER_KEY, filter);
    syncLibraryControls();
    applyLibraryFilters();
}

function setLibrarySort(sort) {
    if (!LIBRARY_SORTS.includes(sort)) return;
    libraryView.sort = sort;
    writePref(LIBRARY_SORT_KEY, sort);
    renderLibraryViews();
}

function setDiscoveryView(view, persist = true) {
    const focused = document.activeElement;
    libraryView.discovery = view === 'list' ? 'list' : 'grid';
    if (persist) writePref(DISCOVERY_VIEW_STORAGE_KEY, libraryView.discovery);
    renderLibraryViews();
    // Below 900px only the button for the other view shows; keep focus on the one left visible.
    if (focused?.closest('.seg--icons') && !focused.offsetParent) {
        document.querySelector('.seg--icons > [aria-pressed="false"]')?.focus();
    }
}

// ── Current book: highlight, ring state, "Nghe tiếp" ───────────────────────
function syncLibraryItemState(item, entry) {
    const isCurrent = item.dataset.bookId === STATE.currentBookId && !!STATE.currentBook;
    const isPlaying = isCurrent && typeof audio !== 'undefined' && !audio.paused;
    if (isCurrent) item.setAttribute('aria-current', 'true');
    else item.removeAttribute('aria-current');
    const vars = { title: displayTitle(entry.title), percent: formatPercent(entryPercent(entry)) };
    item.querySelectorAll('.prog-ring').forEach(ring => {
        ring.setAttribute('aria-pressed', String(isPlaying));
        ring.setAttribute('aria-label', isPlaying
            ? tr('pause-book', 'Tạm dừng {title}', vars)
            : tr('play-book', 'Nghe {title}, đã {percent}', vars));
    });
    const listen = item.querySelector('[data-role="listen"]');
    if (listen) {
        listen.innerHTML = `${iconSVG(isPlaying ? 'pause' : 'play', 'ic--sm')}<span>${isPlaying ? tr('pause', 'Tạm dừng') : tr('listen', 'Nghe')}</span>`;
    }
    item.querySelectorAll('.lib-row__meta, .shelf-card__meta').forEach(meta => {
        meta.textContent = formatEntryMeta(entry, { withTime: !meta.classList.contains('shelf-card__meta') });
    });
    if (isCurrent) {
        const pct = entryPercent(entry);
        item.querySelectorAll('.shelf-card__bar > span').forEach(fill => { fill.style.width = `${pct}%`; });
        item.querySelectorAll('.ring__fill').forEach(fill => {
            const rounded = Math.round(pct * 10) / 10;
            fill.setAttribute('stroke-dasharray', `${rounded} 100`);
            fill.toggleAttribute('data-empty', !(rounded > 0));
        });
    }
}

function updateLibraryHighlight() {
    document.querySelectorAll('#book-list > [data-book-id], #discovery-grid > [data-book-id]').forEach(item => {
        const entry = findLibraryEntry(item.dataset.bookId);
        if (entry) syncLibraryItemState(item, entry);
    });
    updateDiscoveryContinueCard();
    paintPlayerArt();
}

function getResumeTarget() {
    const current = STATE.currentBook ? findLibraryEntry(STATE.currentBookId) : null;
    if (current) return { entry: current, isOpen: true };
    const recent = discoveryLibrary
        .filter(entry => entry.lastListenedAt > 0 && !entry.done)
        .sort((a, b) => b.lastListenedAt - a.lastListenedAt)[0];
    return recent ? { entry: recent, isOpen: false } : null;
}

function updateDiscoveryContinueCard() {
    const card = document.getElementById('discovery-continue-card');
    const title = document.getElementById('discovery-continue-title');
    const meta = document.getElementById('discovery-continue-meta');
    const progress = document.getElementById('discovery-continue-progress');
    const label = document.getElementById('discovery-continue-label');
    if (!card || !title || !meta || !progress) return;
    const target = getResumeTarget();
    card.hidden = !target;
    if (!target) return;
    const { entry, isOpen } = target;
    const isPlaying = isOpen && typeof audio !== 'undefined' && !audio.paused;
    setDisplayTitle(title, entry.title);
    meta.textContent = formatEntryMeta(entry);
    progress.style.width = `${entryPercent(entry)}%`;
    if (label) {
        label.textContent = isPlaying
            ? tr('now-playing', 'Đang phát')
            : (isOpen
                ? tr('resume-paused', 'Tạm dừng · nghe tiếp từ C.{n}', { n: STATE.currentChapterIndex + 1 })
                : tr('resume-last', 'Nghe gần nhất'));
    }
    card.dataset.bookId = entry.id;
    // Same control as the dock and the library row: pause while this book is playing.
    const btn = document.getElementById('discovery-continue-btn');
    btn?.querySelector('use')?.setAttribute('href', isPlaying ? '#i-pause' : '#i-play');
    const btnLabel = btn?.querySelector('[data-i18n]');
    if (btnLabel) {
        btnLabel.dataset.i18n = isPlaying ? 'pause' : 'continue-listening';
        btnLabel.textContent = isPlaying ? tr('pause', 'Pause') : tr('continue-listening', 'Nghe tiếp');
    }
    const oldCover = document.getElementById('discovery-continue-cover');
    if (oldCover?.dataset.coverFor !== entry.id || oldCover.dataset.coverTitle !== entry.title) {
        const cover = createCoverElement(entry, 'resume');
        cover.id = 'discovery-continue-cover';
        oldCover?.replaceWith(cover);
    }
}

function handleContinueListening(event) {
    event?.stopPropagation?.();
    const target = getResumeTarget();
    if (!target) return;
    if (target.isOpen && !audio.paused && event?.currentTarget?.id === 'discovery-continue-btn') {
        void togglePlayback();
        return;
    }
    if (target.isOpen) {
        if (!audio.paused) {
            toggleDiscoveryMode(false);
            return;
        }
        // Stay on Home when another tab or device holds playback; the strip above the console offers "Nghe ở đây".
        STATE.playIntentAt = Date.now();
        void waitForWebSocket().then(connected => {
            if (!connected) {
                document.getElementById('status-indicator').innerText = connectionFailedStatus();
                return;
            }
            toggleDiscoveryMode(false);
            void togglePlayback();
        });
        return;
    }
    void loadBookFromStorage(target.entry.id, target.entry.data);
}

function openLibraryBook(entry) {
    if (entry.id === STATE.currentBookId && STATE.currentBook) {
        toggleSidebar(false);
        toggleDiscoveryMode(false);
        return;
    }
    void loadBookFromStorage(entry.id, entry.data);
}

function playLibraryBook(entry, trigger) {
    if (entry.id === STATE.currentBookId && STATE.currentBook) {
        void togglePlayback();
        return;
    }
    trigger?.setAttribute('aria-busy', 'true');
    void loadBookFromStorage(entry.id, entry.data).finally(() => trigger?.removeAttribute('aria-busy'));
}

async function renameLibraryBook(entry, trigger) {
    if (entry.id === STATE.currentBookId && STATE.currentBook) {
        await editTitle();
        returnFocusTo(trigger);
        return;
    }
    if (!STATE.user) return;
    const newTitle = await askBookTitle(entry.title);
    if (!newTitle || newTitle === entry.title) return;
    try {
        await setDoc(doc(db, 'users', STATE.user.uid, 'progress', entry.id), { title: newTitle }, { merge: true });
        await refreshLibrary();
        returnFocusTo(trigger);
        APP_STATUS.toast(tr('rename-done', 'Đã đổi tên truyện.'), 'success');
    } catch (err) {
        console.error('[Title] Rename failed:', err);
        APP_STATUS.error(tr('rename-failed', 'Không thể lưu tên truyện: {reason}', { reason: err.message }));
    }
}

// ── Shared per-book menu (anchored popover; bottom sheet under 640px) ───────
const bookMenu = { entry: null, trigger: null };
let mergeTarget = null;

function bookMenuItems() {
    return [...document.querySelectorAll('#book-menu [role="menuitem"]:not(:disabled)')];
}

function onBookMenuOutside(event) {
    const menu = document.getElementById('book-menu');
    if (menu?.contains(event.target) || bookMenu.trigger?.contains(event.target)) return;
    closeBookMenu();
}

function onBookMenuKey(event) {
    const items = bookMenuItems();
    const index = items.indexOf(document.activeElement);
    if (event.key === 'Escape') {
        event.preventDefault();
        closeBookMenu({ restoreFocus: true });
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        items[(index + step + items.length) % items.length]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        items[event.key === 'Home' ? 0 : items.length - 1]?.focus();
    } else if (event.key === 'Tab') {
        // The menu lives at the end of <body>; continue the Tab order from the row's ⋮.
        event.preventDefault();
        const trigger = bookMenu.trigger;
        closeBookMenu({ restoreFocus: true });
        if (!event.shiftKey && trigger?.isConnected) focusNextAfter(trigger);
    }
}

function focusNextAfter(el) {
    const focusables = [...document.querySelectorAll('a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
        .filter(node => node.tabIndex >= 0 && node.getClientRects().length && !node.closest('[hidden], .hidden, [inert]'));
    const index = focusables.indexOf(el);
    focusables[index + 1]?.focus();
}

// After a row disappears, keep keyboard focus in the same list (neighbouring
// row's same control), or on the list's search field when the list is empty.
function snapshotLibraryFocus() {
    const control = document.activeElement?.closest?.('[data-action]');
    const list = control?.closest('#book-list, #discovery-grid');
    if (!list) return null;
    const item = control.closest('[data-book-id]');
    return { listId: list.id, action: control.dataset.action, index: [...list.querySelectorAll('[data-book-id]')].indexOf(item) };
}

function restoreLibraryFocus(snapshot) {
    if (!snapshot) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const list = document.getElementById(snapshot.listId);
    const controls = [...(list?.querySelectorAll(`[data-book-id] [data-action="${snapshot.action}"]`) || [])];
    const target = controls[Math.min(snapshot.index, controls.length - 1)]
        || document.getElementById(snapshot.listId === 'book-list' ? 'library-search' : 'discovery-search');
    target?.focus({ preventScroll: true });
}

function onBookMenuViewportChange() {
    closeBookMenu();
}

function openBookMenu(entry, trigger, at = null) {
    const menu = document.getElementById('book-menu');
    const scrim = document.getElementById('book-menu-scrim');
    if (!menu) return;
    if (bookMenu.entry?.id === entry.id && bookMenu.trigger === trigger && !menu.hidden) {
        closeBookMenu({ restoreFocus: true });
        return;
    }
    closeBookMenu();
    bookMenu.entry = entry;
    bookMenu.trigger = trigger;
    const listId = trigger.closest('#book-list, #discovery-grid')?.id;
    if (listId) libraryTriggerHome.set(trigger, { listId, bookId: entry.id, action: trigger.dataset.action });
    const title = document.getElementById('book-menu-title');
    if (title) setDisplayTitle(title, entry.title);
    const isSheet = window.matchMedia('(max-width: 639.98px)').matches;
    menu.style.left = '';
    menu.style.top = '';
    menu.hidden = false;
    if (scrim) scrim.hidden = !isSheet;
    if (!isSheet) {
        const rect = at ? { left: at.x, right: at.x, top: at.y, bottom: at.y } : trigger.getBoundingClientRect();
        const width = menu.offsetWidth;
        const height = menu.offsetHeight;
        const left = Math.min(Math.max(8, at ? rect.left : rect.right - width), window.innerWidth - width - 8);
        let top = rect.bottom + (at ? 2 : 6);
        if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
    }
    trigger.setAttribute('aria-expanded', 'true');
    openLayer('book-menu', () => closeBookMenu({ restoreFocus: true }));
    document.addEventListener('pointerdown', onBookMenuOutside, true);
    menu.addEventListener('keydown', onBookMenuKey);
    window.addEventListener('resize', onBookMenuViewportChange);
    document.getElementById('book-list')?.addEventListener('scroll', onBookMenuViewportChange, { passive: true });
    document.getElementById('discovery-mode')?.addEventListener('scroll', onBookMenuViewportChange, { passive: true });
    bookMenuItems()[0]?.focus();
}

function closeBookMenu({ restoreFocus = false } = {}) {
    const menu = document.getElementById('book-menu');
    const scrim = document.getElementById('book-menu-scrim');
    if (!menu || menu.hidden) return;
    closeLayer('book-menu');
    menu.hidden = true;
    if (scrim) scrim.hidden = true;
    document.removeEventListener('pointerdown', onBookMenuOutside, true);
    menu.removeEventListener('keydown', onBookMenuKey);
    window.removeEventListener('resize', onBookMenuViewportChange);
    document.getElementById('book-list')?.removeEventListener('scroll', onBookMenuViewportChange);
    document.getElementById('discovery-mode')?.removeEventListener('scroll', onBookMenuViewportChange);
    const trigger = bookMenu.trigger;
    trigger?.setAttribute('aria-expanded', 'false');
    bookMenu.trigger = null;
    if (restoreFocus && trigger?.isConnected) trigger.focus();
}

function runBookAction(action, entry) {
    const trigger = bookMenu.trigger;
    // Dialogs opened from the menu remember the focused element, so give the
    // focus back to the row's ⋮ before opening them.
    closeBookMenu({ restoreFocus: action !== 'open' });
    if (!entry) return;
    switch (action) {
        case 'open': openLibraryBook(entry); break;
        case 'rename': void renameLibraryBook(entry, trigger); break;
        case 'images': void openImageManager(entry.id, entry.title); break;
        case 'merge': {
            const input = document.getElementById('merge-input');
            if (!input) return;
            mergeTarget = entry;
            input.value = '';
            input.click();
            break;
        }
        case 'export': void downloadTextBook(entry.id, entry.title); break;
        case 'delete': {
            const neighbourFocus = rowNeighbourFocus(trigger, entry.id);
            void deleteBook(entry.id, entry.data.filename, entry.title).then(() => {
                if (findLibraryEntry(entry.id)) return;
                const target = neighbourFocus();
                const active = document.activeElement;
                if (target && (!active || active === document.body)) target.focus({ preventScroll: true });
            });
            break;
        }
        default: break;
    }
}

// The deleted row is gone after the refresh; land on the row that took its place (or the one above, or the search box).
function rowNeighbourFocus(trigger, bookId) {
    const list = trigger?.closest('#book-list, #discovery-grid');
    const row = list?.querySelector(`[data-book-id="${CSS.escape(bookId)}"]`);
    const ids = [row?.nextElementSibling?.dataset.bookId, row?.previousElementSibling?.dataset.bookId].filter(Boolean);
    const searchId = list?.id === 'discovery-grid' ? 'discovery-search' : 'library-search';
    return () => {
        for (const id of ids) {
            const control = list?.querySelector(`[data-book-id="${CSS.escape(id)}"] :is([data-action="toggle"], [data-action="open"])`);
            if (control) return control;
        }
        return document.getElementById(searchId);
    };
}

// Earlier per-row menus were closed through this name.
function closeAllKebabMenus() {
    closeBookMenu();
}

document.getElementById('book-menu')?.addEventListener('click', event => {
    const item = event.target.closest('[data-book-action]');
    if (item) runBookAction(item.dataset.bookAction, bookMenu.entry);
});
document.getElementById('book-menu-scrim')?.addEventListener('click', () => closeBookMenu());
document.getElementById('merge-input')?.addEventListener('change', event => {
    if (mergeTarget) void mergeChapterFile(event, mergeTarget.id, mergeTarget.data);
});

function onLibraryListClick(event) {
    const control = event.target.closest('[data-action]');
    if (!control || !event.currentTarget.contains(control)) return;
    const item = control.closest('[data-book-id]');
    const entry = findLibraryEntry(item?.dataset.bookId);
    if (!entry) return;
    switch (control.dataset.action) {
        case 'toggle': toggleLibraryRow(item); break;
        case 'play': playLibraryBook(entry, control); break;
        case 'open': openLibraryBook(entry); break;
        case 'more': openBookMenu(entry, control); break;
        default: break;
    }
}

document.getElementById('book-list')?.addEventListener('click', onLibraryListClick);
document.getElementById('discovery-grid')?.addEventListener('click', onLibraryListClick);

// Right-click a book (mouse) or press and hold it (touch) for the same menu as its ⋮.
const LONG_PRESS_MS = 520;
let bookPress = null;
let suppressBookClickUntil = 0;

function openBookMenuAt(item, at) {
    const entry = findLibraryEntry(item?.dataset.bookId);
    const trigger = item?.querySelector('[data-action="more"]');
    if (!entry || !trigger) return false;
    if (bookMenu.entry?.id === entry.id && !document.getElementById('book-menu')?.hidden) closeBookMenu();
    openBookMenu(entry, trigger, at);
    return true;
}

function onLibraryContextMenu(event) {
    const item = event.target.closest('[data-book-id]');
    if (!item || !event.currentTarget.contains(item)) return;
    if (Date.now() < suppressBookClickUntil) { event.preventDefault(); return; }
    if (openBookMenuAt(item, { x: event.clientX, y: event.clientY })) event.preventDefault();
}

function onLibraryPointerDown(event) {
    if (event.pointerType !== 'touch') return;
    const item = event.target.closest('[data-book-id]');
    if (!item || event.target.closest('[data-action="more"]')) return;
    const start = { x: event.clientX, y: event.clientY };
    clearTimeout(bookPress?.timer);
    bookPress = {
        start,
        timer: setTimeout(() => {
            bookPress = null;
            if (openBookMenuAt(item, start)) {
                suppressBookClickUntil = Date.now() + 700;
                AudioHapticFX.haptic(15);
            }
        }, LONG_PRESS_MS)
    };
}

function cancelBookPress(event) {
    if (!bookPress) return;
    if (event?.type === 'pointermove' && Math.hypot(event.clientX - bookPress.start.x, event.clientY - bookPress.start.y) < 10) return;
    clearTimeout(bookPress.timer);
    bookPress = null;
}

['book-list', 'discovery-grid'].forEach(id => {
    const list = document.getElementById(id);
    if (!list) return;
    list.addEventListener('contextmenu', onLibraryContextMenu);
    list.addEventListener('pointerdown', onLibraryPointerDown);
    ['pointermove', 'pointerup', 'pointercancel', 'scroll'].forEach(type => list.addEventListener(type, cancelBookPress, { passive: true }));
    // The click that ends a long-press must not also open or toggle the row.
    list.addEventListener('click', event => {
        if (Date.now() < suppressBookClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
});
document.querySelectorAll('[data-lib-filter]').forEach(group => group.addEventListener('click', event => {
    const button = event.target.closest('[data-filter]');
    if (button && !button.disabled) setLibraryFilter(button.dataset.filter);
}));
document.getElementById('discovery-sort')?.addEventListener('change', event => setLibrarySort(event.target.value));
document.getElementById('discovery-grid-view')?.addEventListener('click', () => setDiscoveryView('grid'));
document.getElementById('discovery-list-view')?.addEventListener('click', () => setDiscoveryView('list'));

const librarySearchInput = document.getElementById('library-search');
const discoverySearch = document.getElementById('discovery-search');
librarySearchInput?.addEventListener('input', applyLibraryFilters);
discoverySearch?.addEventListener('input', applyLibraryFilters);
// Esc clears a search first; a second Esc leaves the field.
[librarySearchInput, discoverySearch].forEach(input => input?.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (input.value) {
        input.value = '';
        applyLibraryFilters();
    } else {
        input.blur();
    }
}));
[['library-clear-search', librarySearchInput], ['discovery-search-clear', discoverySearch]].forEach(([id, input]) => {
    document.getElementById(id)?.addEventListener('click', () => {
        if (!input) return;
        input.value = '';
        applyLibraryFilters();
        input.focus();
    });
});
['library-empty-btn', 'discovery-clear-search'].forEach(id => {
    document.getElementById(id)?.addEventListener('click', event => {
        const button = event.currentTarget;
        const input = button.dataset.scope === 'sidebar' ? librarySearchInput : discoverySearch;
        switch (button.dataset.emptyAction) {
            case 'clear-search':
                if (input) input.value = '';
                applyLibraryFilters();
                input?.focus();
                break;
            case 'show-all': setLibraryFilter('all'); break;
            case 'add':
                STATE.uploadInputTarget = button.dataset.scope === 'sidebar' ? 'sidebar' : 'discovery';
                openUploadOptions();
                break;
            case 'sign-in': document.getElementById('auth-btn')?.click(); break;
            case 'retry': void refreshLibrary(); break;
            default: break;
        }
    });
});
document.getElementById('discovery-continue-btn')?.addEventListener('click', handleContinueListening);
document.getElementById('discovery-continue-card')?.addEventListener('click', handleContinueListening);
function paintIdlePlayerTitle() {
    const playerTitle = document.getElementById('player-title');
    if (playerTitle) playerTitle.innerText = tr('system-ready', 'Ready');
}
// i18n may have applied the language before this module registered its listener.
if (!STATE.currentBook) paintIdlePlayerTitle();

window.addEventListener('uilanguagechange', () => {
    if (libraryView.status !== 'idle') renderLibraryViews();
    // The reader top bar carries data-i18n for its empty state; put the open book back.
    if (STATE.currentBook) {
        const titleEl = document.getElementById('current-title');
        if (titleEl) titleEl.innerText = displayTitle(STATE.currentBook.title);
        const index = STATE.currentChapterIndex || 0;
        const chapter = STATE.currentBook.chapters?.[index];
        const chapterLabel = document.getElementById('current-chapter');
        if (chapter && chapterLabel) {
            const chapterTitle = chapter.title || `${tr('chapter-word', 'Chương')} ${index + 1}`;
            chapterLabel.innerText = `C.${index + 1}/${STATE.currentBook.chapters.length} · ${chapterTitle}`;
        }
    } else {
        paintIdlePlayerTitle();
    }
    STATS_MANAGER.updateUI();
    setPlayIcon(!audio.paused);
    updatePipUI();
    const dockRow = document.getElementById('player-info-layer');
    if (dockRow?.hasAttribute('aria-label')) dockRow.setAttribute('aria-label', tr('dock-return-reader', 'Bấm để quay lại trình đọc'));
});


// ── Sidebar Segmented Tabs (library | toc); voice settings moved to Settings ─
const SIDEBAR_TAB_KEY = 'sidebar-active-tab';
const SIDEBAR_TABS = ['library', 'toc'];

function switchSidebarTab(tab) {
    if (!SIDEBAR_TABS.includes(tab)) tab = 'library';
    SIDEBAR_TABS.forEach(name => {
        const btn = document.getElementById(`tab-${name}`);
        const panel = document.getElementById(`panel-${name}`);
        const isActive = name === tab;
        if (btn) {
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-selected', String(isActive));
        }
        if (panel) {
            panel.hidden = !isActive;
        }
    });
    try { localStorage.setItem(SIDEBAR_TAB_KEY, tab); } catch (_) { /* private mode */ }
    if (tab === 'toc' && STATE.currentBook) {
        renderTOC();
        setTimeout(scrollTOCCurrentChapter, 60);
    }
}

SIDEBAR_TABS.forEach(name => {
    document.getElementById(`tab-${name}`)?.addEventListener('click', () => switchSidebarTab(name));
});
switchSidebarTab(localStorage.getItem(SIDEBAR_TAB_KEY) || 'library');

// ── TOC quick search (accent-insensitive) ───────────────────────────────────
const tocSearchInput = document.getElementById('toc-search');
const tocClearSearchBtn = document.getElementById('toc-clear-search');

function applyTOCSearch() {
    if (!tocSearchInput) return;
    const rawVal = tocSearchInput.value.trim();
    const query = removeVietnameseTones(rawVal.toLowerCase());
    // "12", "c.12", "chương 12" and "chapter 12" all search by number.
    const numberQuery = query.replace(/^(chuong|chapter|ch\.?|c\.?)\s*/, '');
    const isNumber = /^\d+$/.test(numberQuery);
    const tocList = document.getElementById('toc-list');
    let visible = 0;

    document.querySelectorAll('#toc-list > [data-chapter-title]').forEach(card => {
        const titleData = card.dataset.chapterTitle || '';
        const chapIdxStr = `${parseInt(card.dataset.chapterIndex, 10) + 1}`;
        const hit = !query || titleData.includes(query) || (isNumber && chapIdxStr.includes(numberQuery));
        card.style.display = hit ? '' : 'none';
        if (hit) visible += 1;
    });

    if (tocClearSearchBtn) tocClearSearchBtn.hidden = !rawVal;
    if (!tocList) return;

    let emptyEl = tocList.querySelector('[data-toc-empty]');
    if (!emptyEl && query) {
        emptyEl = document.createElement('p');
        emptyEl.dataset.tocEmpty = '';
        emptyEl.className = 'toc-empty';
        tocList.appendChild(emptyEl);
    }
    if (emptyEl) {
        emptyEl.textContent = tr('toc-search-empty', 'Không tìm thấy chương phù hợp.');
        emptyEl.classList.toggle('hidden', visible > 0 || !query);
    }
    updateTOCCount();
}

tocSearchInput?.addEventListener('input', applyTOCSearch);
tocClearSearchBtn?.addEventListener('click', () => {
    if (!tocSearchInput) return;
    tocSearchInput.value = '';
    applyTOCSearch();
    tocSearchInput.focus();
});

// --- Dictionary (Skip & Replace) ---
const DICT_STORAGE_KEY = 'tts-skip-dictionary';

/** Saves the raw dictionary string to localStorage. */
function saveSkipDictionary(rawString) {
    localStorage.setItem(DICT_STORAGE_KEY, rawString.trim());
}

/**
 * Parses the dictionary string into an array of rule objects.
 * Supports:
 *   - Plain skip:           one,...
 *   - Quoted skip:          "chào bạn nhé, tôi tên là"  (commas inside quotes are preserved)
 *   - Replace (quoted):     "chào, tạm biệt"="hi, bye"
 *   - Replace (plain):      hello=hi
 *
 * Grammar (tokenized by comma, but commas inside double-quotes are ignored):
 *   token  :=  ["<lhs>"="<rhs>"] | ["<phrase>"] | [<word>=<word>] | [<word>]
 * Returns: Array<{ from: string, to: string|null }>
 *   - to === null  → skip (remove)
 *   - to === ''    → also skip (remove)
 *   - to !== null  → replace from with to
 */
function parseDictionary(raw) {
    const rules = [];
    if (!raw) return rules;

    // Tokenize: split by comma but respect double-quoted segments
    const tokens = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (ch === '"') {
            inQuote = !inQuote;
            cur += ch;
        } else if (ch === ',' && !inQuote) {
            tokens.push(cur);
            cur = '';
        } else {
            cur += ch;
        }
    }
    if (cur.length > 0) tokens.push(cur);

    for (let token of tokens) {
        token = token.trim();
        if (!token) continue;

        // Check for replace rule: contains = outside of quotes
        // We split on first = that is not inside quotes
        let eqIdx = -1;
        let q = false;
        for (let i = 0; i < token.length; i++) {
            if (token[i] === '"') { q = !q; continue; }
            if (token[i] === '=' && !q) { eqIdx = i; break; }
        }

        if (eqIdx !== -1) {
            // Replace rule
            const lhsRaw = token.slice(0, eqIdx).trim();
            const rhsRaw = token.slice(eqIdx + 1).trim();
            const from = lhsRaw.startsWith('"') && lhsRaw.endsWith('"')
                ? lhsRaw.slice(1, -1)
                : lhsRaw;
            const to = rhsRaw.startsWith('"') && rhsRaw.endsWith('"')
                ? rhsRaw.slice(1, -1)
                : rhsRaw;
            if (from) rules.push({ from, to });
        } else {
            // Skip rule
            const phrase = token.startsWith('"') && token.endsWith('"')
                ? token.slice(1, -1)
                : token;
            if (phrase) rules.push({ from: phrase, to: null });
        }
    }
    return rules;
}

/**
 * Applies the dictionary rules to a sentence before TTS.
 * Rules are applied in order: replace rules substitute text; skip rules remove it.
 * If the entire sentence is filtered out, returns a single space " " so TTS
 * generates near-silent micro-audio — this keeps the MSE chunk sequence intact
 * (skipping an index entirely would block processAppendQueue forever).
 */
function applySkipDictionary(text) {
    const raw = localStorage.getItem(DICT_STORAGE_KEY) || '';
    const rules = parseDictionary(raw);
    if (!rules.length) return text;

    let result = text;
    for (const rule of rules) {
        if (rule.to === null || rule.to === '') {
            // Skip: remove all occurrences
            result = result.split(rule.from).join('');
        } else {
            // Replace
            result = result.split(rule.from).join(rule.to);
        }
    }
    result = result.trim();
    // " " (single space) → TTS produces ~0s micro-silent audio, sequence stays intact
    return result.length > 0 ? result : ' ';
}

function showLoading(text = tr('loading-default', 'Đang xử lý'), { subtext = tr('loading-wait', 'Vui lòng đợi trong giây lát...'), progress = null, status = tr('loading-progress', 'Tiến trình') } = {}) {
    const overlay = document.getElementById('global-loading');
    const textEl = document.getElementById('loading-text');
    const subtextEl = document.getElementById('loading-subtext');
    const progressContainer = document.getElementById('loading-progress-container');
    const progressBar = document.getElementById('loading-progress-bar');
    const progressPercent = document.getElementById('loading-percentage');
    const progressStatus = document.getElementById('loading-progress-status');

    if (overlay) {
        if (textEl) textEl.innerText = text;
        if (subtextEl) {
            subtextEl.innerText = subtext;
            subtextEl.classList.toggle('hidden', !subtext);
        }
        if (progressContainer) {
            if (progress !== null && Number.isFinite(progress)) {
                progressContainer.classList.remove('hidden');
                if (progressStatus) progressStatus.innerText = status;
                const safePercent = Math.max(0, Math.min(100, Math.round(progress)));
                if (progressBar) progressBar.style.width = `${safePercent}%`;
                if (progressPercent) progressPercent.innerText = `${safePercent}%`;
            } else {
                progressContainer.classList.add('hidden');
            }
        }
        overlay.classList.remove('hidden');
        overlay.classList.add('flex');
        setTimeout(() => overlay.classList.remove('opacity-0'), 10);
    }
}

function updateLoadingProgress(progress, text = null, subtext = null, status = null) {
    const textEl = document.getElementById('loading-text');
    const subtextEl = document.getElementById('loading-subtext');
    const progressContainer = document.getElementById('loading-progress-container');
    const progressBar = document.getElementById('loading-progress-bar');
    const progressPercent = document.getElementById('loading-percentage');
    const progressStatus = document.getElementById('loading-progress-status');

    if (text && textEl) textEl.innerText = text;
    if (subtext && subtextEl) subtextEl.innerText = subtext;
    if (status && progressStatus) progressStatus.innerText = status;

    if (progressContainer && progress !== null && Number.isFinite(progress)) {
        progressContainer.classList.remove('hidden');
        const safePercent = Math.max(0, Math.min(100, Math.round(progress)));
        if (progressBar) progressBar.style.width = `${safePercent}%`;
        if (progressPercent) progressPercent.innerText = `${safePercent}%`;
    }
}

function hideLoading() {
    const overlay = document.getElementById('global-loading');
    if (overlay) {
        overlay.classList.add('opacity-0');
        setTimeout(() => {
            overlay.classList.add('hidden');
            overlay.classList.remove('flex');
            const progressContainer = document.getElementById('loading-progress-container');
            const progressBar = document.getElementById('loading-progress-bar');
            const progressPercent = document.getElementById('loading-percentage');
            if (progressContainer) progressContainer.classList.add('hidden');
            if (progressBar) progressBar.style.width = '0%';
            if (progressPercent) progressPercent.innerText = '0%';
        }, 400);
    }
}

function setButtonLoading(button, isLoading) {
    if (typeof button === 'string') button = document.getElementById(button);
    if (!button) return;
    // Disabling a focused button drops focus to <body>; give it back afterwards.
    if (isLoading && document.activeElement === button) button.dataset.refocus = '1';
    button.disabled = !!isLoading;
    button.classList.toggle('is-loading', !!isLoading);
    if (!isLoading && button.dataset.refocus) {
        delete button.dataset.refocus;
        const active = document.activeElement;
        if (button.isConnected && (!active || active === document.body)) button.focus({ preventScroll: true });
    }
    if (isLoading) button.setAttribute('aria-busy', 'true');
    else button.removeAttribute('aria-busy');
    if (button.classList.contains('icon-btn')) setIconButtonGlyph(button, isLoading ? 'i-download' : null);
}

// Icon-only buttons show their state through the glyph (no spinner loop):
// a download arrow while busy, a check on success, then the original icon.
function setIconButtonGlyph(button, iconId) {
    const use = button.querySelector('svg use');
    if (!use) return;
    if (!button.dataset.icon) button.dataset.icon = use.getAttribute('href') || '';
    use.setAttribute('href', iconId ? `#${iconId}` : button.dataset.icon);
}

function flashButtonSuccess(button) {
    if (!button.classList.contains('icon-btn')) return;
    clearTimeout(button._successTimer);
    button.classList.add('is-success');
    setIconButtonGlyph(button, 'i-check');
    button._successTimer = setTimeout(() => {
        button.classList.remove('is-success');
        if (!button.hasAttribute('aria-busy')) setIconButtonGlyph(button, null);
    }, 1600);
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

/**
 * Wraps a callback in View Transitions API if available.
 * @param {Function} callback 
 */
function safeViewTransition(callback) {
    // View-transition snapshots of #text-container (view-transition-name:
    // reader-content) are painted in the ::view-transition layer, above every
    // element, so in lite mode the chapter text flashed through the black
    // pocket overlay on each auto chapter change. Skip the animation there,
    // and in hidden tabs where it only aborts with "Document hidden".
    // Chromium's renderer crashes when a transition runs while #toc-sheet is open
    // with its sticky current-chapter row pinned, so skip it there too.
    const tocSheetOpen = document.getElementById('toc-sheet')?.hidden === false;
    if (document.startViewTransition && !STATE.isLiteMode && !tocSheetOpen && document.visibilityState !== 'hidden') {
        // Callers await the DOM update (e.g. to scroll to the saved sentence); the
        // ViewTransition object itself is not awaitable.
        return document.startViewTransition(callback).updateCallbackDone.catch(err => console.debug('[ViewTransition] Update failed:', err?.message));
    } else {
        return callback();
    }
}

// --- Utilities ---

/**
 * Robustly resets the audio engine state to ensure a clean transition
 * between chapters or books. This handles pausing, clearing queues,
 * and resetting the SourceBuffer.
 */
async function resetAudioEngine() {
    console.log("Resetting Audio Engine for new session...");

    // Mark the intentional reset before pausing. The pause event must not
    // checkpoint the previous book under a newly selected book ID.
    STATE.isTransitioning = true;

    // 1. Explicitly stop playback and reset clock
    audio.pause();
    audio.currentTime = 0; // Immediate UI reset
    STATE.isPlaying = false;
    STATE.isStalled = false;

    // 2. Increment Session ID to invalidate all pending WebSocket messages
    STATE.sessionId++;

    // 3. Clear RAM State (Queues & Metadata)
    STATE.appendQueue = [];
    if (STATE.appendRetryTimeout) {
        clearTimeout(STATE.appendRetryTimeout);
        STATE.appendRetryTimeout = null;
    }
    STATE.chunkTimings = [];
    STATE.fetchingSet.clear();
    STATE.metadataQueue = [];
    STATE.downloadBuffer.clear();

    // 4. Reset Session markers
    STATE.lastAppendedIndex = -1;
    STATE.lastAppendedChapter = 0;
    STATE.lastAppendedPartKey = null;
    STATE.lastAppendedPart = -1;
    STATE.completedParts.clear();
    STATE.partialAudio.clear();
    STATE.isFirstChunkOfSession = true;
    STATE.lastOntimeUpdateTick = 0;
    STATE.lastProgressWidth = null;
    STATE.lastCurrentMock = null;
    STATE.lastTimeStr = null;

    // 5. Robust SourceBuffer Cleanup
    if (STATE.sourceBuffer) {
        try {
            // Abort any active operations first
            if (STATE.sourceBuffer.updating) {
                console.log("Aborting active SourceBuffer operation...");
                STATE.sourceBuffer.abort();
            }

            // Wait for SourceBuffer to be ready for removal
            await waitForSourceBufferIdle(2_000);

            // Remove all buffered data
            if (STATE.sourceBuffer.buffered.length > 0) {
                const end = STATE.sourceBuffer.buffered.end(STATE.sourceBuffer.buffered.length - 1);
                console.log(`Clearing SourceBuffer: 0 to ${end + 10}s`);
                STATE.sourceBuffer.remove(0, end + 10);

                await waitForSourceBufferIdle(2_000);
            }

            STATE.sourceBuffer.timestampOffset = 0;
        } catch (e) {
            console.warn("SourceBuffer reset error:", e);
        }
    }

    // 6. Reset UI indicators
    document.getElementById('status-indicator').innerText = tr('status-ready', 'Ready');
    setPlayIcon(false);

    // 7. Reset stall counters
    STATE.stallCount = 0;
    STATE.pauseCount = 0;
    STATE.isStalled = false;
    STATE.isTransitioning = false; // Re-enable playback tracking
}

// Keep only the content needed for the current view and the immediate next
// chapter/segment. Older text remains recoverable from storage and will be
// loaded again if the reader navigates backwards.
function trimReaderContentCache(activeChapterIndex) {
    if (!STATE.currentBook?.chapters) return;

    // With short chapters the prefetch window spans several chapters; their
    // text is still read by runPrefetch, retries and processAppendQueue.
    let pipelineEnd = activeChapterIndex + 1;
    const extend = (chapterIndex) => {
        if (Number.isInteger(chapterIndex) && chapterIndex > pipelineEnd) pipelineEnd = chapterIndex;
    };
    extend(STATE.lastAppendedChapter);
    STATE.appendQueue.forEach(chunk => extend(chunk.chapterIndex));
    STATE.chunkTimings.forEach(timing => extend(timing.chapterIndex));
    STATE.fetchingSet.forEach(key => extend(Number.parseInt(key, 10)));

    if (STATE.isSegmented) {
        const segmentSize = STATE.segmentSize || 100;
        const activeSegment = Math.floor(activeChapterIndex / segmentSize);
        const keepSegments = new Set([activeSegment, activeSegment + 1]);
        for (let segment = activeSegment + 2; segment <= Math.floor(pipelineEnd / segmentSize); segment++) keepSegments.add(segment);
        for (const segmentIndex of Array.from(STATE.loadedSegments)) {
            if (keepSegments.has(segmentIndex)) continue;
            const start = segmentIndex * segmentSize;
            const end = Math.min(start + segmentSize, STATE.currentBook.chapters.length);
            for (let index = start; index < end; index++) {
                const chapter = STATE.currentBook.chapters[index];
                if (chapter?.sentences) chapter.sentences = null;
            }
            STATE.loadedSegments.delete(segmentIndex);
        }
        return;
    }

    const firstKept = Math.max(0, activeChapterIndex);
    const lastKept = Math.min(STATE.currentBook.chapters.length - 1, pipelineEnd);
    STATE.currentBook.chapters.forEach((chapter, index) => {
        if (index >= firstKept && index <= lastKept) return;
        if (chapter?.sentences) chapter.sentences = null;
    });
}

function waitForSourceBufferIdle(timeoutMs) {
    const sourceBuffer = STATE.sourceBuffer;
    if (!sourceBuffer?.updating) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const started = performance.now();
        const check = () => {
            if (!sourceBuffer.updating) {
                resolve();
            } else if (performance.now() - started >= timeoutMs) {
                reject(new NetworkTimeoutError('MediaSource reset', timeoutMs));
            } else {
                setTimeout(check, 30);
            }
        };
        check();
    });
}

// Initialize Managers
STATS_MANAGER.init();
OFFLINE_MANAGER.updateUsageUI();

// Constants
const WORKER_STEPS = [1, 2, 3];

// DOM Elements
const audio = document.getElementById('main-audio');
const playBtn = document.getElementById('play-btn');
const textContainer = document.getElementById('text-container');
// Kept so the empty reader state can come back after a book is closed.
const readerEmptyTemplate = textContainer?.querySelector('.reader-empty')?.cloneNode(true) || null;
const fileInput = document.getElementById('file-input');
const imageInput = document.getElementById('image-input');

const modalReturnFocus = new Map();
const libraryTriggerHome = new WeakMap();

// A library refresh rebuilds every row, so a saved row button may be detached
// by the time a dialog closes; fall back to the same button in the new row.
function resolveFocusTarget(el) {
    if (!el || el.isConnected) return el || null;
    const home = libraryTriggerHome.get(el);
    if (!home) return null;
    return document.getElementById(home.listId)
        ?.querySelector(`[data-book-id="${CSS.escape(home.bookId)}"] [data-action="${home.action}"]`) || null;
}

function returnFocusTo(el) {
    const target = resolveFocusTarget(el);
    const active = document.activeElement;
    if (target && (!active || active === document.body)) target.focus({ preventScroll: true });
}

function setModalVisibility(id, visible) {
    const modal = document.getElementById(id);
    if (!modal) return;
    const wasVisible = !modal.classList.contains('hidden');
    modal.classList.toggle('hidden', !visible);
    modal.classList.toggle('flex', visible);
    if (visible && !wasVisible) openLayer(id, () => closeModalFromBack(id));
    else if (!visible && wasVisible) closeLayer(id);
    if (visible && !wasVisible) {
        modalReturnFocus.set(id, document.activeElement);
        requestAnimationFrame(() => {
            const target = modal.querySelector('[data-autofocus]')
                || modal.querySelector('.modal-card button:not([disabled]):not([data-close-upload-options]):not([data-close-upload-files]):not([data-close-image-manager]), .modal-card input:not([type="file"]):not([readonly])')
                || modal.querySelector('.modal-card button');
            target?.focus({ preventScroll: true });
        });
    } else if (!visible && wasVisible) {
        const previous = resolveFocusTarget(modalReturnFocus.get(id));
        modalReturnFocus.delete(id);
        if (previous && typeof previous.focus === 'function') previous.focus({ preventScroll: true });
    }
}

// Back closes a modal the way its own Cancel/X does.
function closeModalFromBack(id) {
    const closers = {
        'upload-options-modal': () => { STATE.uploadImagesChoice = false; setModalVisibility(id, false); },
        'upload-files-modal': closeUploadFilesModal,
        'merge-chapters-modal': closeMergeModal,
        'image-crop-modal': closeImageCropper,
        'rename-modal': () => (renameDialog ? renameDialog.finish(null) : setModalVisibility(id, false)),
        'confirm-modal': () => (confirmDialog ? confirmDialog.finish(false) : setModalVisibility(id, false)),
    };
    (closers[id] || (() => setModalVisibility(id, false)))();
}

function topOpenModal() {
    const open = [...document.querySelectorAll('.modal[aria-modal="true"]:not(.hidden)')];
    if (!open.length) return null;
    const layer = el => (el.classList.contains('modal--top') ? 1 : 0);
    return open.reduce((top, el) => (layer(el) >= layer(top) ? el : top));
}

document.addEventListener('keydown', event => {
    if (event.key !== 'Tab' || event.defaultPrevented) return;
    const modal = topOpenModal();
    if (modal) trapTab(modal, event);
});

function openUploadOptions() {
    setModalVisibility('upload-options-modal', true);
}

function beginBookUpload(withImages, inputTarget = STATE.uploadInputTarget || 'sidebar') {
    STATE.uploadImagesChoice = withImages;
    STATE.uploadInputTarget = inputTarget;
    setModalVisibility('upload-options-modal', false);
    if (withImages) {
        STATE.pendingUploadTextFile = null;
        STATE.pendingUploadImageFiles = [];
        document.getElementById('book-text-path')?.setAttribute('value', '');
        document.getElementById('book-image-path')?.setAttribute('value', '');
        const textPath = document.getElementById('book-text-path');
        const imagePath = document.getElementById('book-image-path');
        if (textPath) textPath.value = '';
        if (imagePath) imagePath.value = '';
        const textInput = document.getElementById('book-text-input');
        const imagesInput = document.getElementById('book-image-input');
        if (textInput) textInput.value = '';
        if (imagesInput) imagesInput.value = '';
        updateUploadFilePaths();
        setModalVisibility('upload-files-modal', true);
        return;
    }
    const input = inputTarget === 'discovery'
        ? document.getElementById('discovery-file-input')
        : fileInput;
    if (input) {
        input.accept = '.txt,.epub,.pdf';
        input.multiple = false;
        input.value = '';
        input.click();
    }
}

function closeUploadFilesModal() {
    STATE.pendingUploadTextFile = null;
    STATE.pendingUploadImageFiles = [];
    STATE.uploadImagesChoice = false;
    releaseUploadThumbs();
    setModalVisibility('upload-files-modal', false);
}

let uploadThumbURLs = [];
function releaseUploadThumbs() {
    uploadThumbURLs.forEach(url => URL.revokeObjectURL(url));
    uploadThumbURLs = [];
    document.getElementById('book-image-thumbs')?.replaceChildren();
}

// Picked images as thumbnails; the first one is the cover and a tap moves another one first.
function renderUploadThumbs() {
    const list = document.getElementById('book-image-thumbs');
    if (!list) return;
    releaseUploadThumbs();
    const images = STATE.pendingUploadImageFiles;
    list.hidden = !images.length;
    images.forEach((file, index) => {
        const url = URL.createObjectURL(file);
        uploadThumbURLs.push(url);
        const item = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'import-thumb';
        btn.setAttribute('aria-pressed', String(index === 0));
        btn.setAttribute('aria-label', index === 0
            ? tr('import-cover-current', 'Ảnh bìa: {name}', { name: file.name })
            : tr('import-cover-choose', 'Chọn {name} làm bìa', { name: file.name }));
        const img = document.createElement('img');
        img.src = url;
        img.alt = '';
        img.decoding = 'async';
        btn.appendChild(img);
        if (index === 0) {
            const badge = document.createElement('span');
            badge.className = 'import-thumb__badge';
            badge.textContent = tr('cover-badge', 'Bìa');
            btn.appendChild(badge);
        }
        btn.addEventListener('click', () => {
            if (index === 0) return;
            const next = [...STATE.pendingUploadImageFiles];
            next.unshift(...next.splice(index, 1));
            STATE.pendingUploadImageFiles = next;
            renderUploadThumbs();
            list.querySelector('.import-thumb')?.focus({ preventScroll: true });
        });
        item.appendChild(btn);
        list.appendChild(item);
    });
}

function updateUploadFilePaths() {
    const textPath = document.getElementById('book-text-path');
    const imagePath = document.getElementById('book-image-path');
    if (textPath) textPath.value = STATE.pendingUploadTextFile?.name || '';
    if (imagePath) {
        const images = STATE.pendingUploadImageFiles;
        imagePath.value = images.length ? tr('import-images-count', '{count} ảnh: {names}', { count: images.length, names: images.map(file => file.name).join(', ') }) : '';
    }
    const confirmBtn = document.getElementById('confirm-upload-files-btn');
    if (confirmBtn) confirmBtn.disabled = !STATE.pendingUploadTextFile;
    const titleField = document.getElementById('book-title-field');
    if (titleField) titleField.hidden = !STATE.pendingUploadTextFile;
    renderUploadThumbs();
}

document.getElementById('browse-book-text-btn')?.addEventListener('click', () => document.getElementById('book-text-input')?.click());
document.getElementById('browse-book-image-btn')?.addEventListener('click', () => document.getElementById('book-image-input')?.click());
// The read-only path boxes open the picker too.
document.querySelectorAll('#upload-files-modal [data-pick]').forEach(field => {
    field.addEventListener('click', () => document.getElementById(field.dataset.pick)?.click());
});
document.getElementById('book-text-input')?.addEventListener('change', async event => {
    const file = event.target.files?.[0] || null;
    STATE.pendingUploadTextFile = file;
    updateUploadFilePaths();
    const titleInput = document.getElementById('book-title-input');
    if (titleInput && file) {
        const guess = await guessBookTitle(file);
        if (STATE.pendingUploadTextFile === file) titleInput.value = guess;
    }
});
document.getElementById('book-image-input')?.addEventListener('change', event => {
    STATE.pendingUploadImageFiles = Array.from(event.target.files || []);
    updateUploadFilePaths();
});
document.getElementById('confirm-upload-files-btn')?.addEventListener('click', () => {
    if (!STATE.pendingUploadTextFile) {
        APP_STATUS.toast(tr('import-pick-text-first', 'Vui lòng chọn file .txt trước.'), 'warning');
        return;
    }
    const files = [STATE.pendingUploadTextFile, ...STATE.pendingUploadImageFiles];
    STATE.pendingUploadTitle = document.getElementById('book-title-input')?.value || '';
    releaseUploadThumbs();
    setModalVisibility('upload-files-modal', false);
    STATE.uploadImagesChoice = true;
    handleFileUpload({ target: { files, value: '' } });
});
document.getElementById('cancel-upload-files-btn')?.addEventListener('click', closeUploadFilesModal);
document.querySelectorAll('[data-close-upload-files]').forEach(el => el.addEventListener('click', closeUploadFilesModal));

async function processImageFiles(fileList) {
    const files = Array.from(fileList || []).filter(file => file && (file.type?.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif|bmp|avif|image)$/i.test(file.name || '')));
    if (!files.length) return;
    const addBtn = document.getElementById('image-manager-add-btn');
    setButtonLoading(addBtn, true, tr('processing', 'Đang xử lý...'));
    showLoading(tr('images-processing', 'Đang xử lý {count} ảnh...', { count: files.length }), { progress: 0, status: tr('images-processing-step', 'Nén & Tải ảnh') });
    try {
        const bookId = imageManagerBookId || STATE.currentBookId;
        if (!bookId || !STATE.user) throw new Error(tr('images-need-book', 'Hãy mở một truyện và đăng nhập trước.'));
        if (STATE.imageEditTargetId) {
            await replaceBookImage(bookId, STATE.imageEditTargetId, files[0]);
        } else {
            await uploadBookImages(bookId, files, imageManagerBookTitle || STATE.currentBook?.title || '');
        }
        await renderImageManager();
        await refreshLibrary();
        announceImageChange(tr('images-updated', 'Đã cập nhật {count} ảnh thành công.', { count: files.length }));
    } catch (err) {
        console.error('[Images] Manage error:', err);
        APP_STATUS.error(tr('images-update-failed', 'Không thể cập nhật ảnh: {error}', { error: err.message }));
    } finally {
        setButtonLoading(addBtn, false);
        hideLoading();
        STATE.imageEditTargetId = null;
        if (imageInput) imageInput.value = '';
    }
}

async function handleImageInputSelection() {
    await processImageFiles(imageInput?.files || []);
}

document.getElementById('upload-book-btn')?.addEventListener('click', () => {
    STATE.uploadInputTarget = 'sidebar';
    openUploadOptions();
});
['discovery-add-btn', 'shelf-empty-add'].forEach(id => document.getElementById(id)?.addEventListener('click', () => {
    STATE.uploadInputTarget = 'discovery';
    openUploadOptions();
}));
document.getElementById('upload-txt-only-btn')?.addEventListener('click', () => beginBookUpload(false));
document.getElementById('upload-txt-images-btn')?.addEventListener('click', () => beginBookUpload(true));
document.querySelectorAll('[data-close-upload-options]').forEach(el => el.addEventListener('click', () => {
    STATE.uploadImagesChoice = false;
    setModalVisibility('upload-options-modal', false);
}));
document.querySelectorAll('[data-close-image-manager]').forEach(el => el.addEventListener('click', () => setModalVisibility('image-manager-modal', false)));
document.getElementById('image-manager-add-btn')?.addEventListener('click', () => {
    STATE.imageEditTargetId = null;
    imageInput?.click();
});
if (imageInput) imageInput.addEventListener('change', handleImageInputSelection);
const imageManagerList = document.getElementById('image-manager-list');
if (imageManagerList) {
    ['dragenter', 'dragover'].forEach(eventName => imageManagerList.addEventListener(eventName, event => {
        event.preventDefault();
        imageManagerList.classList.add('is-drop');
    }));
    ['dragleave', 'drop'].forEach(eventName => imageManagerList.addEventListener(eventName, event => {
        event.preventDefault();
        imageManagerList.classList.remove('is-drop');
    }));
    imageManagerList.addEventListener('drop', event => processImageFiles(event.dataTransfer?.files || []));
}
document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || imageCropSession) return;
    const isOpen = id => !document.getElementById(id)?.classList.contains('hidden');
    if (isOpen('upload-files-modal')) {
        closeUploadFilesModal();
    } else if (isOpen('upload-options-modal')) {
        STATE.uploadImagesChoice = false;
        setModalVisibility('upload-options-modal', false);
    } else if (isOpen('image-manager-modal')) {
        setModalVisibility('image-manager-modal', false);
    } else if (isOpen('edit-chapter-modal')) {
        closeEditModal();
    } else if (isOpen('merge-chapters-modal')) {
        closeMergeModal();
    } else {
        return;
    }
    event.preventDefault();
});
document.addEventListener('paste', event => {
    const modal = document.getElementById('image-manager-modal');
    if (!modal || modal.classList.contains('hidden') || !(imageManagerBookId || STATE.currentBookId)) return;
    const clipboardFiles = Array.from(event.clipboardData?.files || []);
    if (clipboardFiles.length) {
        event.preventDefault();
        processImageFiles(clipboardFiles);
    }
});

// The real media element + Media Session are sufficient for supported
// browsers to classify this page as background audio. A silent Web Audio
// oscillator kept the DSP/audio graph awake continuously and heated phones.

// Idle and sleep-timer stops say why playback ended; the "Paused" /
// "Disconnected" that follow them must not replace that reason.
function setStatusKeepingStopReason(text) {
    const indicator = document.getElementById('status-indicator');
    if (statusMatches(indicator.innerText, 'status-session-expired', 'status-sleep-stopped', 'status-taken-over')) return;
    indicator.innerText = text;
}

// True when the status text is one of these keys in either UI language.
function statusMatches(text, ...keys) {
    return keys.some(key => ['en', 'vi'].some(lang => window.translations?.[lang]?.[key] === text));
}

function idleStatus() {
    if (STATE.isPlaying && !audio.paused) return tr('status-streaming', 'Streaming');
    // A prefetch reply that lands after a pause must not turn "Paused" into "Ready".
    const current = document.getElementById('status-indicator')?.innerText;
    if (audio.paused && statusMatches(current, 'status-paused')) return current;
    return tr('status-ready', 'Ready');
}

// play() rejects with AbortError when a pause() lands first; that is expected.
function resumeAudio() {
    applyPlaybackRate();
    return audio.play().catch(err => {
        if (err?.name !== 'AbortError') console.warn('[Audio] play() rejected:', err);
    });
}

// The server keeps one TTS socket per account and refuses extra ones with 1013.
function wsRefusedRecently() {
    return !!STATE.wsRefusedAt && Date.now() - STATE.wsRefusedAt < 15000;
}

// Strip above the console while this account plays on another tab/device:
// 'busy' = our socket was refused, 'taken' = another device took our socket.
function setPlaybackElsewhere(mode, { flash = false } = {}) {
    const strip = document.getElementById('console-elsewhere');
    playBtn?.toggleAttribute('data-blocked', !!mode);
    if (!strip) return;
    if (!mode) {
        strip.hidden = true;
        strip.classList.remove('is-flash');
        document.getElementById('console-elsewhere-btn')?.removeAttribute('aria-busy');
        return;
    }
    const text = document.getElementById('console-elsewhere-text');
    const key = mode === 'taken' ? 'elsewhere-taken' : 'elsewhere-busy';
    if (text) {
        text.dataset.i18n = key;
        text.textContent = tr(key, mode === 'taken' ? 'Đã chuyển sang thiết bị khác' : 'Đang phát trên thiết bị khác');
    }
    document.getElementById('console-elsewhere-btn')?.removeAttribute('aria-busy');
    const wasShown = !strip.hidden;
    strip.hidden = false;
    if (flash && wasShown) {
        strip.classList.remove('is-flash');
        void strip.offsetWidth;
        strip.classList.add('is-flash');
        AudioHapticFX.haptic(30);
    }
}

function connectionFailedStatus() {
    return wsRefusedRecently() ? tr('status-conn-busy', 'Listening in another tab or device') : tr('status-conn-failed', 'Connection failed');
}

// The user pressed Play (or opened a book) in the last few seconds.
function playRequestedRecently() {
    return !!STATE.playIntentAt && Date.now() - STATE.playIntentAt < 20000;
}

// "Nghe ở đây": the server closes the other tab's or device's socket and gives its slot to this one.
async function takeOverPlayback() {
    if (!STATE.currentBook) return;
    const btn = document.getElementById('console-elsewhere-btn');
    STATE.wsRefusedAt = 0;
    STATE.wsTakeover = true;
    btn?.setAttribute('aria-busy', 'true');
    try {
        if (STATE.ws && STATE.ws.readyState !== WebSocket.OPEN) closeWebSocketIntentionally();
        if (audio.paused) await togglePlayback();
    } finally {
        STATE.wsTakeover = false;
        btn?.removeAttribute('aria-busy');
    }
}

function closeWebSocketIntentionally() {
    if (STATE.prefetchTimeout) {
        clearTimeout(STATE.prefetchTimeout);
        STATE.prefetchTimeout = null;
    }
    if (STATE.heartbeatInterval) {
        clearInterval(STATE.heartbeatInterval);
        STATE.heartbeatInterval = null;
    }
    if (!STATE.isPlaying) STATE.pauseTimeoutHandled = true;

    const socket = STATE.ws;
    if (!socket) return;
    socket._intentionalClose = true;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
    }
    if (STATE.ws === socket) STATE.ws = null;
}

async function stopPlaybackSession() {
    await resetAudioEngine();
    closeWebSocketIntentionally();
}

// --- Initialization ---
async function initWebSocket() {
    if (STATE.ws && (STATE.ws.readyState === WebSocket.OPEN || STATE.ws.readyState === WebSocket.CONNECTING)) {
        return; // Don't create multiple connections
    }
    if (!STATE.user) return;
    if (STATE.wsConnecting) return;
    STATE.wsConnecting = true;
    let token;
    try {
        token = await STATE.user.getIdToken();
    } catch (error) {
        STATE.wsConnecting = false;
        console.error('Unable to authenticate WebSocket:', error);
        return;
    }
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    STATE.ws = new WebSocket(wsUrl);
    // ArrayBuffer frames are handled synchronously, so a sentence's last part
    // is stored before its PREFETCH_DONE arrives (Blob.arrayBuffer() raced it).
    STATE.ws.binaryType = 'arraybuffer';
    const socket = STATE.ws;
    socket._takeover = !!STATE.wsTakeover;
    STATE.wsTakeover = false;
    STATE.wsConnecting = false;

    STATE.ws.onopen = () => {
        console.log("Connected to WebSocket");
        document.getElementById('status-indicator').innerText = idleStatus();
        socket.send(JSON.stringify({ type: "AUTH", token, ...(socket._takeover ? { takeover: true } : {}) }));

        // --- FIXED: Clear existing heartbeat to avoid PING interval leaks ---
        if (STATE.heartbeatInterval) clearInterval(STATE.heartbeatInterval);

        // Start Heartbeat
        STATE.heartbeatInterval = setInterval(() => {
            if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
                STATE.ws.send(JSON.stringify({ type: "PING" }));
            }
            // --- HTTP Ping to keep Fly proxy alive while playing ---
            if (STATE.isPlaying) fetch('/api/ping').catch(() => { });
        }, 15000); // FIX #1: Reduced from 30s to 15s to prevent Fly.io proxy hard timeout
    };

    STATE.ws.onmessage = async (event) => {
        if (typeof event.data === "string") {
            const data = JSON.parse(event.data);
            if (data.type === "AUTH_OK") {
                STATE.wsRefusedAt = 0;
                setPlaybackElsewhere(null);
                return;
            }
            if (data.type === "METADATA") {
                // Bỏ qua nếu là session cũ
                if (data.sessionId && data.sessionId !== STATE.sessionId) {
                    console.log(`Ignoring old METADATA (Session ${data.sessionId}, Current ${STATE.sessionId})`);
                    return;
                }
                // Đưa vào hàng đợi thay vì gán đè biến
                STATE.metadataQueue.push(data);
            } else if (data.type === "PREFETCH_DONE" || data.type === "PREFETCH_FAILED") {
                if (data.sessionId && data.sessionId !== STATE.sessionId) return;
                const failKey = `${data.chapterIndex}_${data.index}`;
                STATE.fetchingSet.delete(failKey);
                if (data.type === "PREFETCH_DONE") STATE.streamingRetryCount.delete(failKey);
                if (data.type === "PREFETCH_DONE" && data.parts !== undefined) {
                    STATE.completedParts.set(failKey, data.parts);
                    const parts = STATE.partialAudio.get(failKey);
                    STATE.partialAudio.delete(failKey);
                    if (parts && parts.filter(Boolean).length === data.parts) {
                        const blob = new Blob(parts, { type: 'audio/mpeg' });
                        OFFLINE_MANAGER.saveBlob(STATE.currentBookId, data.chapterIndex, data.index, blob);
                    }
                    // The sentence is complete: the next one may now be appended.
                    processAppendQueue();
                }

                if (data.type === "PREFETCH_FAILED") {
                    console.error(`Chunk fetch failed: ${data.chapterIndex}-${data.index} - ${data.error || "Unknown"}`);
                    const failKey = `${data.chapterIndex}_${data.index}`;
                    STATE.fetchingSet.delete(failKey);

                    // --- [TASK 2] Streaming Mode Retry Logic ---
                    if (!STATE.isDownloading && STATE.currentBook) {
                        // Edge outages come in bursts of ~10-30s where every attempt
                        // fails. Giving up after a few quick retries left a permanent
                        // hole that ended in a stall reset, so keep retrying with a
                        // capped backoff long enough to ride out such a burst.
                        const MAX_RETRIES = 20;
                        const retries = (STATE.streamingRetryCount.get(failKey) || 0) + 1;
                        STATE.streamingRetryCount.set(failKey, retries);

                        if (retries <= MAX_RETRIES) {
                            const delay = Math.min(400 * 2 ** (retries - 1), 5000);
                            const retrySession = STATE.sessionId;
                            console.warn(`[Streaming] Retrying chunk ${failKey} (attempt ${retries}/${MAX_RETRIES}) in ${delay}ms...`);
                            document.getElementById('status-indicator').innerText = tr('status-retry-chunk', 'Retrying sentence… ({n})', { n: retries });

                            setTimeout(() => {
                                if (retrySession !== STATE.sessionId) {
                                    STATE.streamingRetryCount.delete(failKey);
                                    return;
                                }
                                if (STATE.isDownloading || !STATE.ws || STATE.ws.readyState !== WebSocket.OPEN) return;
                                const chapter = STATE.currentBook.chapters[data.chapterIndex];
                                if (!chapter || !chapter.sentences) {
                                    STATE.streamingRetryCount.delete(failKey);
                                    return;
                                }

                                const text = applySkipDictionary(chapter.sentences[data.index]);
                                const { voice, pitch, volume } = STATE.settings;
                                const rate = ttsRate();

                                STATE.fetchingSet.add(failKey);
                                STATE.ws.send(JSON.stringify({
                                    type: "PREFETCH",
                                    parts: true, // progressive delivery: play the first piece without waiting for the rest
                                    index: data.index,
                                    chapterIndex: data.chapterIndex,
                                    text: text,
                                    voice: voice,
                                    rate: rate,
                                    pitch: pitch,
                                    volume: volume,
                                    numWorkers: STATE.settings.numWorkers,
                                    ...ttsToggles(),
                                    sessionId: STATE.sessionId
                                }));
                            }, delay);
                            return; // Wait for the retry
                        }
                        STATE.streamingRetryCount.delete(failKey);
                    }

                    // --- Download Mode Retry Logic with Backoff & Sliding Window ---
                    if (STATE.isDownloading) {
                        STATE.downloadInFlight?.delete(failKey);
                        STATE.fetchingSet.delete(failKey);

                        const isQueueFull = (data.error || '').toLowerCase().includes('queue is full');
                        const MAX_RETRIES = 5;
                        const meta = STATE.downloadChunkMeta.get(failKey);

                        if (meta) {
                            if (isQueueFull) {
                                // Backend queue is full: requeue with soft backoff without consuming retry quota
                                console.warn(`[Download] Backend queue full for chunk ${failKey}. Requeueing in 600ms...`);
                                setTimeout(() => {
                                    if (!STATE.isDownloading) return;
                                    STATE.downloadPendingQueue?.unshift(meta);
                                    if (typeof dispatchDownloadQueue === 'function') dispatchDownloadQueue();
                                }, 600);
                            } else {
                                const retries = (STATE.downloadRetryCount.get(failKey) || 0) + 1;
                                STATE.downloadRetryCount.set(failKey, retries);

                                if (retries <= MAX_RETRIES) {
                                    const delay = Math.min(6000, retries * 1200);
                                    console.warn(`[Download] Retrying chunk ${failKey} (attempt ${retries}/${MAX_RETRIES}) in ${delay}ms...`);

                                    const statusEl = document.getElementById('toc-download-status');
                                    const received = STATE.downloadBuffer.size;
                                    const total = STATE.downloadExpected;
                                    if (statusEl) statusEl.innerText = tr('dl-retrying', 'Đang thử lại đoạn lỗi ({retries}/{max})… ({done}/{total})', { retries, max: MAX_RETRIES, done: received, total });

                                    setTimeout(() => {
                                        if (!STATE.isDownloading) return;
                                        STATE.downloadPendingQueue?.push(meta);
                                        if (typeof dispatchDownloadQueue === 'function') dispatchDownloadQueue();
                                    }, delay);
                                } else {
                                    console.error(`[Download] Chunk ${failKey} failed after ${MAX_RETRIES} retries. Aborting download.`);
                                    if (STATE.downloadReject) {
                                        STATE.downloadReject(new Error(`Chunk ${failKey} failed after ${MAX_RETRIES} retries (${data.error || 'TTS Error'}).`));
                                        STATE.downloadReject = null;
                                        STATE.downloadResolve = null;
                                    }
                                }
                            }
                        }
                        if (typeof dispatchDownloadQueue === 'function') dispatchDownloadQueue();
                    }
                } else if (textContainer.getAttribute('aria-busy') !== 'true') {
                    // Late prefetch replies must not hide "Loading chapter…" while the skeleton shows.
                    setStatusKeepingStopReason(idleStatus());
                }

                // Update UI using buffer health logic
                updatePrefetchUI();
            }
        } else {
            // Binary Audio Data (MP3 Chunks) đến
            const currentMetadata = STATE.metadataQueue.shift();

            if (!currentMetadata || (currentMetadata.sessionId && currentMetadata.sessionId !== STATE.sessionId)) {
                console.log("Ignoring old/orphaned binary data (mismatched Session ID)");
                return;
            }

            const arrayBuffer = event.data instanceof ArrayBuffer ? event.data : await event.data.arrayBuffer();

            // --- Download Mode: route to download buffer ---
            if (STATE.isDownloading) {
                const key = `${currentMetadata.chapterIndex}_${currentMetadata.index}`;
                STATE.downloadBuffer.set(key, arrayBuffer);
                STATE.downloadInFlight?.delete(key);
                STATE.fetchingSet.delete(key);

                // Slot freed: dispatch next pending chunk in sliding window pipeline
                if (typeof dispatchDownloadQueue === 'function') {
                    dispatchDownloadQueue();
                }

                // Update download progress UI
                const received = STATE.downloadBuffer.size;
                const total = STATE.downloadExpected;
                const progress = total > 0 ? Math.round((received / total) * 100) : 0;

                const progressBar = document.getElementById('toc-download-progress-bar');
                const percentEl = document.getElementById('toc-download-percent');
                const chapterInfo = document.getElementById('toc-download-chapter-info');
                const statusEl = document.getElementById('toc-download-status');

                if (progressBar) progressBar.style.width = `${progress}%`;
                if (percentEl) percentEl.innerText = `${progress}%`;
                if (chapterInfo) chapterInfo.innerText = tr('dl-parts', '{done}/{total} đoạn', { done: received, total });
                if (statusEl) statusEl.innerText = tr('dl-processing', 'Đang đọc… ({done}/{total})', { done: received, total });

                // Check if all chunks received
                if (received >= total && STATE.downloadResolve) {
                    STATE.downloadResolve();
                    STATE.downloadResolve = null;
                }
                return;
            }

            // --- Normal Streaming Mode: append to MSE ---
            const hasParts = currentMetadata.part !== undefined;
            if (hasParts) {
                // Progressive sentence: cache only once every part has arrived
                // (see PREFETCH_DONE), otherwise offline replay would be cut short.
                const key = `${currentMetadata.chapterIndex}_${currentMetadata.index}`;
                const parts = STATE.partialAudio.get(key) || [];
                parts[currentMetadata.part] = arrayBuffer;
                STATE.partialAudio.set(key, parts);
            } else {
                const blob = new Blob([arrayBuffer], { type: 'audio/mpeg' });
                OFFLINE_MANAGER.saveBlob(STATE.currentBookId, currentMetadata.chapterIndex, currentMetadata.index, blob);
            }

            const synthesizedSpeed = rateToSpeed(currentMetadata.rate) ?? ttsSpeed();
            OFFLINE_MANAGER.speeds.set(
                `${STATE.currentBookId}_${currentMetadata.chapterIndex}_${currentMetadata.index}`, synthesizedSpeed
            );

            STATE.appendQueue.push({
                index: currentMetadata.index,
                chapterIndex: currentMetadata.chapterIndex,
                sessionId: currentMetadata.sessionId,
                part: hasParts ? currentMetadata.part : undefined,
                data: arrayBuffer,
                ttsSpeed: synthesizedSpeed,
                metadata: currentMetadata.metadata
            });

            processAppendQueue();
        }
    };

    // FIX #3: Add onerror handler to catch WebSocket errors
    STATE.ws.onerror = (err) => {
        console.error("WebSocket Error:", err);
        // onclose will fire after onerror in most browsers
    };

    STATE.ws.onclose = (event) => {
        console.log("WebSocket Disconnected.");

        // Ignore a late close from an older socket after a replacement has
        // already connected; it must not clear the new socket's heartbeat.
        if (STATE.ws && STATE.ws !== socket) return;
        if (STATE.ws === socket) STATE.ws = null;
        if (STATE.heartbeatInterval) {
            clearInterval(STATE.heartbeatInterval);
            STATE.heartbeatInterval = null;
        }

        // --- CRITICAL FIX FOR 30M DISCONNECT ---
        // Release any pending chunk locks so they can be re-fetched after reconnect
        STATE.fetchingSet.clear();
        STATE.metadataQueue = [];
        STATE.sessionId++; // Invalidate pending responses from old connection
        STATE.isTransitioning = false; // FIX #6: Clear transitioning flag to unblock stall detector

        // A deliberate close (sleep timer, idle timeout, completed download)
        // must stay closed. Buffered chunks alone are not proof that playback
        // is active and previously caused endless background reconnects.
        if (socket._intentionalClose) {
            // We closed it (book switch, idle pause, finished download): that is
            // not a failure, so do not paint the warning state over "Loading…".
            const current = document.getElementById('status-indicator')?.innerText;
            if (!statusMatches(current, 'status-loading-meta')) setStatusKeepingStopReason(idleStatus());
            return;
        }

        // Another device pressed "Listen here": stop, and offer to take it back.
        if (event?.code === 4001) {
            STATE.wsRefusedAt = 0;
            STATE.socketParked = true;
            STATE.playIntentAt = 0;
            if (!audio.paused) audio.pause();
            document.getElementById('status-indicator').innerText = tr('status-taken-over', 'Playing on another device');
            setPlaybackElsewhere('taken');
            return;
        }

        // Another tab or device holds this account's only socket: reconnecting would just be refused again.
        // The strip above the console offers "Nghe ở đây"; it flashes when a Play tap is refused.
        if (event?.code === 1013) {
            STATE.wsRefusedAt = Date.now();
            document.getElementById('status-indicator').innerText = tr('status-conn-busy', 'Listening in another tab or device');
            setPlaybackElsewhere('busy', { flash: true });
            return;
        }

        if (STATE.isPlaying || STATE.isDownloading) {
            STATE.isStalled = false; // FIX #2: Reset isStalled so future reconnects work
            console.log("Unexpected disconnect, reconnecting in 3s...");
            document.getElementById('status-indicator').innerText = tr('status-reconnecting', 'Reconnecting…');
            setTimeout(() => {
                if (STATE.isPlaying || STATE.isDownloading) initWebSocket();
            }, 3000);

            // Force a prefetch check shortly after reconnect completes
            setTimeout(() => {
                if (STATE.isPlaying && STATE.currentBook && STATE.ws?.readyState === WebSocket.OPEN) {
                    // Start filling buffer heavily just like a jump
                    let lastChap = STATE.chunkTimings.length > 0 ? STATE.chunkTimings[STATE.chunkTimings.length - 1].chapterIndex : STATE.currentChapterIndex;
                    let lastIdx = STATE.chunkTimings.length > 0 ? STATE.chunkTimings[STATE.chunkTimings.length - 1].index : STATE.currentSentenceIndex;
                    console.log("Post-reconnect prefetch trigger...");
                    prefetchNext(lastChap, lastIdx, null, true);
                }
            }, 4000);
        } else {
            document.getElementById('status-indicator').innerText = tr('status-disconnected', 'Disconnected');
        }
    };
}

/**
 * Ensures the WebSocket is connected before proceeding.
 * If not connected, initiates connection and waits for the OPEN state.
 */
async function waitForWebSocket(isCancelled = null) {
    if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) return true;

    if (!STATE.ws || STATE.ws.readyState === WebSocket.CLOSED || STATE.ws.readyState === WebSocket.CLOSING) {
        console.warn("WebSocket not connected. Connecting...");
        document.getElementById('status-indicator').innerText = tr('status-connecting', 'Connecting…');
        initWebSocket();
    }

    return new Promise((resolve) => {
        const startTime = Date.now();
        const check = () => {
            if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
                resolve(true);
            } else if (STATE.wsRefusedAt >= startTime || isCancelled?.()) {
                resolve(false);
            } else if (Date.now() - startTime > 10000) {
                // Timeout after 10s
                console.error("WebSocket connection timeout.");
                resolve(false);
            } else {
                setTimeout(check, 100);
            }
        };
        check();
    });
}

function initMSE() {
    if (!('MediaSource' in window)) {
        console.error("MSE not supported");
        return;
    }

    STATE.mediaSource = new MediaSource();
    audio.src = URL.createObjectURL(STATE.mediaSource);

    STATE.mediaSource.addEventListener('sourceopen', () => {
        if (STATE.sourceBuffer) return;
        console.log("MediaSource opened");
        try {
            STATE.sourceBuffer = STATE.mediaSource.addSourceBuffer('audio/mpeg');
            STATE.sourceBuffer.addEventListener('updateend', () => {
                STATE.isAppending = false;

                // If this was the first chunk of a new session, sync the hardware clock
                if (STATE.pendingClockReset) {
                    audio.currentTime = 0;
                    STATE.pendingClockReset = false;
                    console.log("Hardware clock synced to 0 after first chunk append.");
                }

                processAppendQueue();

                // [CẬP NHẬT QUAN TRỌNG]: Chủ động gọi tải thêm chunk khi chạy nền
                // Đảm bảo lúc nào cũng có sẵn chunk dự trữ mà không cần chờ ontimeupdate
                if (STATE.chunkTimings.length > 0 && STATE.appendQueue.length < 3) {
                    const lastChunk = STATE.chunkTimings[STATE.chunkTimings.length - 1];
                    prefetchNext(lastChunk.chapterIndex, lastChunk.index);
                }
            });
            STATE.sourceBuffer.addEventListener('error', (e) => {
                console.error("SourceBuffer Error:", e);
                STATE.isAppending = false;
            });
        } catch (e) {
            console.error("Error adding SourceBuffer:", e);
        }
    });

    STATE.mediaSource.addEventListener('sourceclose', () => console.log("MediaSource closed"));
}

function ttsSpeed(speed = STATE.settings.speed) {
    return Math.min(TTS_MAX_SPEED, Math.max(TTS_MIN_SPEED, Number(speed) || 1));
}

function ttsRate() {
    const percent = Math.round((ttsSpeed() - 1) * 100);
    return `${percent >= 0 ? '+' : ''}${percent}%`;
}

function rateToSpeed(rate) {
    const percent = parseFloat(rate);
    return Number.isFinite(percent) ? 1 + percent / 100 : null;
}

function playbackFactor() {
    const speed = Number(STATE.settings.speed) || 1;
    return Math.max(1, speed / ttsSpeed(speed));
}

function chunkAt(time) {
    for (let i = STATE.chunkTimings.length - 1; i >= 0; i--) {
        if (time >= STATE.chunkTimings[i].startTime) return STATE.chunkTimings[i];
    }
    return STATE.chunkTimings[0] || null;
}

function applyPlaybackRate() {
    const speed = Number(STATE.settings.speed) || 1;
    const synthesized = chunkAt(audio.currentTime || 0)?.ttsSpeed || ttsSpeed(speed);
    const target = Math.min(MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, speed / synthesized));
    const next = Math.abs(target - 1) < 0.01 ? 1 : target;
    if (Math.abs(audio.playbackRate - next) > 0.005) {
        audio.preservesPitch = true;
        audio.playbackRate = next;
    }
}

function getBufferedAheadSeconds() {
    if (!STATE.sourceBuffer || !STATE.sourceBuffer.buffered.length) return 0;
    const currentTime = audio.currentTime || 0;
    const end = STATE.sourceBuffer.buffered.end(STATE.sourceBuffer.buffered.length - 1);
    return Math.max(0, end - currentTime);
}

function scheduleAppendRetry(delay = 500) {
    if (STATE.appendRetryTimeout) return;
    STATE.appendRetryTimeout = setTimeout(() => {
        STATE.appendRetryTimeout = null;
        processAppendQueue();
    }, delay);
}

function processAppendQueue() {
    if (!STATE.sourceBuffer || STATE.sourceBuffer.updating || STATE.appendQueue.length === 0 || STATE.isAppending || STATE.isTransitioning) return;

    // 1. Thay đổi logic sắp xếp: Ưu tiên Chapter trước, rồi mới tới Index
    STATE.appendQueue.sort((a, b) => {
        if (a.chapterIndex !== b.chapterIndex) return a.chapterIndex - b.chapterIndex;
        if (a.index !== b.index) return a.index - b.index;
        return (a.part || 0) - (b.part || 0);
    });

    // 2. Thay đổi logic tìm chunk dự kiến tiếp theo
    let expectedChap = STATE.lastAppendedChapter !== undefined ? STATE.lastAppendedChapter : STATE.currentChapterIndex;
    let expectedIdx = STATE.lastAppendedIndex + 1;

    // Nếu index vượt quá số câu của chương hiện tại -> nhảy sang câu số 0 của chương tiếp theo
    const expectedChapter = STATE.currentBook?.chapters[expectedChap];
    if (expectedChapter) {
        const sentenceCount = expectedChapter.count || expectedChapter.sentences?.length || 0;
        if (sentenceCount > 0 && expectedIdx >= sentenceCount) {
            expectedChap++;
            expectedIdx = 0;
        }
    }

    // A progressive sentence still being filled comes first: its next part is
    // expected, and later sentences wait until PREFETCH_DONE reports the count.
    let expectedPart = 0;
    const lastKey = `${STATE.lastAppendedChapter}_${STATE.lastAppendedIndex}`;
    if (STATE.lastAppendedPartKey === lastKey) {
        const totalParts = STATE.completedParts.get(lastKey);
        if (totalParts === undefined || STATE.lastAppendedPart + 1 < totalParts) {
            expectedChap = STATE.lastAppendedChapter;
            expectedIdx = STATE.lastAppendedIndex;
            expectedPart = STATE.lastAppendedPart + 1;
        }
    }

    // [HOTFIX] Discard any chunks that are older than our expected chunk to prevent queue blocking
    while (STATE.appendQueue.length > 0) {
        const check = STATE.appendQueue[0];
        if (check.chapterIndex < expectedChap || (check.chapterIndex === expectedChap && check.index < expectedIdx)
            || (check.chapterIndex === expectedChap && check.index === expectedIdx && (check.part || 0) < expectedPart)) {
            console.log(`Discarding obsolete/orphaned chunk ${check.chapterIndex}-${check.index} (Expected ${expectedChap}-${expectedIdx})`);
            STATE.appendQueue.shift();
        } else {
            break;
        }
    }

    if (STATE.appendQueue.length === 0) return;

    const chunkToCheck = STATE.appendQueue[0];
    if (chunkToCheck.chapterIndex !== expectedChap || chunkToCheck.index !== expectedIdx
        || (chunkToCheck.part || 0) !== expectedPart) {
        console.log(`Waiting for chunk ${expectedChap}-${expectedIdx}.${expectedPart} (Queue has ${chunkToCheck.chapterIndex}-${chunkToCheck.index}.${chunkToCheck.part || 0})`);
        return;
    }

    STATE.isAppending = true;
    const chunk = STATE.appendQueue.shift();

    // Stop extending the forward buffer before the browser reaches its
    // opaque SourceBuffer quota. The chunk stays queued and will be retried as
    // playback advances and frees room.
    if (getBufferedAheadSeconds() >= MAX_BUFFER_AHEAD_SECONDS * playbackFactor()) {
        STATE.appendQueue.unshift(chunk);
        STATE.isAppending = false;
        scheduleAppendRetry();
        return;
    }

    // [TASK 1: BUFFER CLEANUP] Before appending, check if we need to free space
    if (STATE.sourceBuffer.buffered.length > 0) {
        const playedEnd = audio.currentTime - 60; // Keep 60s of history
        if (playedEnd > 30) { // Only clean if we have at least 30s to remove
            try {
                const firstBufferedEnd = STATE.sourceBuffer.buffered.end(0);
                if (firstBufferedEnd < playedEnd) {
                    console.log(`[MSE] Cleaning up old buffer: 0 to ${playedEnd.toFixed(2)}s (Current: ${audio.currentTime.toFixed(2)}s)`);
                    STATE.isAppending = false; // Reset flag as we're aborting this append for now
                    STATE.appendQueue.unshift(chunk); // Put chunk back
                    STATE.sourceBuffer.remove(0, playedEnd);
                    // updateend listener will trigger processAppendQueue again
                    return;
                }
            } catch (err) {
                console.warn("Buffer cleanup failed:", err);
            }
        }
    }

    try {
        // Calculate start time for this chunk
        let startTime = 0;
        if (!STATE.isFirstChunkOfSession && STATE.sourceBuffer.buffered.length > 0) {
            const bufferEnd = STATE.sourceBuffer.buffered.end(STATE.sourceBuffer.buffered.length - 1);
            startTime = bufferEnd; // Mặc định là nối tiếp vào cuối buffer

            // [HACK FIX KHOẢNG LẶNG]: Dùng Metadata để cắt bỏ MP3 padding
            if (STATE.chunkTimings.length > 0) {
                const prevChunk = STATE.chunkTimings[STATE.chunkTimings.length - 1];
                if (prevChunk.metadata && prevChunk.metadata.length > 0) {
                    // Tìm từ cuối cùng của chunk trước
                    const lastWord = prevChunk.metadata[prevChunk.metadata.length - 1];
                    // Thời điểm thực tế AI ngừng phát âm
                    const exactSpeechEnd = prevChunk.startTime + lastWord.start + lastWord.duration;

                    // Gối đầu chunk mới đè lên khoảng lặng thừa. 
                    // Cộng thêm 0.1s tạo nhịp nghỉ siêu ngắn tự nhiên, tránh bị dính chữ.
                    startTime = Math.min(bufferEnd, exactSpeechEnd + 0.1);
                } else {
                    // Dự phòng nếu không có metadata: Lùi cứng 0.15s
                    startTime = Math.max(0, bufferEnd - 0.15);
                }
            }
        }

        if (STATE.isFirstChunkOfSession) {
            startTime = 0;
            STATE.isFirstChunkOfSession = false;
            STATE.pendingClockReset = true;
            console.log("First chunk of session, forcing startTime 0");
        }

        const chunkKey = `${chunk.chapterIndex}_${chunk.index}`;
        const sentenceTiming = STATE.chunkTimings[STATE.chunkTimings.length - 1];
        if (chunk.part > 0 && sentenceTiming && sentenceTiming.index === chunk.index
            && sentenceTiming.chapterIndex === chunk.chapterIndex) {
            // Later part of the same sentence: keep one timing entry per sentence
            // (next/prev/highlight rely on that) and shift the part's word
            // offsets onto the sentence's timeline.
            const shift = startTime - sentenceTiming.startTime;
            sentenceTiming.metadata = (sentenceTiming.metadata || []).concat(
                (chunk.metadata || []).map(w => ({ ...w, start: w.start + shift }))
            );
        } else {
            STATE.chunkTimings.push({
                index: chunk.index,
                chapterIndex: chunk.chapterIndex,
                startTime: startTime,
                ttsSpeed: chunk.ttsSpeed,
                metadata: chunk.metadata
            });
        }

        STATE.sourceBuffer.timestampOffset = startTime;
        STATE.sourceBuffer.appendBuffer(chunk.data);
        if (STATE.lastAppendedPartKey && STATE.lastAppendedPartKey !== chunkKey) {
            STATE.completedParts.delete(STATE.lastAppendedPartKey);
        }
        STATE.lastAppendedIndex = chunk.index;
        STATE.lastAppendedChapter = chunk.chapterIndex;
        STATE.lastAppendedPartKey = chunk.part !== undefined ? chunkKey : null;
        STATE.lastAppendedPart = chunk.part !== undefined ? chunk.part : -1;
        console.log(`Appended chunk ${chunk.index} (bytes: ${chunk.data.byteLength}) at ${startTime.toFixed(2)}s. Current audio time: ${audio.currentTime.toFixed(2)}s`);
    } catch (e) {
        if (e?.name === 'QuotaExceededError') {
            // appendQueue.shift() happens before appendBuffer(). Put the chunk
            // back so a quota event cannot silently lose the next sentence.
            STATE.appendQueue.unshift(chunk);
            STATE.isAppending = false;

            // Release played history immediately when possible. The normal
            // timeupdate cleanup is intentionally conservative, but a quota
            // event needs an immediate recovery path.
            if (audio.currentTime > BUFFER_HISTORY_SECONDS && !STATE.sourceBuffer.updating) {
                const removeEnd = audio.currentTime - BUFFER_HISTORY_SECONDS;
                try {
                    const firstStart = STATE.sourceBuffer.buffered.start(0);
                    if (removeEnd > firstStart) {
                        STATE.sourceBuffer.remove(0, removeEnd);
                        return;
                    }
                } catch (removeError) {
                    console.warn("SourceBuffer quota cleanup failed:", removeError);
                }
            }

            scheduleAppendRetry(1000);
            return;
        }

        console.error("Append error:", e);
        STATE.isAppending = false;
    }
}

initWebSocket();
initMSE();

// ── Image manifest + cover caches ───────────────────────────────────────────
// Every manifest/image read on the server is a billed storage call (shared
// daily cap), so Home must not re-read them on every visit:
// - manifests persist in IndexedDB per uid+bookId with the server ETag and the
//   progress doc's images_rev (written on every manifest save). A matching rev
//   is trusted without a request; anything else is revalidated by ETag;
// - lookups of many books go out together through POST /covers;
// - cover images persist in Cache Storage keyed by imageId + updatedAt.
const IMAGE_META_DB = 'cloud-tts-image-meta';
const IMAGE_META_STORE = 'manifests';
const COVER_CACHE_NAME = 'cloud-tts-covers-v1';
const COVER_CACHE_MAX_ENTRIES = 120;
// Books saved before images_rev existed: trust the stored copy this long.
const MANIFEST_UNVERSIONED_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MANIFEST_BATCH_DELAY_MS = 16;
const MANIFEST_BATCH_MAX = 100;

const imageMetaStore = {
    _db: null,
    open() {
        if (this._db) return this._db;
        this._db = new Promise(resolve => {
            try {
                const request = indexedDB.open(IMAGE_META_DB, 1);
                request.onupgradeneeded = () => request.result.createObjectStore(IMAGE_META_STORE);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => resolve(null);
                request.onblocked = () => resolve(null);
            } catch (_) {
                resolve(null);
            }
        });
        return this._db;
    },
    async run(mode, action) {
        const db = await this.open();
        if (!db) return null;
        return new Promise(resolve => {
            try {
                const tx = db.transaction(IMAGE_META_STORE, mode);
                const request = action(tx.objectStore(IMAGE_META_STORE));
                tx.oncomplete = () => resolve(request?.result ?? null);
                tx.onerror = tx.onabort = () => resolve(null);
            } catch (_) {
                resolve(null);
            }
        });
    },
    get(key) { return this.run('readonly', store => store.get(key)); },
    put(key, value) { return this.run('readwrite', store => store.put(value, key)); },
    delete(key) { return this.run('readwrite', store => store.delete(key)); }
};

const manifestPending = new Map();
const manifestBatch = { jobs: new Map(), timer: null };

function emptyImageManifest(extra = {}) {
    return { version: 1, coverId: null, images: [], _found: false, ...extra };
}

function manifestMetaKey(uid, bookId) {
    return `${uid}/${bookId}`;
}

function storedManifestIsFresh(stored, rev) {
    if (!stored?.manifest) return false;
    if (rev) return stored.rev === rev;
    return !stored.rev && Date.now() - (stored.savedAt || 0) < MANIFEST_UNVERSIONED_MAX_AGE_MS;
}

function normalizeImageManifest(manifest, found, storageBackend) {
    const normalized = {
        version: 1,
        coverId: null,
        images: [],
        _storageBackend: storageBackend || 'unknown',
        _found: found,
        ...manifest
    };
    if (!Array.isArray(normalized.images) || normalized.images.some(image => !image || typeof image.id !== 'string' || !image.id.trim())) {
        throw new Error('Image manifest has an invalid images list');
    }
    return normalized;
}

async function loadImageManifest(bookId) {
    if (!STATE.user || !bookId) return emptyImageManifest();
    if (STATE.imageManifestCache.has(bookId)) return STATE.imageManifestCache.get(bookId);
    const uid = STATE.user.uid;
    const pendingKey = manifestMetaKey(uid, bookId);
    if (manifestPending.has(pendingKey)) return manifestPending.get(pendingKey);
    const pending = fetchImageManifest(uid, bookId).finally(() => manifestPending.delete(pendingKey));
    manifestPending.set(pendingKey, pending);
    return pending;
}

async function fetchImageManifest(uid, bookId) {
    const remember = manifest => {
        if (STATE.user?.uid === uid) STATE.imageManifestCache.set(bookId, manifest);
        return manifest;
    };
    const rev = findLibraryEntry(bookId)?.imagesRev || null;
    const metaKey = manifestMetaKey(uid, bookId);
    const stored = await imageMetaStore.get(metaKey);
    if (storedManifestIsFresh(stored, rev)) return remember(stored.manifest);

    const item = await requestManifestBatched(uid, bookId, stored?.manifest ? stored.etag : null);
    if (item.error) {
        console.warn('[Images] Manifest lookup warning for book', bookId, ':', item.error);
        // Server/network failures are retried later; other failures read as "no images".
        if (item.retryable) return emptyImageManifest({ _error: item.error, _storageBackend: item.backend, _retryable: true });
        return remember(emptyImageManifest());
    }
    let manifest;
    try {
        manifest = item.notModified && stored?.manifest
            ? stored.manifest
            : normalizeImageManifest(item.manifest || {}, item.found === true, item.backend);
    } catch (err) {
        console.warn('[Images] Manifest lookup warning for book', bookId, ':', err.message);
        return remember(emptyImageManifest());
    }
    void imageMetaStore.put(metaKey, { manifest, etag: item.etag || null, rev, savedAt: Date.now() });
    return remember(manifest);
}

function requestManifestBatched(uid, bookId, etag) {
    return new Promise(resolve => {
        const key = manifestMetaKey(uid, bookId);
        const existing = manifestBatch.jobs.get(key);
        if (existing) existing.resolvers.push(resolve);
        else manifestBatch.jobs.set(key, { uid, bookId, etag, resolvers: [resolve] });
        manifestBatch.timer ||= setTimeout(flushManifestBatch, MANIFEST_BATCH_DELAY_MS);
    });
}

async function flushManifestBatch() {
    const jobs = [...manifestBatch.jobs.values()];
    manifestBatch.jobs.clear();
    manifestBatch.timer = null;
    const settle = (job, item) => job.resolvers.forEach(resolve => resolve(item));
    const byUid = new Map();
    jobs.forEach(job => {
        if (!byUid.has(job.uid)) byUid.set(job.uid, []);
        byUid.get(job.uid).push(job);
    });
    for (const [uid, group] of byUid) {
        if (STATE.user?.uid !== uid) {
            group.forEach(job => settle(job, { error: 'Account changed', retryable: true }));
            continue;
        }
        for (let i = 0; i < group.length; i += MANIFEST_BATCH_MAX) {
            const chunk = group.slice(i, i + MANIFEST_BATCH_MAX);
            const etags = {};
            chunk.forEach(job => { if (job.etag) etags[job.bookId] = job.etag; });
            try {
                const response = await authFetch(`/api/stories/${encodeURIComponent(uid)}/covers`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ bookIds: chunk.map(job => job.bookId), etags }),
                    retries: 1
                });
                const backend = response.headers.get('X-Storage-Backend') || 'unknown';
                if (!response.ok) {
                    console.warn(`[Images] Covers HTTP ${response.status} (storage backend: ${backend})`);
                    chunk.forEach(job => settle(job, { error: `HTTP ${response.status}`, retryable: response.status >= 500, backend }));
                    continue;
                }
                const books = (await response.json())?.books || {};
                chunk.forEach(job => settle(job, books[job.bookId]
                    ? { ...books[job.bookId], backend }
                    : { error: 'Missing from covers response', retryable: true, backend }));
            } catch (err) {
                chunk.forEach(job => settle(job, { error: err.message, retryable: true }));
            }
        }
    }
}

// Drop every cached copy of a book's manifest (and optionally its cover files).
function forgetImageManifest(bookId, { covers = false } = {}) {
    STATE.imageManifestCache.delete(bookId);
    if (!STATE.user) return;
    void imageMetaStore.delete(manifestMetaKey(STATE.user.uid, bookId));
    if (covers) void forgetCachedCovers(STATE.user.uid, bookId);
}

async function saveImageManifest(bookId, manifest, progressFields = null) {
    const uid = STATE.user.uid;
    const response = await authFetch(`/api/stories/${encodeURIComponent(uid)}/${encodeURIComponent(bookId)}/images/manifest`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(manifest)
    });
    if (!response.ok) throw new Error(tr('img-manifest-save-failed', 'Không lưu được danh sách ảnh ({status})', { status: response.status }));
    const etag = (await response.json().catch(() => null))?.etag || response.headers.get('ETag') || null;
    STATE.imageManifestCache.set(bookId, manifest);
    // images_rev tells this account's other devices that their stored manifest is stale.
    const rev = etag || `t${Date.now()}`;
    const entry = findLibraryEntry(bookId);
    if (entry) {
        entry.imagesRev = rev;
        entry.data.images_rev = rev;
        if (progressFields && 'has_images' in progressFields) entry.hasImages = progressFields.has_images === true;
    }
    void imageMetaStore.put(manifestMetaKey(uid, bookId), { manifest: { ...manifest }, etag, rev, savedAt: Date.now() });
    try {
        await setDoc(doc(db, 'users', uid, 'progress', bookId), { ...(progressFields || {}), images_rev: rev }, { merge: true });
    } catch (err) {
        if (progressFields) throw err;
        console.warn('[Images] images_rev not saved:', err.message);
    }
}

function coverCacheKey(uid, bookId, image) {
    const version = image.updatedAt || image.createdAt || '';
    return `/__cover-cache/${encodeURIComponent(uid)}/${encodeURIComponent(bookId)}/${encodeURIComponent(image.id)}?v=${encodeURIComponent(version)}`;
}

async function openCoverCache() {
    try {
        return 'caches' in window ? await caches.open(COVER_CACHE_NAME) : null;
    } catch (_) {
        return null;
    }
}

async function readCachedCover(uid, bookId, image) {
    const cache = await openCoverCache();
    if (!cache) return null;
    try {
        const hit = await cache.match(coverCacheKey(uid, bookId, image));
        return hit ? await hit.blob() : null;
    } catch (_) {
        return null;
    }
}

async function storeCachedCover(uid, bookId, image, blob) {
    const cache = await openCoverCache();
    if (!cache) return;
    try {
        const key = coverCacheKey(uid, bookId, image);
        const sameImage = key.slice(0, key.indexOf('?'));
        const keys = await cache.keys();
        // Older versions of this image, then the oldest entries past the cap.
        const stale = keys.filter(request => {
            const url = new URL(request.url);
            return url.pathname === sameImage && `${url.pathname}${url.search}` !== key;
        });
        const overflow = Math.max(0, keys.length - stale.length + 1 - COVER_CACHE_MAX_ENTRIES);
        const oldest = keys.filter(request => !stale.includes(request)).slice(0, overflow);
        await Promise.all([...stale, ...oldest].map(request => cache.delete(request)));
        await cache.put(key, new Response(blob, { headers: { 'Content-Type': blob.type || 'image/webp' } }));
    } catch (err) {
        console.debug('[Images] Cover cache write skipped:', err.message);
    }
}

async function forgetCachedCovers(uid, bookId, imageId = null) {
    const cache = await openCoverCache();
    if (!cache) return;
    try {
        const prefix = `/__cover-cache/${encodeURIComponent(uid)}/${encodeURIComponent(bookId)}/${imageId ? `${encodeURIComponent(imageId)}` : ''}`;
        const keys = await cache.keys();
        await Promise.all(keys
            .filter(request => {
                const path = new URL(request.url).pathname;
                return imageId ? path === prefix : path.startsWith(prefix);
            })
            .map(request => cache.delete(request)));
    } catch (_) { /* best effort */ }
}

async function uploadBookImages(bookId, files, bookTitle = '') {
    if (!STATE.user || !bookId || !files?.length) return null;
    // Start from the book's stored manifest so images added from the
    // library (book not open) keep the ones already there.
    const manifest = STATE.currentBookId === bookId && STATE.imageManifest?.images
        ? STATE.imageManifest
        : await loadImageManifest(bookId);
    if (manifest._retryable) throw new Error(tr('img-manifest-retry', 'Không đọc được danh sách ảnh hiện có. Hãy thử lại sau.'));
    const totalFiles = files.length;
    for (let idx = 0; idx < totalFiles; idx++) {
        const sourceFile = files[idx];
        const basePercent = (idx / totalFiles) * 100;
        const fileWeight = (1 / totalFiles) * 100;

        const step = { n: idx + 1, total: totalFiles };
        updateLoadingProgress(
            basePercent + fileWeight * 0.2,
            tr('img-processing', 'Đang xử lý ảnh ({n}/{total})', step),
            tr('img-compressing', 'Nén {name}...', { name: sourceFile.name }),
            tr('img-processing-step', 'Xử lý ảnh {n}/{total}', step)
        );

        const file = await compressImageForStorage(sourceFile, {
            onProgress: (passPercent) => {
                updateLoadingProgress(
                    basePercent + fileWeight * (passPercent / 100 * 0.4),
                    tr('img-processing', 'Đang xử lý ảnh ({n}/{total})', step),
                    tr('img-optimizing', 'Tối ưu dung lượng {name}...', { name: sourceFile.name })
                );
            }
        });
        if (file.size > IMAGE_MAX_BYTES) throw new Error(tr('img-too-large', '{name} vượt quá 150 KB sau tối ưu.', { name: sourceFile.name }));

        updateLoadingProgress(
            basePercent + fileWeight * 0.65,
            tr('img-uploading', 'Đang tải lên ảnh ({n}/{total})', step),
            tr('img-uploading-file', 'Đang tải {name} lên đám mây...', { name: sourceFile.name }),
            tr('img-uploading-step', 'Tải lên {n}/{total}', step)
        );

        const imageId = `img_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
        const formData = new FormData();
        formData.append('imageId', imageId);
        formData.append('file', file, `${imageId}.webp`);
        const response = await authFetch(`/api/stories/${encodeURIComponent(STATE.user.uid)}/${encodeURIComponent(bookId)}/images`, {
            method: 'POST',
            body: formData
        });
        if (!response.ok) throw new Error(tr('img-upload-failed', 'Tải ảnh lên thất bại ({status})', { status: response.status }));
        manifest.images.push({
            id: imageId,
            path: `users/${STATE.user.uid}/images/${bookId}/assets/${imageId}.webp`,
            chapterIndex: null,
            alt: sourceFile.name.replace(/\.[^.]+$/, ''),
            size: file.size,
            createdAt: new Date().toISOString()
        });
        if (!manifest.coverId) manifest.coverId = imageId;

        updateLoadingProgress(
            ((idx + 1) / totalFiles) * 100,
            tr('img-done', 'Đã xong ảnh {n}/{total}', step),
            tr('img-done-file', 'Hoàn tất {name}', { name: sourceFile.name })
        );
    }
    await saveImageManifest(bookId, manifest, { has_images: manifest.images.length > 0 });
    if (bookId === STATE.currentBookId) STATE.imageManifest = manifest;
    releaseImageURLs();
    return manifest;
}

// persist: covers only. They are read from / written to the Cache Storage
// cover cache so a later visit does not download them again.
async function getImageURL(bookId, image, { persist = false } = {}) {
    if (!image?.id) return null;
    if (STATE.imageURLCache.has(image.id)) {
        const cached = STATE.imageURLCache.get(image.id);
        // Re-insert so the least recently used URLs are trimmed first.
        STATE.imageURLCache.delete(image.id);
        STATE.imageURLCache.set(image.id, cached);
        return cached;
    }
    const uid = STATE.user?.uid;
    if (!uid) return null;
    try {
        let blob = persist ? await readCachedCover(uid, bookId, image) : null;
        if (!blob) {
            const version = image.updatedAt || image.createdAt || '';
            const query = version ? `?v=${encodeURIComponent(version)}` : '';
            const response = await authFetch(`/api/stories/${encodeURIComponent(uid)}/${encodeURIComponent(bookId)}/images/${encodeURIComponent(image.id)}${query}`);
            if (!response.ok) {
                const storageBackend = response.headers.get('X-Storage-Backend') || 'unknown';
                throw new Error(`Image HTTP ${response.status} (backend: ${storageBackend})`);
            }
            blob = await response.blob();
            if (persist) void storeCachedCover(uid, bookId, image, blob);
        }
        if (STATE.user?.uid !== uid) return null;
        // A concurrent request for the same image may have finished first.
        if (STATE.imageURLCache.has(image.id)) return STATE.imageURLCache.get(image.id);
        const url = URL.createObjectURL(blob);
        rememberImageURL(image.id, url);
        return url;
    } catch (err) {
        console.warn('[Images] Cannot load image:', image.id, 'for book:', bookId, err.message);
        return null;
    }
}

async function saveBookImageCrop(bookId, imageId, crop, sourceWidth, sourceHeight) {
    const manifest = await loadImageManifest(bookId);
    const image = manifest.images.find(item => item.id === imageId);
    if (!image) throw new Error(tr('image-missing', 'Ảnh không còn tồn tại.'));
    image.coverCrop = {
        x: crop.x / sourceWidth,
        y: crop.y / sourceHeight,
        width: crop.width / sourceWidth,
        height: crop.height / sourceHeight
    };
    image.updatedAt = new Date().toISOString();
    await saveImageManifest(bookId, manifest);
    if (bookId === STATE.currentBookId) STATE.imageManifest = manifest;
}

async function replaceBookImage(bookId, imageId, sourceFile, { cropSquare, crop } = {}) {
    const manifest = await loadImageManifest(bookId);
    const image = manifest.images.find(item => item.id === imageId);
    if (!image) throw new Error(tr('image-missing', 'Ảnh không còn tồn tại.'));
    const file = await compressImageForStorage(sourceFile, { cropSquare: cropSquare ?? false, crop });
    const formData = new FormData();
    formData.append('file', file, `${imageId}.webp`);
    const response = await authFetch(`/api/stories/${encodeURIComponent(STATE.user.uid)}/${encodeURIComponent(bookId)}/images/${encodeURIComponent(imageId)}`, {
        method: 'PUT',
        body: formData
    });
    if (!response.ok) throw new Error(`Image replace failed (${response.status})`);
    image.alt = sourceFile.name.replace(/\.[^.]+$/, '');
    image.size = file.size;
    image.updatedAt = new Date().toISOString();
    await saveImageManifest(bookId, manifest);
    if (bookId === STATE.currentBookId) STATE.imageManifest = manifest;
    releaseImageURL(imageId);
    void forgetCachedCovers(STATE.user.uid, bookId, imageId);
}

async function removeBookImage(bookId, imageId) {
    const manifest = await loadImageManifest(bookId);
    if (!manifest.images.some(item => item.id === imageId)) return;
    const response = await authFetch(`/api/stories/${encodeURIComponent(STATE.user.uid)}/${encodeURIComponent(bookId)}/images/${encodeURIComponent(imageId)}`, { method: 'DELETE' });
    if (!response.ok) throw new Error(`Image delete failed (${response.status})`);
    manifest.images = manifest.images.filter(item => item.id !== imageId);
    if (manifest.coverId === imageId) manifest.coverId = manifest.images[0]?.id || null;
    await saveImageManifest(bookId, manifest, { has_images: manifest.images.length > 0 });
    if (bookId === STATE.currentBookId) STATE.imageManifest = manifest;
    releaseImageURL(imageId);
    void forgetCachedCovers(STATE.user.uid, bookId, imageId);
}

async function setBookCover(bookId, imageId) {
    const manifest = await loadImageManifest(bookId);
    const image = manifest.images.find(item => item.id === imageId);
    if (!image) throw new Error(tr('image-missing', 'Ảnh không còn tồn tại.'));
    manifest.coverId = imageId;
    manifest.images.forEach(image => { image.role = image.id === imageId ? 'cover' : 'illustration'; });
    await saveImageManifest(bookId, manifest);
    if (bookId === STATE.currentBookId) STATE.imageManifest = manifest;
}

function imageManagerButton(label, onClick, { danger = false, disabled = false, title = '', act = '' } = {}) {
    const button = document.createElement('button');
    button.type = 'button';
    if (act) button.dataset.act = act;
    button.className = danger ? 'btn btn--danger' : 'btn';
    button.textContent = label;
    button.disabled = disabled;
    if (title) button.title = title;
    if (onClick) button.addEventListener('click', onClick);
    return button;
}

// While the image manager is open its list is the confirmation (silent
// success); toasts there would cover the rows' buttons on phones.
function announceImageChange(message) {
    const status = document.getElementById('image-manager-status');
    const isOpen = !document.getElementById('image-manager-modal')?.classList.contains('hidden');
    if (status && isOpen) {
        status.textContent = message;
        return;
    }
    APP_STATUS.toast(message, 'success');
}

async function afterImageChange(message) {
    await renderImageManager();
    await refreshLibrary();
    if (message) announceImageChange(message);
}

// Rebuilding the list drops the focused row button; put focus back on the same
// action of the same image (or its neighbour) so keyboard users stay inside the dialog.
let imageManagerFocusHint = null;

function rememberImageManagerFocus(imageId, act) {
    const rows = [...document.querySelectorAll('#image-manager-list .img-row')];
    imageManagerFocusHint = { imageId, act, index: rows.findIndex(row => row.dataset.imageId === imageId) };
}

function restoreImageManagerFocus(list) {
    const hint = imageManagerFocusHint;
    imageManagerFocusHint = null;
    if (!hint || document.getElementById('image-manager-modal')?.classList.contains('hidden')) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected && !list.contains(active)) return;
    const rows = [...list.querySelectorAll('.img-row')];
    const row = rows.find(r => r.dataset.imageId === hint.imageId)
        || rows[Math.min(Math.max(hint.index, 0), rows.length - 1)];
    const target = row
        ? (row.querySelector(`[data-act="${hint.act}"]:not(:disabled)`) || row.querySelector('button:not(:disabled)'))
        : document.getElementById('image-manager-add-btn');
    target?.focus();
}

async function renderImageManager() {
    const list = document.getElementById('image-manager-list');
    const title = document.getElementById('image-manager-book-title');
    const bookId = imageManagerBookId || STATE.currentBookId;
    if (!list || !bookId) return;
    const focusedAct = document.activeElement?.closest?.('#image-manager-list .img-row [data-act]');
    if (focusedAct) {
        rememberImageManagerFocus(focusedAct.closest('.img-row').dataset.imageId, focusedAct.dataset.act);
    }

    if (!list.children.length) {
        list.innerHTML = '<div class="img-skeleton"></div><div class="img-skeleton"></div>';
    }

    const manifest = await loadImageManifest(bookId);
    if (bookId === STATE.currentBookId) STATE.imageManifest = manifest;
    const images = manifest.images.filter(image => !pendingImageDeletes.has(imageDeleteKey(bookId, image.id)));
    const bookTitle = displayTitle(imageManagerBookTitle || STATE.currentBook?.title) || tr('current-book', 'Truyện hiện tại');
    if (title) title.textContent = `${bookTitle} · ${tr(images.length === 1 ? 'image-count-one' : 'image-count', '{count} ảnh', { count: images.length })}`;
    list.replaceChildren();
    if (!images.length) {
        const empty = document.createElement('div');
        empty.className = 'img-empty';
        const line1 = document.createElement('p');
        line1.textContent = tr('images-empty', 'Truyện chưa có ảnh.');
        const line2 = document.createElement('p');
        line2.textContent = tr('images-empty-hint', 'Bấm “Thêm ảnh” để thêm bìa hoặc tranh minh hoạ.');
        empty.append(line1, line2);
        list.append(empty);
        restoreImageManagerFocus(list);
        return;
    }
    const effectiveCoverId = (images.find(image => image.id === manifest.coverId) || images[0])?.id;
    for (const image of images) {
        const isCover = effectiveCoverId === image.id;
        const row = document.createElement('div');
        row.className = 'img-row';
        row.dataset.imageId = image.id;
        const thumb = document.createElement('img');
        thumb.className = 'img-row__thumb';
        thumb.alt = image.alt || tr('illustration', 'Ảnh minh hoạ');
        thumb.loading = 'lazy';
        thumb.decoding = 'async';
        void getImageURL(bookId, image).then(url => { thumb.src = url || '/static/icon.svg'; });
        const info = document.createElement('div');
        info.className = 'img-row__info';
        const name = document.createElement('span');
        name.className = 'img-row__name';
        name.textContent = image.alt || tr('illustration', 'Ảnh minh hoạ');
        const meta = document.createElement('span');
        meta.className = 'img-row__meta';
        meta.textContent = `${Math.round((image.size || 0) / 1024)} KB`;
        info.append(name, meta);
        if (isCover) {
            const badge = document.createElement('span');
            badge.className = 'img-row__badge';
            badge.textContent = tr('cover-badge', 'Bìa');
            info.append(badge);
        }
        const actions = document.createElement('div');
        actions.className = 'img-row__acts';
        // The cover row shows its "Bìa" badge and offers "Căn bìa"; other rows offer "Đặt bìa".
        const coverBtn = isCover ? null : imageManagerButton(tr('set-cover', 'Đặt bìa'), async () => {
            rememberImageManagerFocus(image.id, 'cover');
            setButtonLoading(coverBtn, true, '…');
            try {
                await setBookCover(bookId, image.id);
                await afterImageChange(tr('cover-set-done', 'Đã đặt làm ảnh bìa.'));
            } catch (err) {
                APP_STATUS.error(err, tr('set-cover-failed', 'Không thể đặt ảnh bìa'));
                imageManagerFocusHint = null;
            } finally {
                setButtonLoading(coverBtn, false);
            }
        }, { act: 'cover' });
        const cropBtn = isCover ? imageManagerButton(tr('crop-title', 'Căn bìa'), () => openImageCropper(bookId, image),
            { title: tr('crop-hint', 'Kéo ảnh để chọn vùng hiện trên bìa. Ảnh gốc không bị cắt.'), act: 'crop' }) : null;
        const replaceBtn = imageManagerButton(tr('replace-image', 'Thay'), () => {
            STATE.imageEditTargetId = image.id;
            rememberImageManagerFocus(image.id, 'replace');
            imageInput?.click();
        }, { act: 'replace' });
        const deleteBtn = imageManagerButton(tr('delete', 'Xoá'), () => {
            rememberImageManagerFocus(image.id, 'delete');
            scheduleImageDelete(bookId, image);
        }, { danger: true, act: 'delete' });
        actions.append(...[coverBtn, cropBtn, replaceBtn, deleteBtn].filter(Boolean));
        row.append(thumb, info, actions);
        list.append(row);
    }
    restoreImageManagerFocus(list);
}


function imageDeleteKey(bookId, imageId) {
    return `${bookId}::${imageId}`;
}

function scheduleImageDelete(bookId, image) {
    const key = imageDeleteKey(bookId, image.id);
    if (!STATE.user || pendingImageDeletes.has(key)) return;
    const uid = STATE.user.uid;
    const commit = () => {
        if (!pendingImageDeletes.has(key)) return;
        clearTimeout(pendingImageDeletes.get(key));
        pendingImageDeletes.delete(key);
        imageDeleteChain = imageDeleteChain.then(async () => {
            if (STATE.user?.uid !== uid) return;
            try {
                await removeBookImage(bookId, image.id);
                await afterImageChange('');
            } catch (err) {
                APP_STATUS.error(err, tr('image-delete-failed', 'Không thể xoá ảnh'));
                void renderImageManager();
            }
        });
    };
    pendingImageDeletes.set(key, null);
    void renderImageManager();
    const name = image.alt || tr('illustration', 'Ảnh minh hoạ');
    const undoToast = APP_STATUS.toast(tr('image-deleted-undo', 'Đã xoá ảnh “{name}”.', { name: escapeHTML(name) }), 'info', {
        duration: TOAST_ACTION_MS,
        onExpire: commit,
        action: {
            label: tr('undo', 'Hoàn tác'),
            onClick: () => {
                if (!pendingImageDeletes.has(key)) return;
                clearTimeout(pendingImageDeletes.get(key));
                pendingImageDeletes.delete(key);
                imageManagerFocusHint = { imageId: image.id, act: 'delete', index: -1 };
                void renderImageManager();
            }
        }
    });
    if (!undoToast) pendingImageDeletes.set(key, setTimeout(commit, TOAST_ACTION_MS));
}

async function openImageManager(bookId = STATE.currentBookId, bookTitle = STATE.currentBook?.title || '') {
    if (!bookId) {
        APP_STATUS.toast(tr('open-book-first', 'Hãy mở một truyện trước.'), 'warning');
        return;
    }
    if (imageManagerBookId !== bookId) document.getElementById('image-manager-list')?.replaceChildren();
    imageManagerBookId = bookId;
    imageManagerBookTitle = bookTitle;
    setModalVisibility('image-manager-modal', true);
    try { await renderImageManager(); } catch (err) {
        console.error('[Images] Manager load error:', err);
        APP_STATUS.error(tr('images-list-failed', 'Không thể tải danh sách ảnh: {error}', { error: err.message }));
    }
}

function getProgressSaveFailureMessage(error) {
    const code = String(error?.code || '').replace(/^firestore\//, '');
    const messages = {
        'permission-denied': 'Firestore từ chối quyền ghi tiến độ.',
        unauthenticated: 'Phiên đăng nhập đã hết hạn; hãy đăng nhập lại.',
        unavailable: 'Firestore tạm thời không khả dụng.',
        'deadline-exceeded': 'Firestore phản hồi quá lâu.',
        'resource-exhausted': 'Firestore đang quá tải hoặc đã chạm giới hạn.',
        'network-request-failed': 'Không thể kết nối tới Firestore.',
        NETWORK_TIMEOUT: 'Kết nối Firestore bị quá thời gian chờ.'
    };
    return messages[code] || error?.message || 'Không thể lưu tiến độ lên Firestore.';
}

function isRetryableProgressSaveError(error) {
    const code = String(error?.code || '').replace(/^firestore\//, '');
    // Permission/auth failures will not recover by retrying. Network and
    // transient Firestore failures should retain the snapshot and retry.
    return !['permission-denied', 'unauthenticated', 'invalid-argument', 'not-found'].includes(code);
}

function scheduleProgressSaveRetry(snapshot, version, error, attempt = 0) {
    if (version !== STATE.progressSaveVersion || !isRetryableProgressSaveError(error)) return;

    const retryAttempt = attempt + 1;
    const delayMs = Math.min(30_000 * (2 ** Math.min(retryAttempt - 1, 4)), 5 * 60_000);
    STATE.pendingProgressRetry = { snapshot, version, attempt: retryAttempt };
    if (STATE.progressRetryTimer) clearTimeout(STATE.progressRetryTimer);
    STATE.progressRetryTimer = setTimeout(retryPendingProgressSaveNow, delayMs);
    console.warn('[Progress] Save retained for retry', {
        bookId: snapshot.bookId,
        chunk: snapshot.currentGlobalIndex,
        retryAttempt,
        delayMs,
        code: error?.code,
        message: error?.message
    });
}

function enqueueProgressSnapshot(snapshot, version, retryAttempt = 0) {
    const firestore = db;
    const write = async () => {
        if (!firestore) return false;
        try {
            const progressRef = doc(firestore, 'users', snapshot.userId, 'progress', snapshot.bookId);
            await setDoc(progressRef, {
                title: snapshot.title,
                filename: snapshot.filename,
                last_read_chunk: snapshot.currentGlobalIndex,
                total_chunks: snapshot.totalChunks,
                last_listened_at: serverTimestamp(),
                updated_at: serverTimestamp()
            }, { merge: true });

            if (STATE.currentBookId === snapshot.bookId && version === STATE.progressSaveVersion) {
                STATE.lastSavedChunkIndex = snapshot.currentGlobalIndex;
                STATE.pendingProgressRetry = null;
                STATE.lastProgressSaveError = null;
                if (STATE.progressRetryTimer) clearTimeout(STATE.progressRetryTimer);
                STATE.progressRetryTimer = null;
            }
            console.log(`Progress synced to Firestore (v2) at chunk ${snapshot.currentGlobalIndex}`);
            return true;
        } catch (err) {
            const failure = {
                code: err?.code || 'unknown',
                message: err?.message || String(err),
                bookId: snapshot.bookId,
                chunk: snapshot.currentGlobalIndex,
                retryAttempt
            };
            STATE.lastProgressSaveError = failure;
            console.error('[Progress] Firestore save failed', failure, err);
            if (version === STATE.progressSaveVersion) {
                APP_STATUS.error(new Error(`${getProgressSaveFailureMessage(err)} Tiến độ được giữ lại${isRetryableProgressSaveError(err) ? ' và sẽ tự thử lại.' : '.'}`));
                scheduleProgressSaveRetry(snapshot, version, err, retryAttempt);
            }
            return false;
        }
    };

    const queuedWrite = STATE.progressSaveChain.then(write, write);
    STATE.progressSaveChain = queuedWrite.catch(() => { });
    return queuedWrite;
}

function retryPendingProgressSaveNow() {
    const pending = STATE.pendingProgressRetry;
    STATE.progressRetryTimer = null;
    if (!pending || pending.version !== STATE.progressSaveVersion) return;
    if (!navigator.onLine) {
        scheduleProgressSaveRetry(pending.snapshot, pending.version, { code: 'network-request-failed' }, pending.attempt);
        return;
    }
    void enqueueProgressSnapshot(pending.snapshot, pending.version, pending.attempt);
}

async function saveProgress(force = false) {
    if (!STATE.user || !STATE.currentBookId) return false;

    // Capture the complete snapshot before any asynchronous work starts. A
    // previous implementation read STATE again after awaiting Firestore,
    // which allowed a stale load/playback operation to write the new book's
    // position.
    const currentGlobalIndex = getGlobalIndex(STATE.currentChapterIndex, STATE.currentSentenceIndex);
    const isFirstSave = STATE.lastSavedChunkIndex === -1;
    if (!force && !isFirstSave && Math.abs(currentGlobalIndex - STATE.lastSavedChunkIndex) < 10) {
        console.log(`Skipping Firestore sync (Batching): Current ${currentGlobalIndex}, Last Saved ${STATE.lastSavedChunkIndex}`);
        return true;
    }

    const snapshot = {
        userId: STATE.user.uid,
        bookId: STATE.currentBookId,
        title: STATE.currentBook?.title || '',
        filename: STATE.currentFilename,
        currentGlobalIndex,
        totalChunks: getTotalChunks()
    };
    const version = ++STATE.progressSaveVersion;
    // A newer snapshot supersedes a queued retry for this document.
    STATE.pendingProgressRetry = null;
    if (STATE.progressRetryTimer) clearTimeout(STATE.progressRetryTimer);
    STATE.progressRetryTimer = null;
    return enqueueProgressSnapshot(snapshot, version);
}

async function loadProgress(bookId) {
    if (!STATE.user) throw new Error('Authentication required to load reading progress');
    try {
        const progressRef = doc(db, "users", STATE.user.uid, "progress", bookId);
        const docSnap = await promiseWithTimeout(getDoc(progressRef), 15_000, 'Firestore reading progress');
        if (docSnap.exists()) {
            const progress = docSnap.data();
            console.info('[Progress] Loaded', {
                bookId,
                hasTitle: typeof progress.title === 'string' && progress.title.trim().length > 0,
                lastReadChunk: progress.last_read_chunk,
                hasSettings: !!progress.settings
            });
            return progress;
        }
        console.info('[Progress] No saved document for', bookId);
    } catch (err) {
        console.error("Load Progress Error:", err);
        // A failed read is not equivalent to an empty document. Let the load
        // abort instead of resetting to chapter 0 and overwriting valid data.
        throw err;
    }
    return null;
}

function hasSavedProgressCursor(progress) {
    const rawCursor = progress?.last_read_chunk;
    return rawCursor !== undefined && rawCursor !== null && rawCursor !== ''
        && Number.isFinite(Number(rawCursor)) && Number(rawCursor) >= 0;
}

function hasBookProgressIdentity(progress) {
    if (!progress) return false;
    if (Object.prototype.hasOwnProperty.call(progress, 'last_read_chunk')) {
        return hasSavedProgressCursor(progress);
    }
    const title = typeof progress.title === 'string' ? progress.title.trim() : '';
    const filename = typeof progress.filename === 'string' ? progress.filename.trim() : '';
    return Boolean(title && filename);
}

function getProgressPercent(progress) {
    const current = Number(progress?.last_read_chunk);
    const total = Number(progress?.total_chunks);
    if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return 0;
    return Math.max(0, Math.min(100, current / total * 100));
}

function getTotalChunks() {
    if (!STATE.currentBook) return 0;
    // --- FIX BUG 2: Use precomputed total for segmented/metadata-only books ---
    if (STATE.currentBook._totalChunks) return STATE.currentBook._totalChunks;
    return STATE.currentBook.chapters.reduce((acc, chap) => acc + (chap.count || (chap.sentences && chap.sentences.length) || 0), 0);
}

function getGlobalIndex(chapIdx, sentIdx) {
    if (!STATE.currentBook) return 0;
    const counts = STATE.currentBook._chapterCounts;
    let total = 0;
    for (let i = 0; i < chapIdx; i++) {
        if (counts && counts[i] !== undefined) {
            total += counts[i];
        } else {
            const chap = STATE.currentBook.chapters[i];
            total += chap ? (chap.count || (chap.sentences && chap.sentences.length) || 0) : 0;
        }
    }
    return total + sentIdx;
}

function getLocalIndices(globalIdx) {
    if (!STATE.currentBook) return { chapterIndex: 0, sentenceIndex: 0 };
    const counts = STATE.currentBook._chapterCounts;
    let remaining = Number(globalIdx);
    if (!Number.isFinite(remaining) || remaining < 0) {
        return { chapterIndex: 0, sentenceIndex: 0 };
    }
    let lastNonEmptyChapter = -1;
    let lastNonEmptyLength = 0;
    for (let i = 0; i < STATE.currentBook.chapters.length; i++) {
        const chap = STATE.currentBook.chapters[i];
        const len = (counts && counts[i] !== undefined)
            ? counts[i]
            : (chap ? (chap.count || (chap.sentences && chap.sentences.length) || 0) : 0);
        if (len > 0) {
            lastNonEmptyChapter = i;
            lastNonEmptyLength = len;
        }
        if (remaining < len) {
            return { chapterIndex: i, sentenceIndex: remaining };
        }
        remaining -= len;
    }
    // Old records may contain the total count instead of the last zero-based
    // index. Clamp such records to the last sentence rather than restarting
    // the book from chapter 0.
    if (lastNonEmptyChapter >= 0) {
        return { chapterIndex: lastNonEmptyChapter, sentenceIndex: lastNonEmptyLength - 1 };
    }
    return { chapterIndex: 0, sentenceIndex: 0 };
}

async function refreshLibrary() {
    if (!STATE.user) {
        if (window.APP_STATUS?.toast) {
            window.APP_STATUS.toast(tr('sync-sign-in-required', 'Vui lòng đăng nhập để đồng bộ thư viện đám mây.'), 'info');
        }
        return;
    }
    const libraryUid = STATE.user.uid;
    const refreshId = ++libraryView.refreshSeq;
    libraryView.status = 'loading';
    document.getElementById('book-list')?.setAttribute('aria-busy', 'true');
    document.getElementById('discovery-grid')?.setAttribute('aria-busy', 'true');
    applyLibraryFilters();

    try {
        const q = query(collection(db, "users", libraryUid, "progress"));
        const querySnapshot = await getDocs(q);
        // Offline, getDocs resolves from the (empty) memory cache instead of
        // failing; that must not read as an empty library.
        if (querySnapshot.metadata.fromCache) throw new Error('Firestore is offline');
        // A newer refresh or an account switch owns the views now.
        if (STATE.user?.uid !== libraryUid || refreshId !== libraryView.refreshSeq) return;

        const entries = [];
        querySnapshot.forEach((docSnap) => {
            const data = docSnap.data();
            const bookId = docSnap.id;
            if (pendingBookDeletes.has(bookId)) return;
            const filename = data.filename || (bookId.replace('book_', '') + '.txt');
            if (!hasBookProgressIdentity({ ...data, filename })) {
                console.warn('[Progress] Skipping incomplete library document', {
                    bookId,
                    fields: Object.keys(data)
                });
                return;
            }
            data.filename = filename;
            data.title = typeof data.title === 'string' && data.title.trim()
                ? data.title.trim()
                : filename;
            entries.push(createLibraryEntry(bookId, data));
        });

        // Default order: most recently listened first; books never listened
        // to (no last_listened_at) follow in Vietnamese alphabetical order.
        entries.sort(byRecency);
        // While the reader is open, rows keep their places (new books on top),
        // so the list never jumps under the cursor; Home re-sorts by recency.
        if (document.body.dataset.view === 'reader' && discoveryLibrary.length) {
            const previous = new Map(discoveryLibrary.map((entry, i) => [entry.id, i]));
            entries.sort((a, b) => (previous.get(a.id) ?? -1) - (previous.get(b.id) ?? -1));
            libraryView.orderFrozen = true;
        }

        discoveryLibrary = entries;
        libraryView.status = 'ready';
        libraryView.syncedAt = Date.now();
        // Covers are re-derived from the cached manifests/URLs, so a cover
        // change made in the image manager shows up after this refresh.
        coverPrevious = new Map(STATE.coverResolved);
        coverPrevious.liveURLs = new Set(STATE.imageURLCache.values());
        STATE.coverResolved.clear();
        try {
            if (!STATE.currentBookId) toggleDiscoveryMode(true);
            renderLibraryViews();
        } finally {
            coverPrevious = null;
        }
    } catch (err) {
        if (STATE.user?.uid !== libraryUid || refreshId !== libraryView.refreshSeq) return;
        console.error("Library Refresh Error:", err);
        libraryView.status = 'error';
        renderLibraryViews();
    }
}

/** Download the canonical source TXT for a book. The backend handles master
 * files and segmented-book reconstruction so the browser never assembles JSON
 * segments in memory. */
async function downloadTextBook(bookId, title = 'book', triggerBtn = null) {
    if (!STATE.user || !bookId) {
        APP_STATUS.toast(tr('export-sign-in', 'Vui lòng đăng nhập để tải sách về máy.'), 'warning');
        return;
    }

    const btn = triggerBtn || (bookId === STATE.currentBookId ? document.getElementById('toc-download-txt-btn') : null);
    if (btn) setButtonLoading(btn, true, tr('preparing', 'Đang chuẩn bị...'));

    const status = document.getElementById('status-indicator');
    const previousStatus = status?.innerText || tr('status-ready', 'Ready');
    if (status) status.innerText = tr('status-txt-preparing', 'Preparing TXT…');
    APP_STATUS.toast(tr('export-starting', 'Đang xuất file TXT toàn bộ tác phẩm...'), 'info');

    let succeeded = false;
    try {
        const response = await authFetch(`/api/stories/${encodeURIComponent(STATE.user.uid)}/${encodeURIComponent(bookId)}/export-text`);

        if (!response.ok) {
            let message = tr('txt-unavailable', 'Không tải được file TXT.');
            try {
                const errorData = await response.json();
                if (errorData.error) message = errorData.error;
            } catch (_) { /* Keep the friendly fallback message. */ }
            throw new Error(message);
        }

        const blob = await response.blob();
        const disposition = response.headers.get('Content-Disposition') || '';
        const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
        const filename = encodedName
            ? decodeURIComponent(encodedName)
            : `${String(title || 'book').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}.txt`;
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename.toLowerCase().endsWith('.txt') ? filename : `${filename}.txt`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        if (status) status.innerText = tr('status-txt-started', 'TXT download started');
        APP_STATUS.toast(tr('export-done', 'Đã tải xuống file "{name}" thành công!', { name: filename }), 'success');
        succeeded = true;
    } catch (err) {
        console.error('[Export TXT]', err);
        APP_STATUS.error(tr('export-failed', 'Không thể tải file TXT: {error}', { error: err.message }));
        if (status) status.innerText = tr('status-txt-failed', 'TXT download failed');
    } finally {
        if (btn) {
            setButtonLoading(btn, false);
            if (succeeded) flashButtonSuccess(btn);
        }
        setTimeout(() => {
            if (status && statusMatches(status.innerText, 'status-txt-started', 'status-txt-failed')) {
                status.innerText = previousStatus || tr('status-ready', 'Ready');
            }
        }, 2500);
    }
}

// ── Feature 1: Delete Book ───────────────────────────────────────────────────

// Optimistic delete: the book leaves the lists now, a toast offers "Hoàn tác"
// for a few seconds, and only then is the cloud data removed. Leaving the page
// inside that window keeps the book (nothing was deleted yet).
async function deleteBook(bookId, filename, title, bypassConfirm = false) {
    closeAllKebabMenus(); // close menu first
    if (bypassConfirm) return commitDeleteBook(bookId, filename, title);
    if (!STATE.user || pendingBookDeletes.has(bookId)) return;

    const index = discoveryLibrary.findIndex(entry => entry.id === bookId);
    const removed = index >= 0 ? discoveryLibrary.splice(index, 1)[0] : null;
    if (STATE.currentBookId === bookId && !audio.paused) audio.pause();
    renderLibraryViews();

    const uid = STATE.user.uid;
    const commit = () => {
        if (!pendingBookDeletes.has(bookId)) return;
        clearTimeout(pendingBookDeletes.get(bookId));
        pendingBookDeletes.delete(bookId);
        if (STATE.user?.uid !== uid) return;
        void commitDeleteBook(bookId, filename, title);
    };
    pendingBookDeletes.set(bookId, null);

    const undoToast = APP_STATUS.toast(tr('book-deleted-undo', 'Đã xoá “{title}”.', { title: escapeHTML(displayTitle(title)) }), 'info', {
        duration: BOOK_DELETE_UNDO_MS,
        onExpire: commit,
        action: {
            label: tr('undo', 'Hoàn tác'),
            onClick: () => {
                if (!pendingBookDeletes.has(bookId)) return;
                clearTimeout(pendingBookDeletes.get(bookId));
                pendingBookDeletes.delete(bookId);
                if (removed && !findLibraryEntry(bookId)) {
                    discoveryLibrary.splice(Math.min(index, discoveryLibrary.length), 0, removed);
                    renderLibraryViews();
                }
                const control = [...document.querySelectorAll(`[data-book-id="${CSS.escape(bookId)}"] :is([data-action="toggle"], [data-action="open"])`)]
                    .find(el => el.getClientRects().length);
                requestAnimationFrame(() => control?.focus({ preventScroll: true }));
            }
        }
    });
    if (!undoToast) pendingBookDeletes.set(bookId, setTimeout(commit, BOOK_DELETE_UNDO_MS));
}

async function commitDeleteBook(bookId, filename, title) {
    if (!STATE.user) return;

    APP_STATUS.set(tr('status-deleting', 'Đang xóa...'));

    try {
        // Storage first: on failure the progress doc stays, so the book is still listed and the delete can be retried.
        const storageQuery = filename ? `?filename=${encodeURIComponent(filename)}` : '';
        const response = await authFetch(`/api/stories/${encodeURIComponent(STATE.user.uid)}/${encodeURIComponent(bookId)}/storage${storageQuery}`, { method: 'DELETE' });
        if (!response.ok) throw new Error(tr('delete-storage-failed', 'Không xóa được dữ liệu lưu trữ (lỗi {status}). Truyện vẫn còn, hãy thử lại sau.', { status: response.status }));
        await deleteDoc(doc(db, 'users', STATE.user.uid, 'progress', bookId));
        forgetImageManifest(bookId, { covers: true });
        console.log(`[Delete] "${title}" deleted successfully.`);

        const focusSnapshot = snapshotLibraryFocus();
        if (STATE.currentBookId === bookId) {
            await handlePlaybackStall(); // This handles WS close, RAM/ROM clear, and UI reset
            closeCurrentBook();
        }

        await refreshLibrary();
        restoreLibraryFocus(focusSnapshot);
        APP_STATUS.set(tr('status-deleted', 'Đã xóa!'));
        setTimeout(() => APP_STATUS.set(tr('status-ready', 'Ready')), 2500);

    } catch (err) {
        console.error('[Delete] Error:', err);
        APP_STATUS.error(tr('delete-failed', 'Xóa thất bại: {reason}', { reason: err?.message || err }));
        setTimeout(() => APP_STATUS.set(tr('status-ready', 'Ready')), 3000);
        // The row was hidden optimistically; bring it back.
        void refreshLibrary();
    }
}

function closeCurrentBook() {
    STATE.currentBook = null;
    STATE.currentBookId = null;
    STATE.currentFilename = null;
    STATE.currentChapterIndex = 0;
    STATE.currentSentenceIndex = 0;
    document.getElementById('current-title').innerText = tr('select-masterpiece', 'Select a Masterpiece');
    document.getElementById('current-chapter').innerText = tr('standby-mode', 'Standby Mode');
    textContainer.replaceChildren(...(readerEmptyTemplate ? [readerEmptyTemplate.cloneNode(true)] : []));
    document.getElementById('minimap-nodes')?.replaceChildren();
    document.getElementById('edit-title-btn').classList.add('hidden');
    const playerTitle = document.getElementById('player-title');
    const playerAuthor = document.getElementById('player-author');
    if (playerTitle) { playerTitle.innerText = tr('system-ready', 'Ready'); playerTitle.title = ''; }
    if (playerAuthor) { playerAuthor.innerText = 'NOVA'; playerAuthor.title = ''; }
    paintPlayerArt();
    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = 'none';
    }
    renderTOC();
    updateUI();
    toggleDiscoveryMode(true);
}

// ── Feature 2: Merge Chapter File ────────────────────────────────────────────

let mergeSession = null;

function renderMergeChapter() {
    if (!mergeSession) return;
    const { chapters, activeIndex } = mergeSession;
    const chapter = chapters[activeIndex];
    document.getElementById('merge-chapter-position').innerText = tr('merge-position', 'Chương {current}/{total}', { current: activeIndex + 1, total: chapters.length });
    document.getElementById('merge-chapter-textarea').value = chapter.content;
    document.getElementById('merge-include-chapter').checked = chapter.included;
    document.getElementById('merge-prev-btn').disabled = activeIndex === 0;
    document.getElementById('merge-next-btn').disabled = activeIndex === chapters.length - 1;
}

function saveMergeDraft() {
    if (!mergeSession) return;
    const chapter = mergeSession.chapters[mergeSession.activeIndex];
    chapter.content = document.getElementById('merge-chapter-textarea').value;
    chapter.included = document.getElementById('merge-include-chapter').checked;
}

function closeMergeModal() {
    mergeSession = null;
    setModalVisibility('merge-chapters-modal', false);
}

async function mergeChapterFile(event, bookId, bookData) {
    const newFile = event.target.files[0];
    event.target.value = '';
    if (!newFile || !STATE.user) return;
    const filename = bookData.filename || (bookId.replace('book_', '') + '.txt');
    APP_STATUS.set(tr('merge-parsing', 'Đang phân tích chương...'));
    try {
        const formData = new FormData();
        formData.append('userId', STATE.user.uid);
        formData.append('file', newFile);
        const response = await authFetch('/api/parse-import', { method: 'POST', body: formData });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Không thể phân tích file.');
        mergeSession = {
            bookId, filename, activeIndex: 0,
            chapters: data.chapters.map(chapter => ({ ...chapter, included: true }))
        };
        renderMergeChapter();
        setModalVisibility('merge-chapters-modal', true);
        APP_STATUS.set(tr('status-ready', 'Sẵn sàng'));
    } catch (error) {
        console.error('[Merge preview] Error:', error);
        APP_STATUS.error(error, tr('merge-preview-failed', 'Không thể mở bản xem trước nối chương.'));
    }
}

let imageCropSession = null;

function renderImageCropPreview() {
    const preview = document.getElementById('image-crop-preview');
    const stage = document.getElementById('image-crop-stage');
    const zoomValue = document.getElementById('image-crop-zoom-value');
    if (!imageCropSession || !preview || !stage) return;
    const stageWidth = stage.clientWidth;
    const stageHeight = stage.clientHeight;
    const { width, height, scale, offsetX, offsetY, baseScale } = imageCropSession;
    preview.style.width = `${width}px`;
    preview.style.height = `${height}px`;
    preview.style.transform = `translate(-50%, -50%) translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
    if (zoomValue) zoomValue.textContent = `${Math.round(scale / baseScale * 100)}%`;
    imageCropSession.stageWidth = stageWidth;
    imageCropSession.stageHeight = stageHeight;
    paintCropPreviews();
}

// The two small covers show the crop exactly as the list (40×56) and grid will.
function paintCropPreviews() {
    if (!imageCropSession) return;
    const area = getImageCropArea();
    const { width, height, objectURL } = imageCropSession;
    if (!area || !width || !height) return;
    const crop = { x: area.x / width, y: area.y / height, width: area.width / width, height: area.height / height };
    ['image-crop-thumb', 'image-crop-card'].forEach(id => {
        const box = document.getElementById(id);
        const img = box?.querySelector('img');
        if (!box || !img) return;
        const paint = () => {
            applyCoverCrop(img, box, crop);
            box.dataset.coverStatus = 'loaded';
        };
        if (img.getAttribute('src') !== objectURL) {
            img.onload = paint;
            img.src = objectURL;
        } else if (img.complete && img.naturalWidth) {
            paint();
        }
    });
}

function clampImageCropPosition() {
    if (!imageCropSession) return;
    const { width, height, scale, stageWidth, stageHeight } = imageCropSession;
    const maxX = Math.max(0, (width * scale - stageWidth) / 2);
    const maxY = Math.max(0, (height * scale - stageHeight) / 2);
    imageCropSession.offsetX = Math.max(-maxX, Math.min(maxX, imageCropSession.offsetX));
    imageCropSession.offsetY = Math.max(-maxY, Math.min(maxY, imageCropSession.offsetY));
}

function closeImageCropper() {
    ['image-crop-thumb', 'image-crop-card'].forEach(id => {
        const img = document.getElementById(id)?.querySelector('img');
        if (img) { img.onload = null; img.removeAttribute('src'); img.removeAttribute('style'); }
    });
    if (imageCropSession?.objectURL) URL.revokeObjectURL(imageCropSession.objectURL);
    imageCropSession = null;
    setModalVisibility('image-crop-modal', false);
}

async function openImageCropper(bookId, image) {
    try {
        const sourceURL = await getImageURL(bookId, image);
        if (!sourceURL) throw new Error(tr('crop-load-failed', 'Không thể tải ảnh để crop.'));
        const sourceBlob = await fetch(sourceURL).then(response => {
            if (!response.ok) throw new Error(tr('crop-fetch-failed', 'Không thể tải ảnh ({status}).', { status: response.status }));
            return response.blob();
        });
        const sourceFile = new File([sourceBlob], `${image.alt || 'image'}.webp`, { type: sourceBlob.type || 'image/webp' });
        const objectURL = URL.createObjectURL(sourceFile);
        const preview = document.getElementById('image-crop-preview');
        const stage = document.getElementById('image-crop-stage');
        const zoom = document.getElementById('image-crop-zoom');
        if (!preview || !stage || !zoom) throw new Error(tr('crop-tool-missing', 'Không thể mở công cụ crop.'));

        preview.src = objectURL;
        await preview.decode();
        setModalVisibility('image-crop-modal', true);
        await new Promise(resolve => requestAnimationFrame(resolve));
        const stageWidth = stage.clientWidth;
        const stageHeight = stage.clientHeight;
        const width = preview.naturalWidth;
        const height = preview.naturalHeight;
        const baseScale = Math.max(stageWidth / width, stageHeight / height);
        imageCropSession = {
            bookId, imageId: image.id, sourceFile, objectURL, width, height,
            stageWidth, stageHeight, baseScale, scale: baseScale, offsetX: 0, offsetY: 0
        };
        zoom.value = '1';
        renderImageCropPreview();
    } catch (err) {
        console.error('[Images] Crop open error:', err);
        APP_STATUS.error(tr('crop-open-failed', 'Không thể mở crop: {error}', { error: err.message }));
    }
}

function getImageCropArea() {
    if (!imageCropSession) return null;
    const { width, height, scale, offsetX, offsetY, stageWidth, stageHeight } = imageCropSession;
    const cropWidth = stageWidth / scale;
    const cropHeight = stageHeight / scale;
    return {
        x: Math.max(0, Math.min(width - cropWidth, width / 2 - cropWidth / 2 - offsetX / scale)),
        y: Math.max(0, Math.min(height - cropHeight, height / 2 - cropHeight / 2 - offsetY / scale)),
        width: cropWidth,
        height: cropHeight
    };
}

const cropStage = document.getElementById('image-crop-stage');
const cropZoom = document.getElementById('image-crop-zoom');
let cropDrag = null;
cropZoom?.addEventListener('input', () => {
    if (!imageCropSession) return;
    imageCropSession.scale = imageCropSession.baseScale * Number(cropZoom.value);
    clampImageCropPosition();
    renderImageCropPreview();
});
cropStage?.addEventListener('pointerdown', event => {
    if (!imageCropSession) return;
    cropDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, offsetX: imageCropSession.offsetX, offsetY: imageCropSession.offsetY };
    cropStage.setPointerCapture(event.pointerId);
});
cropStage?.addEventListener('pointermove', event => {
    if (!imageCropSession || !cropDrag || event.pointerId !== cropDrag.pointerId) return;
    imageCropSession.offsetX = cropDrag.offsetX + event.clientX - cropDrag.x;
    imageCropSession.offsetY = cropDrag.offsetY + event.clientY - cropDrag.y;
    clampImageCropPosition();
    renderImageCropPreview();
});
const endCropDrag = event => {
    if (!cropDrag || event.pointerId !== cropDrag.pointerId) return;
    cropDrag = null;
};
cropStage?.addEventListener('pointerup', endCropDrag);
// Keyboard crop: arrows move 2% of the frame (Shift: 10%), + / − zoom.
cropStage?.addEventListener('keydown', event => {
    if (!imageCropSession || !cropZoom) return;
    const step = (event.shiftKey ? 0.1 : 0.02);
    const moves = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
    if (event.key in moves) {
        const [dx, dy] = moves[event.key];
        imageCropSession.offsetX += dx * step * imageCropSession.stageWidth;
        imageCropSession.offsetY += dy * step * imageCropSession.stageHeight;
    } else if (event.key === '+' || event.key === '=' || event.key === '-' || event.key === '_') {
        const delta = (event.key === '-' || event.key === '_') ? -0.1 : 0.1;
        const next = Math.min(Number(cropZoom.max), Math.max(Number(cropZoom.min), Number(cropZoom.value) + delta));
        cropZoom.value = String(next);
        paintRange(cropZoom);
        imageCropSession.scale = imageCropSession.baseScale * next;
    } else {
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    clampImageCropPosition();
    renderImageCropPreview();
    const status = document.getElementById('image-crop-status');
    if (status) status.textContent = tr('crop-zoom-status', 'Phóng {v}', { v: document.getElementById('image-crop-zoom-value')?.textContent || '' });
});
cropStage?.addEventListener('pointercancel', endCropDrag);
document.querySelectorAll('[data-close-image-crop]').forEach(element => element.addEventListener('click', closeImageCropper));
document.getElementById('close-image-crop-btn')?.addEventListener('click', closeImageCropper);
document.getElementById('cancel-image-crop-btn')?.addEventListener('click', closeImageCropper);
document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && imageCropSession) closeImageCropper();
});
document.getElementById('save-image-crop-btn')?.addEventListener('click', async event => {
    if (!imageCropSession) return;
    const button = event.currentTarget;
    const session = imageCropSession;
    const crop = getImageCropArea();
    try {
        button.disabled = true;
        button.textContent = tr('saving', 'Đang lưu…');
        await saveBookImageCrop(session.bookId, session.imageId, crop, session.width, session.height);
        closeImageCropper();
        await renderImageManager();
        await refreshLibrary();
        announceImageChange(tr('crop-saved', 'Đã lưu vùng bìa.'));
    } catch (err) {
        console.error('[Images] Crop save error:', err);
        APP_STATUS.error(tr('crop-save-failed', 'Không thể lưu crop: {error}', { error: err.message }));
    } finally {
        button.disabled = false;
        button.textContent = tr('crop-save', 'Lưu vùng bìa');
    }
});

async function confirmMergeChapters() {
    if (!mergeSession || !STATE.user) return;
    saveMergeDraft();
    const chapters = mergeSession.chapters.filter(chapter => chapter.included && chapter.content.trim());
    if (!chapters.length) {
        APP_STATUS.toast(tr('merge-select-one', 'Hãy chọn ít nhất một chương có nội dung.'));
        return;
    }
    const button = document.getElementById('confirm-merge-btn');
    setButtonLoading(button, true, tr('merging', 'Đang nối chương...'));
    APP_STATUS.set(tr('merging-count', 'Đang nối {count} chương...', { count: chapters.length }));
    try {
        const response = await authFetch('/api/append-chapters', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: STATE.user.uid,
                bookId: mergeSession.bookId,
                filename: mergeSession.filename,
                chapters: chapters
            })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const errorMsg = data.error || (Array.isArray(data.detail) ? data.detail.map(d => d.msg).join(', ') : data.detail) || 'Không thể nối chương.';
            throw new Error(errorMsg);
        }

        const { bookId, filename } = mergeSession;
        STATE.libraryTocCache.delete(bookId);
        const returnTarget = modalReturnFocus.get('merge-chapters-modal');
        closeMergeModal();

        // Fetch fresh metadata from backend to sync total chunks and state
        const metaRes = await authFetch(`/api/stories/${encodeURIComponent(STATE.user.uid)}/${encodeURIComponent(bookId)}/metadata`);
        if (metaRes.ok) {
            const bookInfo = await metaRes.json();
            let totalChunks = 0;
            if (bookInfo.chapterCounts && Array.isArray(bookInfo.chapterCounts)) {
                totalChunks = bookInfo.chapterCounts.reduce((sum, c) => sum + (c || 0), 0);
            } else if (bookInfo.chaptersSummary && Array.isArray(bookInfo.chaptersSummary)) {
                totalChunks = bookInfo.chaptersSummary.reduce((sum, c) => sum + (c?.count || 0), 0);
            } else if (Array.isArray(data)) {
                totalChunks = data.reduce((sum, c) => sum + (c?.count || 0), 0);
            }

            if (totalChunks > 0) {
                await setDoc(doc(db, 'users', STATE.user.uid, 'progress', bookId), { total_chunks: totalChunks }, { merge: true });
            }

            if (!bookInfo.isSegmented && bookInfo.chaptersSummary) {
                bookInfo.chapters = bookInfo.chaptersSummary.map(ch => ({
                    title: ch.title,
                    count: ch.count,
                    sentences: null
                }));
            }

            if (STATE.currentBookId === bookId) {
                await loadBook(bookInfo, bookId, filename);
            }
        }

        await refreshLibrary();
        returnFocusTo(returnTarget);
        APP_STATUS.set(tr('merge-status-done', 'Nối chương thành công'));
        APP_STATUS.toast(tr('merge-done', 'Đã nối {count} chương thành công.', { count: chapters.length }), 'success');
    } catch (error) {
        console.error('[Merge save] Error:', error);
        APP_STATUS.error(error, tr('merge-failed', 'Nối chương thất bại; bạn có thể thử lại.'));
    } finally {
        setButtonLoading(button, false);
    }
}

document.getElementById('merge-prev-btn')?.addEventListener('click', () => {
    saveMergeDraft();
    mergeSession.activeIndex -= 1;
    renderMergeChapter();
});
document.getElementById('merge-next-btn')?.addEventListener('click', () => {
    saveMergeDraft();
    mergeSession.activeIndex += 1;
    renderMergeChapter();
});
document.getElementById('close-merge-modal')?.addEventListener('click', closeMergeModal);
document.getElementById('cancel-merge-btn')?.addEventListener('click', closeMergeModal);
document.getElementById('confirm-merge-btn')?.addEventListener('click', confirmMergeChapters);

async function loadBookFromStorage(bookId, bookData) {
    STATE.loadController?.abort();
    const loadController = new AbortController();
    STATE.loadController = loadController;
    const selectionGeneration = ++STATE.selectionGeneration;
    const isCurrentSelection = () => selectionGeneration === STATE.selectionGeneration;
    const markLoad = createLoadTrace(bookId);
    markLoad('start');
    // Close sidebar immediately on selection
    toggleSidebar(false);

    showLoading(tr('status-opening-book', 'Opening {title}…', { title: displayTitle(bookData.title) }));
    document.getElementById('status-indicator').innerText = tr('status-loading-meta', 'Loading book info…');
    const currentTitleEl = document.getElementById('current-title');
    currentTitleEl.innerText = tr('status-opening-book', 'Opening {title}…', { title: displayTitle(bookData.title) });
    currentTitleEl.title = displayTitle(bookData.title);

    try {
        // Check if book is segmented in the new stories collection
        const storyRef = doc(db, "users", STATE.user.uid, "stories", bookId);
        const storySnap = await promiseWithTimeout(getDoc(storyRef), 15_000, 'Firestore story metadata');
        if (!isCurrentSelection()) return;
        markLoad('metadata');

        let bookInfo = null;
        if (storySnap.exists()) {
            bookInfo = storySnap.data();
            console.log("Found segmented story info:", bookInfo);
        }

        const hasUsableSegmentedMetadata = Boolean(
            bookInfo?.isSegmented === true &&
            typeof bookInfo.filename === 'string' && bookInfo.filename.trim() &&
            Number.isInteger(Number(bookInfo.totalChapters)) && Number(bookInfo.totalChapters) > 0 &&
            Number.isInteger(Number(bookInfo.segmentsCount)) && Number(bookInfo.segmentsCount) > 0
        );
        if (bookInfo?.isSegmented && !hasUsableSegmentedMetadata) {
            console.warn('[Storage] Ignoring incomplete segmented metadata', {
                bookId,
                fields: Object.keys(bookInfo)
            });
            bookInfo = null;
        }

        if (hasUsableSegmentedMetadata) {
            // Segmented Load Flow
            const loaded = await loadBook(bookInfo, bookId, bookInfo.filename, bookData);
            if (!loaded) return;
        } else {
            // A story document is authoritative for the object key. Progress
            // documents predate B2 and can retain an old filename after a
            // rename/migration; using it here can fetch another object's key.
            const progressFilename = bookData.filename;
            const filename = bookInfo?.filename || progressFilename || (bookId.replace("book_", "") + ".txt");
            console.info('[Storage identity] Loading master file', {
                bookId,
                storyFilename: bookInfo?.filename || null,
                progressFilename: progressFilename || null,
                selectedFilename: filename,
                objectKey: `users/${STATE.user.uid}/files/${filename}`
            });
            // The server parses the stored file itself; downloading it here only
            // to upload it back to /api/parse-book cost seconds on every open.
            const parseRes = await authFetch(`/api/stories/${encodeURIComponent(STATE.user.uid)}/${encodeURIComponent(bookId)}/parsed?filename=${encodeURIComponent(filename)}`, {
                signal: loadController.signal,
                timeoutMs: 60_000
            });
            if (!isCurrentSelection()) return;
            markLoad('legacy_file');
            if (!parseRes.ok) throw new Error(`Parse book HTTP ${parseRes.status}`);
            const data = await parseRes.json();
            if (!isCurrentSelection()) return;
            markLoad('legacy_parse');

            const loaded = await loadBook(data, bookId, filename, bookData);
            if (!loaded) return;
            // Legacy books use the bounded disk-backed chapter cache. Do not
            // start a RAM-heavy full-book migration while the reader is active;
            // migration remains available as an explicit backend operation.
        }
        markLoad('first_render');
        document.getElementById('status-indicator').innerText = tr('status-ready', 'Ready');
        markLoad('ready');

        // Older segmented stories were written as 100-chapter unversioned
        // objects. Queue their conversion after first paint; the current
        // session keeps using the compatible legacy metadata until the next
        // open, so migration never blocks reading.
        const oldSegmentLayout = bookInfo?.isSegmented && (
            Number(bookInfo.segmentFormatVersion || 0) < 2 ||
            Number(bookInfo.segmentSize || 0) !== 50
        );
        if (oldSegmentLayout && bookInfo.filename) {
            const migrationParams = new URLSearchParams({ filename: bookInfo.filename });
            void authFetch(
                `/api/stories/${encodeURIComponent(STATE.user.uid)}/${encodeURIComponent(bookId)}/migrate?${migrationParams}`,
                { method: 'POST', timeoutMs: 10_000, retries: 0 }
            ).then(response => {
                if (response.status === 202) {
                    console.info('[Segmentation] Legacy story migration queued', bookId);
                } else if (response.ok) {
                    console.info('[Segmentation] Story already uses the 50-chapter layout', bookId);
                } else {
                    console.debug('[Segmentation] Migration unavailable:', response.status);
                }
            }).catch(err => console.debug('[Segmentation] Migration deferred:', err.message));
        }
    } catch (err) {
        if (err?.name === 'AbortError' || loadController.signal.aborted) return;
        console.error("Load from Storage Error:", err);
        if (isCurrentSelection()) endReaderOpening({ failed: true });
        APP_STATUS.error(err?.userFacing
            ? err.message
            : tr('book-load-failed', 'Không thể tải sách từ bộ nhớ. Hãy kiểm tra file có còn tồn tại.'));
    } finally {
        if (STATE.loadController === loadController) {
            STATE.loadController = null;
            hideLoading();
        }
    }
}

// --- Auth state is now handled inside startFirebase() ---

// --- File Handling ---
const IMPORT_JOB_POLL_MS = 2_000;
const IMPORT_JOB_MAX_WAIT_MS = 15 * 60_000;

async function waitForImportJob(uid, jobId) {
    const deadline = Date.now() + IMPORT_JOB_MAX_WAIT_MS;
    let lastError = null;
    while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, IMPORT_JOB_POLL_MS));
        let response;
        try {
            response = await authFetch(`/api/import-jobs/${encodeURIComponent(jobId)}?userId=${encodeURIComponent(uid)}`, { timeoutMs: 15_000 });
        } catch (error) {
            // A dropped poll does not mean the import failed; keep asking.
            lastError = error;
            continue;
        }
        if (response.status === 404) {
            throw userFacingError(tr('import-job-lost', 'Máy chủ đã khởi động lại giữa chừng. Hãy kiểm tra thư viện, nếu chưa có truyện thì tải lên lại.'));
        }
        if (!response.ok) {
            lastError = new Error(`HTTP ${response.status}`);
            continue;
        }
        const job = await response.json();
        if (job.status === 'done') return job.result;
        if (job.status === 'failed') throw userFacingError(job.error || tr('import-failed', 'Không thể import sách.'));
    }
    throw lastError || userFacingError(tr('import-job-slow', 'Máy chủ vẫn đang xử lý. Truyện sẽ tự xuất hiện trong thư viện khi xong.'));
}

const handleFileUpload = async (e) => {
    const selectedFiles = Array.from(e.target.files || []);
    const file = selectedFiles.find(candidate => /\.(txt|epub|pdf)$/i.test(candidate.name));
    const includeImages = STATE.uploadImagesChoice;
    STATE.uploadImagesChoice = false;
    if (!file) {
        APP_STATUS.toast(tr('import-pick-book-file', 'Hãy chọn file .txt, .epub hoặc .pdf cho truyện.'));
        e.target.value = '';
        return;
    }

    if (!/\.(txt|epub|pdf)$/i.test(file.name)) {
        APP_STATUS.toast(tr('import-unsupported', 'Chỉ hỗ trợ file .txt, .epub hoặc .pdf.'));
        e.target.value = '';
        return;
    }
    if (file.size === 0) {
        APP_STATUS.toast(tr('import-empty-file', 'File đang trống. Vui lòng chọn file có nội dung.'), 'warning');
        e.target.value = '';
        return;
    }
    if (file.size > 25 * 1024 * 1024) {
        APP_STATUS.toast(tr('import-too-large', 'File vượt quá giới hạn 25 MB. Hãy chia nhỏ nội dung trước khi tải lên.'), 'warning');
        e.target.value = '';
        return;
    }

    if (!STATE.user) {
        APP_STATUS.toast(tr('import-sign-in', 'Vui lòng đăng nhập trước khi tải sách lên.'), 'warning');
        return;
    }

    const illustrations = includeImages ? selectedFiles.filter(candidate => candidate !== file) : [];
    const chosenTitle = (STATE.pendingUploadTitle || '').trim();
    STATE.pendingUploadTitle = '';
    const bookTitle = chosenTitle || await guessBookTitle(file);

    showLoading(tr('upload-book-title', 'Đang tải lên {name}', { name: file.name }), {
        subtext: tr('upload-book-checking', 'Đang kiểm tra & phân tách chương...'),
        progress: 10,
        status: tr('upload-book-step', 'Tải sách')
    });
    const uploaderUid = STATE.user.uid;
    const formData = new FormData();
    formData.append('userId', uploaderUid);
    formData.append('file', file);

    document.getElementById('status-indicator').innerText = tr('status-processing', 'Processing story…');
    try {
        // Give the user a useful preview without reading a large file into memory:
        // inspect only the first 4 MB for chapter separators.
        let separatorCount = 0;
        if (file.name.toLowerCase().endsWith('.txt')) {
            const preview = await file.slice(0, 4 * 1024 * 1024).text();
            separatorCount = (preview.match(/^\s*={3,}\s*$/gm) || []).length;
            if (separatorCount === 0) {
                hideLoading();
                const proceed = await askConfirm({
                    title: tr('import-no-separator-title', 'Không thấy dòng phân cách chương'),
                    message: tr('import-no-separator-confirm', 'Không tìm thấy dòng === để phân cách chương. File sẽ được nhập thành một chương. Tiếp tục?'),
                    confirmLabel: tr('import-as-one-chapter', 'Nhập một chương')
                });
                if (!proceed) return;
                showLoading(tr('upload-book-title', 'Đang tải lên {name}', { name: file.name }), {
                    subtext: tr('upload-book-checking', 'Đang kiểm tra & phân tách chương...'),
                    progress: 10,
                    status: tr('upload-book-step', 'Tải sách')
                });
            }
        }
        const estimatedChapters = separatorCount + 1;
        updateLoadingProgress(
            25,
            tr('upload-processing', 'Đang xử lý truyện...'),
            file.name.toLowerCase().endsWith('.txt')
                ? tr('upload-found-chapters', 'Tìm thấy ~{count} chương. Đang gửi lên cloud...', { count: estimatedChapters })
                : tr('upload-analyzing', 'Đang phân tích cấu trúc...'),
            tr('upload-sending', 'Gửi dữ liệu')
        );
        // The request only covers the byte transfer; the server imports in the
        // background (background=1) and we poll the job below.
        const uploadTimeoutMs = Math.min(60_000 + Math.ceil(file.size / (1024 * 1024)) * 12_000, 6 * 60_000);
        formData.append('background', '1');
        const response = await authFetch('/api/upload-story', {
            method: 'POST',
            body: formData,
            timeoutMs: uploadTimeoutMs
        });

        if (!response.ok) {
            let detail = `Upload failed (${response.status})`;
            if (response.status === 429) {
                const retryAfter = response.headers.get('Retry-After');
                detail = retryAfter
                    ? `Máy chủ đang xử lý một lượt nhập khác. Vui lòng thử lại sau ${retryAfter} giây.`
                    : 'Máy chủ đang xử lý một lượt nhập khác. Vui lòng thử lại sau.';
            }
            if (response.status !== 429) {
                try {
                    const payload = await response.clone().json();
                    if (typeof payload?.error === 'string' && payload.error.trim()) {
                        detail = payload.error;
                    } else if (Array.isArray(payload?.detail)) {
                        detail = payload.detail.map(item => {
                            const location = Array.isArray(item?.loc) ? item.loc.join('.') : 'request';
                            return `${location}: ${item?.msg || 'invalid value'}`;
                        }).join('; ') || detail;
                    } else if (typeof payload?.detail === 'string' && payload.detail.trim()) {
                        detail = payload.detail;
                    }
                } catch (_) {
                    // Keep the status-based fallback when the server response is not JSON.
                }
            }
            throw new Error(detail);
        }
        let data = await response.json();
        if (response.status === 202 && data.jobId) {
            updateLoadingProgress(
                50,
                tr('upload-processing', 'Đang xử lý truyện...'),
                tr('upload-server-processing', 'Máy chủ đang tách chương và lưu trữ...'),
                tr('upload-sending', 'Gửi dữ liệu')
            );
            data = await waitForImportJob(uploaderUid, data.jobId);
        }

        updateLoadingProgress(illustrations.length ? 50 : 85, tr('upload-building-toc', 'Đang khởi tạo mục lục...'), tr('upload-fetching-meta', 'Tải thông tin metadata từ server...'), tr('upload-init', 'Khởi tạo'));
        // Fetch fresh metadata
        if (STATE.user?.uid !== uploaderUid) return;
        const metaRes = await authFetch(`/api/stories/${uploaderUid}/${data.storyId}/metadata`);
        let bookInfo = await metaRes.json();

        // --- FIX BUG 1 & 5: Normalize bookInfo for non-segmented upload flow ---
        // Ensure STATE.currentBook.chapters is correctly populated from metadata
        if (!bookInfo.isSegmented && bookInfo.chaptersSummary) {
            bookInfo.chapters = bookInfo.chaptersSummary.map(ch => ({
                title: ch.title,
                count: ch.count,
                sentences: null // lazy-loaded
            }));
        }

        if (bookTitle) bookInfo.title = bookTitle;

        if (illustrations.length) {
            document.getElementById('status-indicator').innerText = trCount('img-optimizing-count', 'Đang tối ưu {n} ảnh...', illustrations.length);
            try {
                await uploadBookImages(data.storyId, illustrations, bookInfo.title || file.name);
            } catch (imageError) {
                console.error('[Images] Upload failed:', imageError);
                APP_STATUS.toast(tr('img-upload-partial', 'Sách đã tải lên nhưng ảnh minh họa chưa lưu được: {error}', { error: imageError.message }), 'warning');
            }
        }

        updateLoadingProgress(95, tr('upload-opening', 'Đang mở sách...'), tr('upload-almost', 'Sắp xong rồi!'), tr('upload-done', 'Hoàn tất'));
        if (STATE.user?.uid !== uploaderUid) return;
        // --- FIX BUG 6: Await loadBook and call refreshLibrary directly ---
        const loaded = await loadBook(bookInfo, data.storyId, data.filename || file.name);
        if (!loaded) return;
        await refreshLibrary();
        const addedId = data.storyId;
        APP_STATUS.toast(tr('book-added', 'Đã thêm "{title}" vào thư viện!', { title: escapeHTML(displayTitle(STATE.currentBook?.title || bookInfo.title || file.name)) }), 'success', {
            duration: 8000,
            actions: [
                { label: tr('rename-book', 'Đổi tên'), onClick: () => { if (STATE.currentBookId === addedId) void editTitle(); } },
                { label: tr('view-on-shelf', 'Xem trên kệ'), onClick: () => toggleDiscoveryMode(true) }
            ]
        });
        STATE.pendingImageFiles = [];
        if (imageInput) imageInput.value = '';
    } catch (err) {
        console.error(err);
        APP_STATUS.error(err, tr('import-failed', 'Không thể import sách.'));
    } finally {
        hideLoading();
    }
};

fileInput.onchange = handleFileUpload;
const discoveryFileInput = document.getElementById('discovery-file-input');
if (discoveryFileInput) discoveryFileInput.onchange = handleFileUpload;

const dragCarriesFiles = event => Array.from(event.dataTransfer?.types || []).includes('Files');

/**
 * Book files can be dropped on Home, on the library column and on the
 * "Thêm truyện" dialog. Drops import the book only (no illustrations); images
 * go through the dialog's second option or the image manager.
 */
function setupDragAndDrop() {
    const zones = [
        { el: document.getElementById('discovery-mode'), target: 'discovery' },
        { el: document.getElementById('panel-library'), target: 'sidebar' },
        { el: document.querySelector('#upload-options-modal [data-drop-target]'), target: null, highlight: document.getElementById('upload-txt-only-btn') }
    ].filter(zone => zone.el);

    zones.forEach(zone => {
        let depth = 0;
        const marked = zone.highlight || zone.el;
        const clear = () => { depth = 0; marked.classList.remove('drag-over'); };
        zone.el.addEventListener('dragenter', event => {
            if (!dragCarriesFiles(event)) return;
            event.preventDefault();
            depth += 1;
            marked.classList.add('drag-over');
        });
        zone.el.addEventListener('dragover', event => {
            if (!dragCarriesFiles(event)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
        });
        zone.el.addEventListener('dragleave', event => {
            if (!dragCarriesFiles(event)) return;
            depth = Math.max(0, depth - 1);
            if (depth === 0) marked.classList.remove('drag-over');
        });
        zone.el.addEventListener('drop', event => {
            if (!dragCarriesFiles(event)) return;
            event.preventDefault();
            event.stopPropagation();
            clear();
            const files = event.dataTransfer.files;
            if (!files?.length) return;
            STATE.uploadImagesChoice = false;
            STATE.uploadInputTarget = zone.target || STATE.uploadInputTarget || 'discovery';
            setModalVisibility('upload-options-modal', false);
            handleFileUpload({ target: { files, value: '' } });
        });
    });

    // A file dropped outside a zone must not navigate away from the app.
    window.addEventListener('dragover', event => { if (dragCarriesFiles(event)) event.preventDefault(); });
    window.addEventListener('drop', event => { if (dragCarriesFiles(event)) event.preventDefault(); });
}

setupDragAndDrop();

// Rings, "Nghe tiếp" and the player art follow playback.
audio.addEventListener('play', updateLibraryHighlight);
audio.addEventListener('pause', updateLibraryHighlight);
audio.addEventListener('play', syncTOCNowLabels);
audio.addEventListener('pause', syncTOCNowLabels);

// Between the click and the first chapter: a skeleton for the chosen book
// instead of the "pick a book" empty state, and its title in the console.
function showReaderOpening(title) {
    const name = displayTitle(title);
    textContainer.setAttribute('aria-busy', 'true');
    textContainer.innerHTML = '<div class="reader-skeleton" aria-hidden="true">' + '<span></span>'.repeat(8) + '</div>';
    const chapterLabel = document.getElementById('current-chapter');
    if (chapterLabel) { chapterLabel.innerText = tr('opening-book-short', 'Đang mở…'); chapterLabel.title = ''; }
    document.getElementById('media-player')?.setAttribute('data-loading', 'true');
    const author = document.getElementById('player-author');
    if (author && name) { author.innerText = name; author.title = name; }
    const playerTitle = document.getElementById('player-title');
    if (playerTitle) { playerTitle.innerText = tr('loading-short', 'Đang tải…'); playerTitle.title = ''; }
}

function endReaderOpening({ failed = false } = {}) {
    document.getElementById('media-player')?.removeAttribute('data-loading');
    if (!failed || !textContainer.querySelector(':scope > .reader-skeleton')) return;
    textContainer.removeAttribute('aria-busy');
    const error = document.createElement('p');
    error.className = 'reader-error';
    error.setAttribute('role', 'alert');
    error.textContent = tr('book-load-failed', 'Không thể tải sách từ bộ nhớ. Hãy kiểm tra file có còn tồn tại.');
    textContainer.replaceChildren(error);
}

async function loadBook(bookData, bookId, filename, fallbackProgress = null) {
    const loadGeneration = ++STATE.loadGeneration;
    // 0. Robust Engine Reset
    await resetAudioEngine();
    if (loadGeneration !== STATE.loadGeneration) return false;
    // Close the old socket immediately so its backend workers are cancelled
    // while the new book is still loading, rather than waiting for the first
    // PREFETCH message of the new book.
    closeWebSocketIntentionally();

    toggleSidebar(false);
    toggleDiscoveryMode(false, { restoreFocus: false });
    showReaderOpening(fallbackProgress?.title || bookData.title);

    // Offline audio is disposable. Do not block first-paint on IndexedDB cleanup.
    void OFFLINE_MANAGER.clearCache().catch(err => console.debug('[Offline] Cache cleanup skipped:', err.message));

    // Settings là local-only: KHÔNG reset về default khi đổi sách nữa.

    // Segmentation Logic
    STATE.isSegmented = bookData.isSegmented || false;
    STATE.segmentFormatVersion = bookData.segmentFormatVersion || 0;
    STATE.segmentSize = Number(bookData.segmentSize) > 0
        ? Number(bookData.segmentSize)
        : (STATE.segmentFormatVersion >= 2 ? 50 : 100);
    STATE.segmentsCount = bookData.segmentsCount || 0;
    STATE.currentSegmentIndex = -1;
    STATE.loadedSegments.clear();

    if (STATE.isSegmented) {
        // For segmented books, bookData is the metadata from Firestore
        STATE.currentBook = {
            title: bookData.title,
            chapters: new Array(bookData.totalChapters).fill(null).map((_, i) => ({
                title: `Chapter ${i + 1}`, // Placeholder until segment loads
                sentences: null
            }))
        };
    } else {
        STATE.currentBook = bookData;
    }

    // --- FIX: Store chapterCounts from metadata for accurate cross-segment position tracking ---
    if (bookData.chapterCounts && bookData.chapterCounts.length > 0) {
        STATE.currentBook._chapterCounts = bookData.chapterCounts;
        STATE.currentBook._totalChunks = bookData.chapterCounts.reduce((a, b) => a + b, 0);
    } else if (bookData.chaptersSummary) {
        // Non-segmented: build from chaptersSummary
        STATE.currentBook._chapterCounts = bookData.chaptersSummary.map(ch => ch.count || 0);
        STATE.currentBook._totalChunks = STATE.currentBook._chapterCounts.reduce((a, b) => a + b, 0);
    } else if (bookData.total_chunks) {
        STATE.currentBook._totalChunks = bookData.total_chunks;
    }

    STATE.currentBookId = bookId || ("book_" + bookData.title.replace(/[^a-zA-Z0-9]/g, "_"));
    STATE.currentFilename = filename || (STATE.currentBook.title + ".txt");
    const expectedBookId = STATE.currentBookId;
    STATE.imageManifest = { version: 1, coverId: null, images: [] };
    const libraryEntry = findLibraryEntry(STATE.currentBookId);
    // has_images === false is authoritative (kept in sync on every image change);
    // a missing flag (older books) still looks the manifest up once.
    const imageManifestPromise = (libraryEntry?.data?.has_images === false
        ? Promise.resolve(emptyImageManifest())
        : loadImageManifest(STATE.currentBookId)).then(manifest => {
        if (loadGeneration !== STATE.loadGeneration || STATE.currentBookId !== expectedBookId) return manifest;
        STATE.imageManifest = manifest;
        if (manifest.images.length && STATE.user && !libraryEntry?.hasImages) {
            void setDoc(doc(db, 'users', STATE.user.uid, 'progress', STATE.currentBookId), { has_images: true }, { merge: true })
                .catch(err => console.debug('[Images] Progress flag skipped:', err.message));
            // Text is already visible; add images without blocking first render,
            // then bring the reading position back into view.
            if (STATE.currentBook?.chapters?.[STATE.currentChapterIndex]?.sentences) {
                void renderChapter(STATE.currentChapterIndex)
                    .then(rendered => { if (rendered) revealCurrentSentence(); })
                    .catch(err => console.debug('[Images] Deferred render skipped:', err.message));
            }
        }
        paintPlayerArt();
        return manifest;
    });
    releaseImageURLs();

    // Check for existing progress. The library card already came from the
    // same user's progress collection, so keep it as a safe fallback if this
    // second point-read is interrupted by a transient Firestore failure.
    let progress;
    try {
        progress = await loadProgress(STATE.currentBookId);
    } catch (err) {
        const hasFallback = fallbackProgress && (
            fallbackProgress.last_read_chunk !== undefined ||
            typeof fallbackProgress.title === 'string' ||
            typeof fallbackProgress.filename === 'string'
        );
        if (!hasFallback) throw err;
        progress = fallbackProgress;
        console.warn('[Progress] Point-read failed; using library snapshot:', err);
    }
    // A point-read can return a partial progress document (for example after
    // metadata-only writes). In that case it must not replace the complete
    // snapshot that rendered the Discovery card, or the forced save below
    // would overwrite the real cursor with chunk zero.
    if ((!progress || !hasSavedProgressCursor(progress)) && hasSavedProgressCursor(fallbackProgress)) {
        progress = fallbackProgress;
        console.info('[Progress] Point-read missing cursor; using library snapshot for', STATE.currentBookId);
    }
    if (loadGeneration !== STATE.loadGeneration) return false;
    // Restore metadata independently from the playback cursor. Older records
    // can contain a title without last_read_chunk.
    if (progress?.title) STATE.currentBook.title = progress.title;
    STATE.currentBook.title = prettifyBookTitle(STATE.currentBook.title) || STATE.currentBook.title;
    if (progress?.filename) STATE.currentFilename = progress.filename;

    if (hasSavedProgressCursor(progress)) {

        const indices = getLocalIndices(progress.last_read_chunk);
        STATE.currentChapterIndex = indices.chapterIndex;
        STATE.currentSentenceIndex = indices.sentenceIndex;
        STATE.lastSavedChunkIndex = progress.last_read_chunk;

        // Migration một lần: nếu máy chưa có cài đặt local, hạt giống từ
        // cài đặt cũ của sách đầu tiên được mở sau bản cập nhật này.
        if (!localStorage.getItem(LOCAL_SETTINGS_KEY) && progress.settings) {
            const { theme, fontSize, ...bookSettings } = progress.settings;
            STATE.settings = { ...STATE.settings, ...bookSettings };
            persistLocalSettings();
            console.info('[Settings] Seeded local settings from legacy per-book record');
        }
        // Older progress records may contain 5/10/20 workers. Normalize them
        // before the first request so the UI cannot recreate the old RAM burst.
        const savedWorkers = Number(STATE.settings.numWorkers);
        STATE.settings.numWorkers = Number.isFinite(savedWorkers)
            ? Math.max(1, Math.min(3, savedWorkers))
            : 2;
    } else {
        STATE.currentChapterIndex = 0;
        STATE.currentSentenceIndex = 0;
        STATE.lastSavedChunkIndex = -1;
    }

    // If segmented, we MUST load the segment containing currentChapterIndex
    if (STATE.isSegmented) {
        const segIdx = Math.floor(STATE.currentChapterIndex / (STATE.segmentSize || 100));
        await fetchSegment(segIdx, loadGeneration, STATE.currentBookId);
        if (loadGeneration !== STATE.loadGeneration) return false;
    }

    applySettingsToUI();

    const currentTitleEl = document.getElementById('current-title');
    currentTitleEl.innerText = displayTitle(STATE.currentBook.title);
    currentTitleEl.title = displayTitle(STATE.currentBook.title);
    document.getElementById('edit-title-btn').classList.remove('hidden');

    await renderChapter(STATE.currentChapterIndex);
    if (loadGeneration !== STATE.loadGeneration) return false;
    endReaderOpening();
    renderTOC();
    updateUI();

    if (progress) revealCurrentSentence();

    // Progress persistence is not part of first paint. A slow Firestore write
    // must not keep the reader in its loading state.
    void saveProgress(true).catch(err => console.debug('[Progress] Deferred save skipped:', err.message));
    void playFromSentence(STATE.currentSentenceIndex, loadGeneration);
    updateLibraryHighlight();
    void imageManifestPromise.catch(err => console.debug('[Images] Deferred manifest skipped:', err.message));
    if (STATE.isSegmented) void fetchBookTOC(STATE.currentBookId, loadGeneration);
    return true;
}

/**
 * Lightweight, RAM-minimal TOC loader.
 * Fetches only chapter titles (flat string array) without allocating extra objects.
 * Populates real titles across all chapters for instant search and full Table of Contents.
 */
async function fetchBookTOC(bookId, expectedLoadGeneration = STATE.loadGeneration) {
    if (!STATE.isSegmented || !STATE.user || !bookId) return;
    try {
        const res = await authFetch(`/api/stories/${STATE.user.uid}/${bookId}/toc?t=${Date.now()}`, {
            timeoutMs: 15_000
        });
        if (!res.ok) return;
        const data = await res.json();
        if (expectedLoadGeneration !== STATE.loadGeneration || STATE.currentBookId !== bookId) return;

        const titles = data.titles;
        if (Array.isArray(titles) && STATE.currentBook) {
            if (!Array.isArray(STATE.currentBook.chapters)) {
                STATE.currentBook.chapters = [];
            }
            for (let i = 0; i < titles.length; i++) {
                const t = titles[i];
                if (!STATE.currentBook.chapters[i]) {
                    STATE.currentBook.chapters[i] = {
                        title: t || `Chương ${i + 1}`,
                        sentences: null
                    };
                } else if (t) {
                    STATE.currentBook.chapters[i].title = t;
                }
            }
            renderTOC();
        }
    } catch (err) {
        console.debug('[TOC] Background TOC fetch skipped:', err.message);
    }
}
window.fetchBookTOC = fetchBookTOC;

async function fetchSegment(segmentIndex, expectedLoadGeneration = STATE.loadGeneration, expectedBookId = STATE.currentBookId) {
    if (STATE.loadedSegments.has(segmentIndex)) return;
    const isCurrentSegmentLoad = () => (
        expectedLoadGeneration === STATE.loadGeneration &&
        expectedBookId === STATE.currentBookId &&
        STATE.currentBook
    );
    if (!isCurrentSegmentLoad()) return false;

    console.log(`[Segmentation] Fetching segment ${segmentIndex}...`);
    try {
        const version = STATE.segmentFormatVersion ? `&version=${STATE.segmentFormatVersion}` : '';
        const res = await authFetch(`/api/stories/${STATE.user.uid}/${STATE.currentBookId}/segments/${segmentIndex}?t=${Date.now()}${version}`, {
            timeoutMs: 25_000
        });
        if (!res.ok) throw new Error(`Segment HTTP ${res.status}`);
        const data = await res.json();
        if (!isCurrentSegmentLoad()) return false;

        // Update chapters in currentBook
        const startOffset = segmentIndex * (STATE.segmentSize || 100);
        data.chapters.forEach((chap, i) => {
            const chapIdx = startOffset + i;
            if (STATE.currentBook.chapters[chapIdx] !== undefined) {
                // Set .count so getGlobalIndex works for loaded segments
                const count = chap.sentences ? chap.sentences.length : 0;
                STATE.currentBook.chapters[chapIdx] = { ...chap, count };

                // Update _chapterCounts in case backend didn't provide it
                if (!STATE.currentBook._chapterCounts) STATE.currentBook._chapterCounts = [];
                if (STATE.currentBook._chapterCounts[chapIdx] === undefined) {
                    STATE.currentBook._chapterCounts[chapIdx] = count;
                }
            }
        });

        STATE.loadedSegments.add(segmentIndex);
        STATE.currentSegmentIndex = segmentIndex;
        console.log(`[Segmentation] Segment ${segmentIndex} loaded.`);
        return true;
    } catch (err) {
        console.error("Failed to fetch segment:", err);
        throw err;
    }
}

/**
 * Updates the highlighting for books in the sidebar and discovery grid
 * based on the currently open book ID.
 */
async function fetchChapterSentences(index, expectedLoadGeneration = STATE.loadGeneration, expectedBookId = STATE.currentBookId) {
    if (!STATE.user || !STATE.currentFilename) return;
    const expectedFilename = STATE.currentFilename;
    const isCurrentChapterLoad = () => (
        expectedLoadGeneration === STATE.loadGeneration &&
        expectedBookId === STATE.currentBookId &&
        STATE.currentBook
    );
    if (!isCurrentChapterLoad()) return false;

    // If segmented, we should already have sentences from fetchSegment
    if (STATE.isSegmented) {
        const segIdx = Math.floor(index / (STATE.segmentSize || 100));
        if (!STATE.loadedSegments.has(segIdx)) {
            await fetchSegment(segIdx, expectedLoadGeneration, expectedBookId);
        }
        return isCurrentChapterLoad();
    }

    const formData = new FormData();
    formData.append('userId', STATE.user.uid);
    formData.append('filename', expectedFilename);
    formData.append('chapterIndex', index);

    // Prefetching a later chapter must not overwrite the status of the one on screen.
    const statusEl = document.getElementById('status-indicator');
    const setStatus = (text) => {
        if (statusEl && index === STATE.currentChapterIndex) setStatusKeepingStopReason(text);
    };
    const loadingText = tr('status-loading-chapter', 'Đang tải chương...');
    setStatus(loadingText);

    try {
        const response = await authFetch('/api/get-chapter-sentences', {
            method: 'POST',
            body: formData
        });
        const data = await response.json();
        if (!isCurrentChapterLoad()) return false;
        if (data.sentences) {
            STATE.currentBook.chapters[index].sentences = data.sentences;
            STATE.currentBook.chapters[index].count = data.sentences.length; // Ensure count is correct
            if (statusEl?.innerText === loadingText) setStatus(idleStatus());
        } else {
            throw new Error(data.error || "Failed to load chapter content.");
        }
        return true;
    } catch (e) {
        console.error(e);
        setStatus(tr('status-chapter-error', 'Lỗi tải chương'));
        throw e;
    }
}

async function renderChapterImages(index) {
    if (!STATE.imageManifest?.images?.length) return [];
    // The cover belongs to the shelf, the dock and the lock screen, not to the chapter text.
    const coverId = STATE.imageManifest.coverId;
    const images = STATE.imageManifest.images.filter(image => (
        image.chapterIndex === index || (image.chapterIndex == null && index === 0 && image.id !== coverId)
    ));
    const figures = [];
    for (const image of images) {
        const url = await getImageURL(STATE.currentBookId, image);
        if (!url) continue;
        const figure = document.createElement('figure');
        figure.className = 'reader-figure';
        const img = document.createElement('img');
        img.src = url;
        // `alt` holds the uploaded file name, which is no caption; describe the image generically.
        img.alt = tr('illustration', 'Ảnh minh hoạ');
        img.loading = 'lazy';
        img.decoding = 'async';
        figure.appendChild(img);
        figures.push(figure);
    }
    return figures;
}

async function renderChapter(index, expectedLoadGeneration = STATE.loadGeneration) {
    const expectedBookId = STATE.currentBookId;
    const isCurrentChapterRender = () => (
        expectedLoadGeneration === STATE.loadGeneration &&
        expectedBookId === STATE.currentBookId &&
        STATE.currentBook
    );
    if (!isCurrentChapterRender()) return false;
    STATE.currentChapterIndex = index;

    // If segmented, ensure chapter data exists
    if (STATE.isSegmented) {
        const segIdx = Math.floor(index / (STATE.segmentSize || 100));
        await fetchSegment(segIdx, expectedLoadGeneration, expectedBookId);
        if (!isCurrentChapterRender()) return false;
    }

    trimReaderContentCache(index);

    const chapter = STATE.currentBook.chapters[index];
    const chapterCount = STATE.currentBook.chapters.length;
    const chapterTitle = chapter.title || `${tr('chapter-word', 'Chương')} ${index + 1}`;
    const chapterLabel = document.getElementById('current-chapter');
    chapterLabel.innerText = `C.${index + 1}/${chapterCount} · ${shortChapterTitle(chapterTitle)}`;
    chapterLabel.title = chapterTitle;
    document.dispatchEvent(new CustomEvent('readerchapterchange', { detail: { index } }));

    // Lazy load sentences if missing
    if (!chapter.sentences) {
        textContainer.setAttribute('aria-busy', 'true');
        textContainer.innerHTML = '<div class="reader-skeleton" aria-hidden="true">' + '<span></span>'.repeat(8) + '</div>';
        try {
            await fetchChapterSentences(index, expectedLoadGeneration, expectedBookId);
        } catch (e) {
            textContainer.removeAttribute('aria-busy');
            textContainer.innerHTML = '';
            const error = document.createElement('p');
            error.className = 'reader-error';
            error.setAttribute('role', 'alert');
            error.textContent = tr('chapter-load-error', 'Không tải được chương này. Kiểm tra kết nối rồi thử lại.');
            textContainer.appendChild(error);
            return false;
        }
        if (!isCurrentChapterRender()) return false;
    }

    const chapterFigures = await renderChapterImages(index);
    await safeViewTransition(() => {
        textContainer.removeAttribute('aria-busy');
        textContainer.innerHTML = '';
        const readerCopy = document.createElement('div');
        readerCopy.className = 'reader-copy';
        const kicker = document.createElement('p');
        kicker.className = 'reader-kicker';
        kicker.textContent = `${tr('chapter-word', 'Chương').toUpperCase()} ${index + 1} / ${chapterCount}`;
        readerCopy.appendChild(kicker);
        chapterFigures.forEach(figure => readerCopy.appendChild(figure));
        // The first chunk usually repeats the chapter title: show it as the heading.
        const titleKey = (chapter.title || '').replace(/\s+/g, ' ').trim();
        chapter.sentences.forEach((text, i) => {
            const span = document.createElement('span');
            span.id = `sentence-${i}`;
            span.className = i === 0 && titleKey && text.replace(/\s+/g, ' ').trim() === titleKey
                ? 'chunk-text chunk-heading'
                : 'chunk-text';
            span.textContent = text;
            readerCopy.appendChild(span);
        });
        textContainer.appendChild(readerCopy);

        textContainer.scrollTop = 0;
        renderMinimap(index);
    });
    return true;
}

// Tap a paragraph to play from it (one delegated listener instead of one per chunk).
textContainer.addEventListener('click', event => {
    const chunk = event.target.closest('.chunk-text');
    if (!chunk || !textContainer.contains(chunk)) return;
    if (window.getSelection?.().toString()) return;
    const index = Number(chunk.id.slice('sentence-'.length));
    if (Number.isInteger(index)) playFromSentence(index);
});

function renderMinimap(index) {
    if (STATE.isLiteMode) return;
    const nodesContainer = document.getElementById('minimap-nodes');
    if (!nodesContainer) return;

    nodesContainer.innerHTML = '';
    const sentences = STATE.currentBook.chapters[index].sentences;
    sentences.forEach((_, i) => {
        const node = document.createElement('div');
        node.id = `minimap-node-${i}`;
        node.className = 'minimap-node';
        node.onclick = (e) => {
            e.stopPropagation();
            const target = document.getElementById(`sentence-${i}`);
            if (target) {
                target.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
            }
        };
        nodesContainer.appendChild(node);
    });

    // Initial scroll sync
    syncMinimapScroll();
}

function syncMinimapScroll() {
    const textContainer = document.getElementById('text-container');
    const nodesContainer = document.getElementById('minimap-nodes');
    const viewport = document.getElementById('minimap-viewport');
    if (!textContainer || !nodesContainer || !viewport) return;

    const scrollPct = textContainer.scrollTop / (textContainer.scrollHeight - textContainer.clientHeight);
    const containerHeight = textContainer.offsetHeight;
    const contentHeight = textContainer.scrollHeight;

    const viewHeightPct = containerHeight / contentHeight;
    const minimapHeight = nodesContainer.offsetHeight;

    viewport.style.height = `${Math.max(10, viewHeightPct * minimapHeight)}px`;
    const maxTop = minimapHeight - parseFloat(viewport.style.height);
    viewport.style.top = `${scrollPct * maxTop}px`;
}

// Add scroll listener for minimap — guarded against lite-mode for zero layout cost
document.getElementById('text-container').addEventListener('scroll', () => {
    if (!STATE.isLiteMode) syncMinimapScroll();
});

function isTOCSelectMode() {
    return document.getElementById('toc-select-mode-btn')?.classList.contains('active') === true;
}

function tocChapterLabel(chap, i) {
    return chap?.title || `${tr('chapter-word', 'Chương')} ${i + 1}`;
}

function buildTOCRow(chap, i, isActive) {
    const title = tocChapterLabel(chap, i);
    const row = document.createElement('div');
    row.className = 'toc-row';
    row.id = `toc-item-${i}`;
    row.setAttribute('role', 'listitem');
    row.dataset.chapterIndex = i;
    row.dataset.chapterTitle = removeVietnameseTones((chap?.title || '').toLowerCase()) + ' ' + (chap?.title || '').toLowerCase();
    if (isActive) row.setAttribute('aria-current', 'true');

    const check = document.createElement('label');
    check.className = 'toc-row__check';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'toc-chapter-checkbox';
    checkbox.dataset.chapterIndex = i;
    checkbox.setAttribute('aria-label', tr('toc-select-chapter', 'Chọn chương {n}', { n: i + 1 }));
    check.appendChild(checkbox);

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'toc-row__main';
    main.dataset.tocJump = '';
    const num = document.createElement('span');
    num.className = 'toc-row__num';
    num.textContent = `C.${i + 1}`;
    const name = document.createElement('span');
    name.className = 'toc-row__title';
    name.textContent = shortChapterTitle(title);
    name.title = chap?.title || '';
    main.append(num, name);
    if (isActive) main.appendChild(buildTOCNowLabel());

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'icon-btn toc-row__edit';
    edit.dataset.tocEdit = '';
    edit.title = tr('edit-chapter-n', 'Sửa chương {n}', { n: i + 1 });
    edit.setAttribute('aria-label', edit.title);
    edit.innerHTML = '<svg class="ic ic--sm" aria-hidden="true"><use href="#i-pen"/></svg>';

    row.append(check, main, edit);
    return row;
}

function isAudioPlaying() {
    return typeof audio !== 'undefined' && !audio.paused;
}

function tocNowText() {
    return isAudioPlaying() ? tr('toc-now', 'đang nghe') : tr('toc-here', 'đang đọc');
}

function buildTOCNowLabel() {
    const now = document.createElement('span');
    now.className = 'toc-row__now';
    now.textContent = tocNowText();
    return now;
}

// "đang nghe" only while audio plays; paused or blocked, the marker says where the reader is.
function syncTOCNowLabels() {
    document.querySelectorAll('#toc-list .toc-row__now').forEach(label => { label.textContent = tocNowText(); });
    updateTOCCount();
}

function updateTOCCount() {
    const countEl = document.getElementById('toc-count');
    if (!countEl) return;
    const pending = pendingChapterDelete?.bookId === STATE.currentBookId ? pendingChapterDelete.indices.size : 0;
    const total = (STATE.currentBook?.chapters?.length || 0) - pending;
    if (!total) {
        countEl.textContent = '';
        return;
    }
    const shown = document.querySelectorAll('#toc-list > .toc-row:not([style*="none"])').length;
    const query = tocSearchInput?.value.trim();
    if (query) {
        countEl.textContent = tr('toc-count-filtered', '{shown}/{total} chương', { shown, total });
        return;
    }
    const key = isAudioPlaying() ? 'toc-count' : 'toc-count-here';
    const oneKey = `${key}-one`;
    const useOne = total === 1 && window.translations?.[uiLang()]?.[oneKey] !== undefined;
    countEl.textContent = tr(useOne ? oneKey : key, isAudioPlaying() ? '{total} chương · đang nghe C.{current}' : '{total} chương · đang đọc C.{current}', { total, current: STATE.currentChapterIndex + 1 });
}

function renderTOC() {
    const tocList = document.getElementById('toc-list');
    if (!tocList) return;
    const checked = new Set([...tocList.querySelectorAll('.toc-chapter-checkbox:checked')].map(cb => cb.dataset.chapterIndex));
    tocList.innerHTML = '';

    const labelEl = document.getElementById('toc-book-label');
    if (labelEl) labelEl.textContent = displayTitle(STATE.currentBook?.title) || tr('toc-no-book', 'Chưa mở truyện');

    if (!STATE.currentBook || !Array.isArray(STATE.currentBook.chapters) || STATE.currentBook.chapters.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'toc-empty';
        empty.textContent = tr('toc-empty', 'Mở một truyện từ Thư viện để xem mục lục.');
        tocList.appendChild(empty);
        updateTOCCount();
        return;
    }

    const fragment = document.createDocumentFragment();
    STATE.currentBook.chapters.forEach((chap, i) => {
        const row = buildTOCRow(chap, i, i === STATE.currentChapterIndex);
        if (isChapterPendingDelete(i)) row.classList.add('is-pending-delete');
        fragment.appendChild(row);
    });
    tocList.appendChild(fragment);
    if (checked.size) {
        tocList.querySelectorAll('.toc-chapter-checkbox').forEach(cb => { cb.checked = checked.has(cb.dataset.chapterIndex); });
    }
    if (isTOCSelectMode()) updateDownloadBar();

    applyTOCSearch();
}

// Chapter changed while the list is already built: move the marker instead of rebuilding.
function refreshTOCCurrent() {
    const rows = document.querySelectorAll('#toc-list > .toc-row');
    if (!STATE.currentBook || rows.length !== STATE.currentBook.chapters.length) {
        renderTOC();
        return;
    }
    document.querySelectorAll('#toc-list > .toc-row[aria-current]').forEach(row => {
        row.removeAttribute('aria-current');
        row.querySelector('.toc-row__now')?.remove();
    });
    const row = document.getElementById(`toc-item-${STATE.currentChapterIndex}`);
    if (row) {
        row.setAttribute('aria-current', 'true');
        row.querySelector('.toc-row__main')?.appendChild(buildTOCNowLabel());
    }
    updateTOCCount();
}

function isTOCVisible() {
    const panel = document.getElementById('panel-toc');
    return !!panel && !panel.hidden && panel.offsetParent !== null;
}

async function jumpToTOCChapter(row) {
    const i = Number(row.dataset.chapterIndex);
    if (!Number.isInteger(i) || row.classList.contains('toc-loading')) return;
    row.classList.add('toc-loading');
    try {
        await switchChapter(i, 0, true, closeTOC);
    } catch (err) {
        console.error('[TOC] Switch chapter error:', err);
    } finally {
        row.classList.remove('toc-loading');
    }
}

document.getElementById('toc-list')?.addEventListener('click', event => {
    const row = event.target.closest('.toc-row');
    if (!row) return;
    if (event.target.closest('[data-toc-edit]')) {
        event.stopPropagation();
        openEditChapterModal(Number(row.dataset.chapterIndex), event.target.closest('[data-toc-edit]'));
        return;
    }
    if (!event.target.closest('[data-toc-jump]')) return;
    if (isTOCSelectMode()) {
        const checkbox = row.querySelector('.toc-chapter-checkbox');
        if (checkbox) checkbox.checked = !checkbox.checked;
        updateDownloadBar();
        return;
    }
    void jumpToTOCChapter(row);
});
document.getElementById('toc-list')?.addEventListener('change', event => {
    if (event.target.classList?.contains('toc-chapter-checkbox')) updateDownloadBar();
});

function scrollTOCCurrentChapter() {
    const activeItem = document.getElementById(`toc-item-${STATE.currentChapterIndex}`);
    const tocList = document.getElementById('toc-list');
    if (!activeItem || !tocList) return;
    // offsetTop of a sticky row includes its pinned offset: measure it unstuck.
    activeItem.style.position = 'static';
    const target = activeItem.offsetTop - (tocList.clientHeight - activeItem.offsetHeight) / 2;
    activeItem.style.position = '';
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches || STATE.isLiteMode;
    tocList.scrollTo({ top: Math.max(0, target), behavior: reduce ? 'auto' : 'smooth' });
}

/**
 * Leaves the TOC view: resets select mode and closes the phone sheet or drawer.
 */
function closeTOC() {
    if (isTOCSelectMode() && !STATE.isDownloading) {
        toggleSelectMode();
    }

    if (window.innerWidth < 1024) {
        if (typeof window.closeTOCSheet === 'function' && window.closeTOCSheet()) return;
        toggleSidebar(false);
    }
}
window.renderTOC = renderTOC;
window.refreshTOCCurrent = refreshTOCCurrent;
window.scrollTOCCurrentChapter = scrollTOCCurrentChapter;
window.closeTOC = closeTOC;

// --- Offline Download Logic ---
function toggleSelectMode() {
    const btn = document.getElementById('toc-select-mode-btn');
    const panel = document.getElementById('panel-toc');
    const isActive = btn.classList.contains('active');
    btn.classList.toggle('active', !isActive);
    btn.setAttribute('aria-pressed', String(!isActive));
    if (panel) panel.dataset.selecting = String(!isActive);
    const label = btn.querySelector('[data-toc-select-label]');
    if (label) {
        const key = isActive ? 'toc-select' : 'toc-select-done';
        label.dataset.i18n = key;
        label.textContent = tr(key, isActive ? 'Chọn' : 'Xong');
    }

    if (isActive) {
        document.querySelectorAll('.toc-chapter-checkbox').forEach(cb => { cb.checked = false; });
    }

    updateDownloadBar();
}

function updateDownloadBar() {
    const checkboxes = document.querySelectorAll('.toc-chapter-checkbox:checked');
    const bar = document.getElementById('toc-download-bar');
    const countEl = document.getElementById('toc-selected-count');

    if (isTOCSelectMode()) {
        bar.classList.remove('hidden');
        countEl.innerText = trCount('toc-selected', '{n} chương đã chọn', checkboxes.length);
    } else {
        bar.classList.add('hidden');
    }
}

function selectAllChapters() {
    document.querySelectorAll('.toc-chapter-checkbox').forEach(cb => cb.checked = true);
    updateDownloadBar();
}

function deselectAllChapters() {
    document.querySelectorAll('.toc-chapter-checkbox').forEach(cb => cb.checked = false);
    updateDownloadBar();
}

function dispatchDownloadQueue() {
    if (!STATE.isDownloading || !STATE.ws || STATE.ws.readyState !== WebSocket.OPEN) return;

    // Fast parallel download pipeline: 50 concurrent in-flight workers for offline download
    const maxConcurrency = 50;

    while (
        STATE.downloadInFlight &&
        STATE.downloadInFlight.size < maxConcurrency &&
        STATE.downloadPendingQueue &&
        STATE.downloadPendingQueue.length > 0
    ) {
        const task = STATE.downloadPendingQueue.shift();
        const key = `${task.chapterIndex}_${task.index}`;

        if (STATE.downloadBuffer.has(key)) {
            continue;
        }

        STATE.downloadInFlight.add(key);
        STATE.fetchingSet.add(key);

        STATE.ws.send(JSON.stringify({
            type: "PREFETCH",
            index: task.index,
            chapterIndex: task.chapterIndex,
            text: applySkipDictionary(task.text),
            voice: task.voice,
            rate: task.rate,
            pitch: task.pitch,
            volume: task.volume,
            numWorkers: 50,
            ...ttsToggles(),
            sessionId: STATE.sessionId
        }));
    }
}

// Download button: idle "Tải MP3", amber while preparing, red "Dừng tải" while it can be stopped.
function setTOCDownloadButton(button, state) {
    if (!button) return;
    const states = {
        preparing: { icon: 'i-download', key: 'toc-preparing', text: 'Đang chuẩn bị…' },
        stop: { icon: 'i-stop', key: 'toc-stop-download', text: 'Dừng tải' },
        '': { icon: 'i-download', key: 'toc-download-mp3', text: 'Tải MP3' }
    };
    const next = states[state] || states[''];
    if (state) button.dataset.state = state;
    else delete button.dataset.state;
    button.innerHTML = `<svg class="ic ic--sm" aria-hidden="true"><use href="#${next.icon}"/></svg><span data-i18n="${next.key}"></span>`;
    button.querySelector('span').textContent = tr(next.key, next.text);
}

async function downloadSelectedChapters() {
    const checkboxes = document.querySelectorAll('.toc-chapter-checkbox:checked');
    if (checkboxes.length === 0) {
        APP_STATUS.toast(tr('toc-select-none', 'Vui lòng chọn ít nhất một chương.'), 'warning');
        return;
    }

    const selectedIndices = Array.from(checkboxes).map(cb => parseInt(cb.dataset.chapterIndex));
    if (selectedIndices.length > 5) {
        APP_STATUS.toast(tr('toc-select-max', 'Mỗi lần tải tối đa 5 chương. Hãy bỏ bớt chương đã chọn.'), 'warning');
        return;
    }

    // UI elements
    const downloadBtn = document.getElementById('toc-download-btn');
    const statusEl = document.getElementById('toc-download-status');
    const progressContainer = document.getElementById('toc-download-progress');
    const progressBar = document.getElementById('toc-download-progress-bar');
    const chapterInfo = document.getElementById('toc-download-chapter-info');
    const percentEl = document.getElementById('toc-download-percent');

    // --- IMMEDIATE FEEDBACK ---
    STATE.isDownloading = true; // Set early to capture next click as "Stop"
    setTOCDownloadButton(downloadBtn, 'preparing');

    // Show progress bar early with "Preparing" message
    statusEl.classList.remove('hidden');
    progressContainer.classList.remove('hidden');
    statusEl.innerText = tr('dl-preparing', 'Đang chuẩn bị các chương để tải…');
    progressBar.style.width = '0%';
    percentEl.innerText = '0%';

    try {
        // --- Lazy loading for download ---
        // We need all sentences for all selected chapters to proceed with download
        for (let i = 0; i < selectedIndices.length; i++) {
            // Check if user cancelled during preparation
            if (!STATE.isDownloading) {
                console.log("[Download] Preparation cancelled by user.");
                return;
            }

            const idx = selectedIndices[i];
            const prepProgress = Math.round((i / selectedIndices.length) * 100);

            statusEl.innerText = tr('dl-preparing-n', 'Đang chuẩn bị chương {i}/{total}…', { i: i + 1, total: selectedIndices.length });
            progressBar.style.width = `${prepProgress}%`;
            percentEl.innerText = `${prepProgress}%`;
            chapterInfo.innerText = tr('dl-chapter-n', 'Chương {n}', { n: idx + 1 });

            if (!STATE.currentBook.chapters[idx].sentences) {
                await fetchChapterSentences(idx);
            }
        }

        const chapters = selectedIndices.map(idx => ({
            chapterIndex: idx,
            title: STATE.currentBook.chapters[idx].title,
            sentences: STATE.currentBook.chapters[idx].sentences
        }));

        const { voice, pitch, volume } = STATE.settings;
        const rate = ttsRate();

        // Switch to Active Download UI
        setTOCDownloadButton(downloadBtn, 'stop');

        // --- Prepare download state ---
        // 1. Pause audio
        audio.pause();
        STATE.isPlaying = false;

        // 2. New session → kill old workers, clear queues
        STATE.sessionId++;
        STATE.appendQueue = [];
        STATE.chunkTimings = [];
        STATE.fetchingSet.clear();
        STATE.metadataQueue = [];

        // 3. Initialize download buffer
        STATE.downloadBuffer = new Map();
        STATE.downloadExpected = chapters.reduce((sum, ch) => sum + ch.sentences.length, 0);

        document.getElementById('status-indicator').innerText = tr('status-offline-download', 'Downloading for offline…');
        progressBar.style.width = '0%';
        percentEl.innerText = '0%';
        chapterInfo.innerText = tr('dl-parts', '{done}/{total} đoạn', { done: 0, total: STATE.downloadExpected });
        statusEl.innerText = tr('dl-dispatching', 'Đang gửi {total} đoạn đi đọc song song…', { total: STATE.downloadExpected });

        console.log(`[Download] Starting 50-worker parallel download: ${STATE.downloadExpected} chunks across ${chapters.length} chapters`);

        // 4. Ensure WebSocket is connected (workers are needed!)
        if (!(await waitForWebSocket(() => !STATE.isDownloading))) {
            throw new Error(STATE.isDownloading ? "WebSocket connection timeout." : 'Download cancelled by user.');
        }

        // 5. Build pipeline queue & start sliding window dispatch
        STATE.downloadChunkMeta = new Map();
        STATE.downloadRetryCount = new Map();
        STATE.downloadPendingQueue = [];
        STATE.downloadInFlight = new Set();

        for (const chapter of chapters) {
            for (let s = 0; s < chapter.sentences.length; s++) {
                const key = `${chapter.chapterIndex}_${s}`;
                const task = {
                    index: s,
                    chapterIndex: chapter.chapterIndex,
                    text: chapter.sentences[s],
                    voice,
                    rate,
                    pitch,
                    volume
                };
                STATE.downloadChunkMeta.set(key, task);
                STATE.downloadPendingQueue.push(task);
            }
        }

        // Kick off concurrent download pipeline with sliding window!
        dispatchDownloadQueue();

        // 6. Wait for ALL chunks to be received by the WS binary handler
        await new Promise((resolve, reject) => {
            STATE.downloadResolve = resolve;
            STATE.downloadReject = reject;

            // Safety timeout: 15 minutes max
            setTimeout(() => {
                if (STATE.downloadResolve) {
                    STATE.downloadResolve = null;
                    STATE.downloadReject = null;
                    reject(new Error(`Download timed out (${STATE.downloadBuffer.size}/${STATE.downloadExpected} received)`));
                }
            }, 15 * 60 * 1000);
        });

        // 7. All chunks received! Sort by chapter then sentence index and concatenate
        progressBar.style.width = '100%';
        percentEl.innerText = '100%';
        chapterInfo.innerText = tr('dl-merging', 'Đang ghép âm thanh…');
        statusEl.innerText = tr('dl-building', 'Đã nhận đủ các đoạn. Đang tạo file MP3…');

        const sortedKeys = [...STATE.downloadBuffer.keys()].sort((a, b) => {
            const [ac, as_] = a.split('_').map(Number);
            const [bc, bs] = b.split('_').map(Number);
            if (ac !== bc) return ac - bc;
            return as_ - bs;
        });

        const orderedBuffers = sortedKeys.map(k => STATE.downloadBuffer.get(k));
        const finalBlob = new Blob(orderedBuffers, { type: 'audio/mpeg' });

        // Generate filename
        const chapterNumbers = chapters.map(ch => {
            const match = ch.title.match(/\d+/);
            return match ? parseInt(match[0]) : null;
        }).filter(n => n !== null);

        const xx = chapterNumbers.length > 0 ? Math.min(...chapterNumbers) : (Math.min(...selectedIndices) + 1);
        const yy = chapterNumbers.length > 0 ? Math.max(...chapterNumbers) : (Math.max(...selectedIndices) + 1);
        const normalizedTitle = removeVietnameseTones(STATE.currentBook.title);
        const safeTitle = normalizedTitle.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_');
        const filename = `${safeTitle}_${String(xx).padStart(2, '0')}_${String(yy).padStart(2, '0')}.mp3`;

        // Trigger browser download
        const url = URL.createObjectURL(finalBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        chapterInfo.innerText = '';
        statusEl.innerText = tr('dl-done', 'Đã tải xong.');
        setTimeout(() => {
            statusEl.classList.add('hidden');
            progressContainer.classList.add('hidden');
            progressBar.style.width = '0%';
        }, 4000);
    } catch (err) {
        console.error('Download Error:', err);
        statusEl.innerText = err.message || tr('dl-failed', 'Không tải được.');
        progressBar.style.width = '0%';
    } finally {
        STATE.isDownloading = false;
        STATE.downloadBuffer = new Map();
        STATE.downloadExpected = 0;
        STATE.downloadPendingQueue = [];
        STATE.downloadInFlight = new Set();
        STATE.downloadResolve = null;
        STATE.downloadReject = null;
        STATE.downloadChunkMeta = new Map();
        STATE.downloadRetryCount = new Map();
        setTOCDownloadButton(downloadBtn, '');

        // Close WebSocket after download (free backend resources)
        closeWebSocketIntentionally();
        document.getElementById('status-indicator').innerText = tr('status-disconnected', 'Disconnected');
        setPlayIcon(false);
    }
}

function stopDownload() {
    console.log('[Download] User stopped download.');
    STATE.isDownloading = false;

    // Increment session to invalidate all in-flight WS responses
    STATE.sessionId++;

    // Reject the download promise to exit the await
    if (STATE.downloadReject) {
        STATE.downloadReject(new Error('Download cancelled by user.'));
        STATE.downloadReject = null;
        STATE.downloadResolve = null;
    }
}

function isChapterPendingDelete(index) {
    return !!pendingChapterDelete && pendingChapterDelete.bookId === STATE.currentBookId && pendingChapterDelete.indices.has(index);
}

async function deleteSelectedChapters() {
    const checkboxes = document.querySelectorAll('.toc-chapter-checkbox:checked');
    if (checkboxes.length === 0) {
        APP_STATUS.toast(tr('delete-chapters-none', 'Vui lòng chọn ít nhất một chương để xóa.'));
        return;
    }
    if (!STATE.user || !STATE.currentBookId) return;

    const selectedIndices = Array.from(checkboxes).map(cb => parseInt(cb.dataset.chapterIndex));
    if (pendingChapterDelete && pendingChapterDelete.bookId !== STATE.currentBookId) await flushChapterDelete();
    const batch = pendingChapterDelete || {
        uid: STATE.user.uid,
        bookId: STATE.currentBookId,
        filename: STATE.currentFilename,
        title: STATE.currentBook?.title || '',
        indices: new Set(),
        timer: null,
        toast: null
    };
    selectedIndices.forEach(i => batch.indices.add(i));
    clearTimeout(batch.timer);
    batch.timer = null;
    pendingChapterDelete = batch;

    toggleSelectMode();
    renderTOC();
    batch.toast = APP_STATUS.toast(trCount('delete-chapters-done', 'Đã xoá {n} chương.', batch.indices.size), 'info', {
        key: 'chapter-delete',
        duration: TOAST_ACTION_MS,
        onExpire: () => { if (pendingChapterDelete === batch) void flushChapterDelete(); },
        action: {
            label: tr('undo', 'Hoàn tác'),
            onClick: () => {
                if (pendingChapterDelete !== batch) return;
                clearTimeout(batch.timer);
                pendingChapterDelete = null;
                renderTOC();
            }
        }
    });
    if (!batch.toast) batch.timer = setTimeout(() => void flushChapterDelete(), TOAST_ACTION_MS);
}

async function flushChapterDelete() {
    const batch = pendingChapterDelete;
    if (!batch) return;
    pendingChapterDelete = null;
    clearTimeout(batch.timer);
    batch.toast?.dismissToast?.();
    if (STATE.user?.uid !== batch.uid) return;
    const indices = [...batch.indices].sort((a, b) => a - b);
    const isCurrent = () => STATE.currentBookId === batch.bookId;

    try {
        const formData = new FormData();
        formData.append('userId', batch.uid);
        formData.append('bookId', batch.bookId);
        formData.append('filename', batch.filename);
        formData.append('indices', JSON.stringify(indices));

        const response = await authFetch('/api/delete-chapters', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error || 'Failed to delete chapters');
        }

        const data = await response.json();
        STATE.libraryTocCache.delete(batch.bookId);

        // Calculate total chunks from metadata chapters
        const newTotalChunks = data.chapters.reduce((sum, ch) => sum + (ch.count || 0), 0);

        // Update Firestore total_chunks (to keep library in sync)
        const bookRef = doc(db, "users", batch.uid, "progress", batch.bookId);
        await setDoc(bookRef, { total_chunks: newTotalChunks }, { merge: true });

        // --- AUTO-DELETE STORY IF EMPTY ---
        if (data.chapters.length === 0) {
            APP_STATUS.toast(tr('delete-chapters-all', 'Tất cả các chương đã bị xóa. Đang gỡ truyện khỏi thư viện…'), 'info');
            await deleteBook(batch.bookId, batch.filename, batch.title, true);
            return;
        }
        if (!isCurrent()) return;

        // Update local state
        if (STATE.isSegmented) {
            // Re-allocate placeholders because chapters shifted
            STATE.currentBook.chapters = new Array(data.chapters.length).fill(null).map((_, i) => ({
                title: data.chapters[i].title,
                count: data.chapters[i].count,
                sentences: null
            }));
            STATE.loadedSegments.clear();
        } else {
            STATE.currentBook.chapters = data.chapters;
        }
        renderTOC();

        // Keep the same chapter under the reader when earlier ones were removed.
        const removedBefore = indices.filter(i => i < STATE.currentChapterIndex).length;
        STATE.currentChapterIndex = Math.max(0, STATE.currentChapterIndex - removedBefore);
        if (STATE.currentChapterIndex >= data.chapters.length) {
            STATE.currentChapterIndex = 0;
        }
        await renderChapter(STATE.currentChapterIndex);

    } catch (err) {
        console.error('Delete Error:', err);
        APP_STATUS.error(err, tr('delete-chapters-failed', 'Không thể xoá chương.'));
        if (isCurrent()) renderTOC();
    }
}

// --- Audio Logic ---
/**
 * Updates the Prefetch Progress UI to show buffer health (Ready Chunks / Target)
 */
function updatePrefetchUI() {
    // In lite-mode: prefetch status UI is hidden — skip all computation
    if (STATE.isLiteMode) return;
    if (!STATE.currentBook) return;

    const target = document.visibilityState === 'hidden'
        ? BACKGROUND_PREFETCH_CHUNKS
        : FOREGROUND_PREFETCH_CHUNKS;
    const currentGlobal = getGlobalIndex(STATE.currentChapterIndex, STATE.currentSentenceIndex);

    // Count ready chunks (in queue or already in MSE) that are AHEAD of current sentence
    const readyInQueue = STATE.appendQueue.filter(c => {
        const idx = getGlobalIndex(c.chapterIndex, c.index);
        return idx > currentGlobal;
    }).length;

    const readyInMSE = STATE.chunkTimings.filter(t => {
        const idx = getGlobalIndex(t.chapterIndex, t.index);
        return idx > currentGlobal;
    }).length;

    const readyCount = readyInQueue + readyInMSE;

    const progressEl = document.getElementById('prefetch-progress');
    const statusEl = document.getElementById('prefetch-status');

    if (progressEl && statusEl) {
        progressEl.innerText = `${readyCount}`;
        statusEl.dataset.zero = String(readyCount === 0);

        const isFetching = STATE.fetchingSet.size > 0;
        if (isFetching || (readyCount > 0 && readyCount < target)) {
            statusEl.classList.remove('hidden');
            statusEl.classList.add('flex');
        } else if (readyCount >= target && !isFetching) {
            // Buffer full, hide after 3s
            setTimeout(() => {
                if (STATE.fetchingSet.size === 0) {
                    statusEl.classList.add('hidden');
                    statusEl.classList.remove('flex');
                }
            }, 3000);
        }
    }
}

async function prefetchNext(startChapter, startSentence, count = null, immediate = false) {
    if (STATE.prefetchTimeout) clearTimeout(STATE.prefetchTimeout);

    const runPrefetch = async () => {
        if (STATE.socketParked) return;
        if (count === null) {
            count = document.visibilityState === 'hidden'
                ? BACKGROUND_PREFETCH_CHUNKS
                : FOREGROUND_PREFETCH_CHUNKS;
        }
        if (!STATE.ws || STATE.ws.readyState !== WebSocket.OPEN) {
            const connected = await waitForWebSocket();
            if (!connected) return;
        }
        if (!STATE.currentBook) return;

        // HIGH PERFORMANCE LOOKUP: Create a Set of all indices currently being handled
        const busyIndices = new Set();
        STATE.appendQueue.forEach(c => busyIndices.add(`${c.chapterIndex}_${c.index}`));
        STATE.chunkTimings.forEach(t => busyIndices.add(`${t.chapterIndex}_${t.index}`));
        STATE.fetchingSet.forEach(s => busyIndices.add(s));

        updatePrefetchUI();

        let currentChapIdx = startChapter;
        let currentSentIdx = startSentence + 1;

        // Keep roughly PREFETCH_AHEAD_SECONDS of audio requested ahead rather
        // than a fixed sentence count: in dialogue a dozen sentences can be
        // ~20s, shorter than one slow Edge request, which drained the buffer.
        const charBudget = PREFETCH_AHEAD_SECONDS * EST_CHARS_PER_SECOND * (STATE.settings.speed || 1);
        const maxSentences = Math.ceil(count * PREFETCH_MAX_COUNT_FACTOR * playbackFactor());
        let aheadChars = 0;

        for (let i = 0; i < maxSentences && (i < count || aheadChars < charBudget); i++) {
            // Check if we reached the end of the chapter
            const currentChapter = STATE.currentBook.chapters[currentChapIdx];
            const chapSentencesCount = currentChapter.count || (currentChapter.sentences ? currentChapter.sentences.length : 0);

            if (currentSentIdx >= chapSentencesCount) {
                currentChapIdx++;
                currentSentIdx = 0;
                if (currentChapIdx >= STATE.currentBook.chapters.length) break;
                // Move to next chapter - we might need to load its metadata/sentences later
                continue;
            }

            // Ensure sentences are loaded for prefetching
            if (!currentChapter.sentences) {
                // For prefetching, we'll just stop here and wait for the chapter to be needed
                // OR we can trigger a lazy load here. 
                // Let's trigger a lazy load so prefetching continues smoothly.
                await fetchChapterSentences(currentChapIdx);
            }
            aheadChars += (STATE.currentBook.chapters[currentChapIdx].sentences?.[currentSentIdx] || '').length;

            const key = `${currentChapIdx}_${currentSentIdx}`;
            if (busyIndices.has(key)) {
                currentSentIdx++;
                continue;
            }

            // --- OFFLINE CACHE CHECK ---
            const cachedBlob = await OFFLINE_MANAGER.getBlob(STATE.currentBookId, currentChapIdx, currentSentIdx);
            if (cachedBlob) {
                console.log(`[Offline] Using cached audio for ${key}`);
                const arrayBuffer = await cachedBlob.arrayBuffer();

                // Simulate a metadata arrival if needed, or just push directly
                // For simplified logic, we assume metadata for cached blobs is not strictly needed for basic playback
                // But normally we'd want the 'metadata' (word timings) too.
                // For now, let's just push with empty metadata to allow fluid playback.
                STATE.appendQueue.push({
                    index: currentSentIdx,
                    chapterIndex: currentChapIdx,
                    sessionId: STATE.sessionId,
                    data: arrayBuffer,
                    ttsSpeed: OFFLINE_MANAGER.speeds.get(`${STATE.currentBookId}_${key}`) ?? ttsSpeed(),
                    metadata: [] // Cached blobs might not have word timings saved yet
                });
                processAppendQueue();
                currentSentIdx++;
                continue;
            }

            if (!STATE.currentBook) return;
            let sentences = STATE.currentBook.chapters[currentChapIdx]?.sentences;
            if (!sentences) {
                await fetchChapterSentences(currentChapIdx).catch(() => false);
                sentences = STATE.currentBook?.chapters[currentChapIdx]?.sentences;
                if (!sentences) break;
            }
            if (sentences[currentSentIdx] === undefined) break;
            if (!STATE.ws || STATE.ws.readyState !== WebSocket.OPEN) return;

            STATE.fetchingSet.add(key);
            const text = applySkipDictionary(sentences[currentSentIdx]);
            const { voice, pitch, volume } = STATE.settings;
            const rate = ttsRate();

            STATE.ws.send(JSON.stringify({
                type: "PREFETCH",
                parts: true, // progressive delivery: play the first piece without waiting for the rest
                index: currentSentIdx,
                chapterIndex: currentChapIdx,
                text: text,
                voice: voice,
                rate: rate,
                pitch: pitch,
                volume: volume,
                numWorkers: STATE.settings.numWorkers,
                ...ttsToggles(),
                sessionId: STATE.sessionId
            }));

            currentSentIdx++;
        }
    };

    if (immediate) {
        runPrefetch();
    } else {
        STATE.prefetchTimeout = setTimeout(runPrefetch, 15);
    }
}

let playRequestsInFlight = 0;

async function playFromSentence(...args) {
    playRequestsInFlight++;
    try {
        return await startPlaybackFrom(...args);
    } finally {
        playRequestsInFlight--;
        const indicator = document.getElementById('status-indicator');
        if (playRequestsInFlight === 0 && audio.paused && indicator
            && statusMatches(indicator.innerText, 'status-buffering', 'status-tts-wait', 'status-connecting')) {
            indicator.innerText = tr('status-ready', 'Ready');
        }
    }
}

async function startPlaybackFrom(index, expectedLoadGeneration = STATE.loadGeneration, isSuperseded = null) {
    if (!STATE.currentBook) return;
    STATE.playIntentAt = Date.now();
    const loadToken = {};
    STATE.playLoadToken = loadToken;
    setPlayLoading();
    try {
        await startPlaybackAt(index, expectedLoadGeneration, isSuperseded);
    } finally {
        if (STATE.playLoadToken === loadToken && STATE.playLoading) {
            STATE.playLoading = false;
            setPlayIcon(!audio.paused);
        }
    }
}

async function startPlaybackAt(index, expectedLoadGeneration, isSuperseded) {
    STATE.socketParked = false;
    const expectedBookId = STATE.currentBookId;
    const isCurrentPlayback = () => (
        expectedLoadGeneration === STATE.loadGeneration &&
        expectedBookId === STATE.currentBookId &&
        STATE.currentBook &&
        !isSuperseded?.()
    );

    // 0. Robust Engine Reset - Dọn dẹp triệt để phiên cũ (dừng audio, xóa buffer, reset sessionId)
    await resetAudioEngine();
    if (!isCurrentPlayback()) return;

    // Dọn dẹp cache cũ khi nhảy tới vị trí mới (jump) - "Dọn dẹp sạch cho cái mới đi vào"
    await OFFLINE_MANAGER.clearCache();
    if (!isCurrentPlayback()) return;

    if (!(await waitForWebSocket())) {
        if (!isCurrentPlayback()) return;
        document.getElementById('status-indicator').innerText = connectionFailedStatus();
        return;
    }
    if (!isCurrentPlayback()) return;

    const chapter = STATE.currentBook.chapters[STATE.currentChapterIndex];
    if (!chapter.sentences) {
        await fetchChapterSentences(STATE.currentChapterIndex);
    }
    if (!isCurrentPlayback()) return;

    STATE.currentSentenceIndex = index;
    const sentences = STATE.currentBook.chapters[STATE.currentChapterIndex].sentences;
    // Mark where playback will start while the audio is still loading.
    highlightSentence(index);

    // Use the sessionId incremented by resetAudioEngine
    const currentSessionId = STATE.sessionId;
    STATE.lastAppendedIndex = index - 1; // Restart sequence from the target index
    STATE.lastAppendedPartKey = null;
    STATE.lastAppendedPart = -1;
    STATE.lastAppendedChapter = STATE.currentChapterIndex;
    console.log(`Starting new audio session: ${currentSessionId} (Jump to chunk ${index})`);

    updatePrefetchUI();
    document.getElementById('status-indicator').innerText = tr('status-buffering', 'Buffering…');
    const { voice, pitch, volume } = STATE.settings;
    const rate = ttsRate();

    // --- OFFLINE CACHE CHECK ---
    const cachedBlob = await OFFLINE_MANAGER.getBlob(STATE.currentBookId, STATE.currentChapterIndex, index);
    if (cachedBlob) {
        console.log(`[Offline] Using cached audio for ${STATE.currentChapterIndex}_${index}`);
        const arrayBuffer = await cachedBlob.arrayBuffer();
        if (!isCurrentPlayback()) return;
        STATE.appendQueue.push({
            index: index,
            chapterIndex: STATE.currentChapterIndex,
            sessionId: currentSessionId,
            data: arrayBuffer,
            ttsSpeed: OFFLINE_MANAGER.speeds.get(`${STATE.currentBookId}_${STATE.currentChapterIndex}_${index}`) ?? ttsSpeed(),
            metadata: []
        });
        processAppendQueue();
    } else {
        if (!isCurrentPlayback()) return;
        // Request the new starting sentence
        STATE.ws.send(JSON.stringify({
            type: "PREFETCH",
            parts: true, // progressive delivery: play the first piece without waiting for the rest
            index: index,
            chapterIndex: STATE.currentChapterIndex,
            text: applySkipDictionary(sentences[index]),
            voice: voice,
            rate: rate,
            pitch: pitch,
            volume: volume,
            numWorkers: STATE.settings.numWorkers,
            ...ttsToggles(),
            sessionId: currentSessionId
        }));
    }

    // Wait for the first chunk to be appended so we can start playback
    console.log(`Waiting for first chunk of session ${currentSessionId}...`);
    // Edge has outage bursts of ~10-30s; the chunk retry loop rides them out,
    // so wait long enough for it instead of silently giving up after 10s.
    let attempts = 0;
    while (STATE.chunkTimings.length === 0 && attempts < 300) {
        if (STATE.sessionId !== currentSessionId || !isCurrentPlayback()) return; // User jumped or loaded another book
        await new Promise(r => setTimeout(r, 100));
        attempts++;
        if (attempts === 50) document.getElementById('status-indicator').innerText = tr('status-tts-wait', 'Đang chờ máy chủ TTS…');
    }
    if (STATE.chunkTimings.length === 0 && STATE.sessionId === currentSessionId && isCurrentPlayback()) {
        document.getElementById('status-indicator').innerText = tr('status-tts-timeout', 'TTS không đáp · bấm Play');
    }

    if (STATE.chunkTimings.length > 0 && STATE.sessionId === currentSessionId && isCurrentPlayback()) {
        try {
            applyPlaybackRate();
            await audio.play();
        } catch (err) {
            // Do not claim playback is active when the browser rejected
            // autoplay. The old code marked STATE.isPlaying=true anyway,
            // which made inactivity handling save the initial sentence.
            STATE.isPlaying = false;
            document.getElementById('status-indicator').innerText = tr('status-autoplay-blocked', 'Bấm Play để nghe');
            console.warn("Auto-play blocked; waiting for user gesture:", err);
            return;
        }
        if (!isCurrentPlayback()) return;
        STATE.isPlaying = true;
        updateUI();
        highlightSentence(index);
        // Persist the starting sentence only after playback really starts.
        void saveProgress(true).catch(err => console.debug('[Progress] Playback-start save skipped:', err.message));

        if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = 'playing';
            updateMediaSession();
        }

        // Immediate: in a hidden, previously silent tab Chrome can defer the
        // 15ms debounce timer for up to a minute, leaving only one sentence
        // buffered and stalling playback right after it.
        prefetchNext(STATE.currentChapterIndex, index, null, true);
        saveProgress(false);
    }
}

// Opening or resuming a book: put the saved sentence in the middle of the screen
// and mark it before any audio arrives.
function revealCurrentSentence() {
    const index = STATE.currentSentenceIndex;
    highlightSentence(index);
    const sentence = document.getElementById(`sentence-${index}`);
    if (!sentence || index <= 0) return;
    requestAnimationFrame(() => sentence.scrollIntoView({ block: 'center', behavior: 'instant' }));
}

function highlightSentence(index) {
    // --- OPTIMIZED: Use targeted removal instead of querySelectorAll ---
    if (STATE.lastHighlightedIndex !== -1 && STATE.lastHighlightedIndex !== index) {
        const prev = document.getElementById(`sentence-${STATE.lastHighlightedIndex}`);
        if (prev) {
            prev.classList.remove('chunk-active');
            prev.classList.remove('karaoke-flow');
        }

        // Skip minimap DOM access in lite-mode (minimap is hidden/removed)
        if (!STATE.isLiteMode) {
            const prevMini = document.getElementById(`minimap-node-${STATE.lastHighlightedIndex}`);
            if (prevMini) prevMini.classList.remove('minimap-active');
        }
    }

    const cur = document.getElementById(`sentence-${index}`);
    if (cur) {
        cur.classList.add('chunk-active');
        if (!STATE.isLiteMode) {
            cur.classList.add('karaoke-flow');
        }
        STATE.lastHighlightedIndex = index;

        const container = document.getElementById('text-container');
        if (container) {
            const containerHeight = container.offsetHeight;
            const offsetTop = cur.offsetTop;
            const currentScroll = container.scrollTop;

            // Calculate relative position within the container viewport
            const relativePos = offsetTop - currentScroll;
            const relativePercent = relativePos / containerHeight;

            // Comfort Zone Logic: Sweet-spot auto scroll when text is outside 18% - 58%
            if (relativePercent < 0.18 || relativePercent > 0.58) {
                const targetScroll = Math.max(0, offsetTop - (containerHeight * 0.28));
                if (STATE.isLiteMode) {
                    container.scrollTop = targetScroll;
                } else {
                    container.scrollTo({
                        top: targetScroll,
                        behavior: scrollBehavior()
                    });
                }
            }
        }
    }

    // Minimap sync (skip in lite-mode)
    if (!STATE.isLiteMode) {
        const miniNode = document.getElementById(`minimap-node-${index}`);
        if (miniNode) {
            miniNode.classList.add('minimap-active');
            miniNode.scrollIntoView({ behavior: scrollBehavior(), block: 'nearest' });
        }
    }

    if (STATE.isLiteMode) {
        updatePocketModeInfo();
    }
}

async function togglePlayback() {
    AudioHapticFX.trigger(12);
    if (!STATE.currentBook) return;

    if (audio.paused) {
        // A second tap while the first is still loading would restart the request.
        if (STATE.playLoading) return;
        if (wsRefusedRecently()) setPlaybackElsewhere('busy', { flash: true });
        STATE.socketParked = false;
        // Buffered audio resumes at once, still inside the user activation that media keys
        // (Bluetooth headsets, keyboards, lock screen) only grant briefly; audio.onplay
        // reconnects the socket and refills the buffer afterwards.
        if (STATE.chunkTimings.length && hasBufferedAhead()) {
            await resumeAudio();
            setPlayIcon(!audio.paused);
            return;
        }
        STATE.playIntentAt = Date.now();
        setPlayLoading();
        document.getElementById('status-indicator').innerText = tr('status-connecting', 'Connecting…');
        const connected = await waitForWebSocket();
        STATE.playLoading = false;
        if (!connected) {
            setPlayIcon(false);
            document.getElementById('status-indicator').innerText = connectionFailedStatus();
            return;
        }
        if (STATE.chunkTimings.length === 0) {
            await playFromSentence(STATE.currentSentenceIndex);
        } else {
            await resumeAudio();
            setPlayIcon(!audio.paused);
        }
    } else {
        audio.pause();
    }
}

playBtn.onclick = () => togglePlayback();
// Pointer presses on console buttons drop focus, so a later Space/arrow shortcut does not
// light the keyboard focus ring around the round play button. Keyboard activation keeps it.
document.getElementById('media-player')?.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (button && event.detail > 0) button.blur();
});
document.getElementById('console-elsewhere-btn')?.addEventListener('click', () => void takeOverPlayback());


audio.onplay = async () => {
    STATE.socketParked = false;
    STATE.isTransitioning = false;
    STATE.isPlaying = true;
    STATE.pauseTimeoutHandled = false;

    // [Audio Waves] Activate wave motion
    setAudioWaveState(true);

    // [TASK 3] Reset stall recovery counters on successful play
    STATE._stallRecoveryCount = 0;
    STATE._stallWaitCount = 0;
    STATE.streamingRetryCount.clear();

    setPlayIcon(true);
    document.getElementById('status-indicator').innerText = tr('status-streaming', 'Streaming');
    updatePipUI();

    if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'playing';
    }

    // FIX: Auto-reconnect if WebSocket is closed (e.g. resumed from Bluetooth/Background)
    if (STATE.currentBook && (!STATE.ws || STATE.ws.readyState !== WebSocket.OPEN)) {
        console.log("Playback resumed but WebSocket is closed. Reconnecting...");
        try {
            const connected = await waitForWebSocket();
            if (!connected) throw new Error("WebSocket connection timeout.");

            if (STATE.currentSentenceIndex !== -1) {
                console.log(`Current sentence ${STATE.currentSentenceIndex} is already buffered. Resuming prefetch...`);
                prefetchNext(STATE.currentChapterIndex, STATE.currentSentenceIndex);
            }
        } catch (e) {
            console.error("Failed to auto-reconnect on play:", e);
        }
    }
};

audio.onpause = () => {
    STATE.isPlaying = false;
    STATE.pauseTimeoutHandled = false;

    // [Audio Waves] Deactivate wave motion
    setAudioWaveState(false);

    setPlayIcon(false);
    setStatusKeepingStopReason(tr('status-paused', 'Paused'));
    updatePipUI();
    if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'paused';
    }
    if (!STATE.isTransitioning && !audio.ended) {
        saveProgress(true); // Checkpoint progress on manual pause or buffer wait
        if (STATE.user && !STATE.strictSyncMode) STATS_MANAGER.syncToFirestore();
    }
};

// In-app rename dialog (themeable, unlike prompt()). Resolves to the trimmed
// new title, or null when cancelled.
let renameDialog = null;

function askBookTitle(currentTitle) {
    const modal = document.getElementById('rename-modal');
    const form = document.getElementById('rename-form');
    const input = document.getElementById('rename-input');
    if (!modal || !form || !input) return Promise.resolve(null);
    renameDialog?.finish(null);
    return new Promise(resolve => {
        const finish = (value) => {
            if (renameDialog?.finish !== finish) return;
            renameDialog = null;
            modal.removeEventListener('keydown', onKey);
            form.removeEventListener('submit', onSubmit);
            modal.querySelectorAll('[data-close-rename]').forEach(el => el.removeEventListener('click', onCancel));
            input.removeAttribute('aria-invalid');
            setModalVisibility('rename-modal', false);
            resolve(value);
        };
        const onCancel = () => finish(null);
        const onSubmit = (event) => {
            event.preventDefault();
            const value = input.value.trim();
            if (!value) {
                input.setAttribute('aria-invalid', 'true');
                input.focus();
                return;
            }
            finish(value);
        };
        const onKey = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                finish(null);
                return;
            }
            trapTab(modal, event);
        };
        renameDialog = { finish };
        input.value = currentTitle || '';
        modal.addEventListener('keydown', onKey);
        form.addEventListener('submit', onSubmit);
        modal.querySelectorAll('[data-close-rename]').forEach(el => el.addEventListener('click', onCancel));
        setModalVisibility('rename-modal', true);
        requestAnimationFrame(() => input.select());
    });
}

// In-app replacement for confirm(). Resolves true only on the confirm button.
let confirmDialog = null;

function askConfirm({ title, message, confirmLabel, danger = false }) {
    const modal = document.getElementById('confirm-modal');
    const okBtn = document.getElementById('confirm-modal-ok');
    if (!modal || !okBtn) return Promise.resolve(false);
    confirmDialog?.finish(false);
    return new Promise(resolve => {
        const finish = (value) => {
            if (confirmDialog?.finish !== finish) return;
            confirmDialog = null;
            modal.removeEventListener('keydown', onKey);
            okBtn.removeEventListener('click', onOk);
            modal.querySelectorAll('[data-close-confirm]').forEach(el => el.removeEventListener('click', onCancel));
            setModalVisibility('confirm-modal', false);
            resolve(value);
        };
        const onOk = () => finish(true);
        const onCancel = () => finish(false);
        const onKey = (event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            finish(false);
        };
        confirmDialog = { finish };
        document.getElementById('confirm-modal-title').textContent = title;
        document.getElementById('confirm-modal-msg').textContent = message;
        okBtn.textContent = confirmLabel;
        okBtn.className = `btn ${danger ? 'btn--destructive' : 'btn--primary'}`;
        modal.addEventListener('keydown', onKey);
        okBtn.addEventListener('click', onOk);
        modal.querySelectorAll('[data-close-confirm]').forEach(el => el.addEventListener('click', onCancel));
        setModalVisibility('confirm-modal', true);
    });
}

async function editTitle() {
    if (!STATE.currentBook || !STATE.user) return;
    const previousTitle = STATE.currentBook.title;
    const newTitle = await askBookTitle(displayTitle(previousTitle));
    if (!newTitle || newTitle === previousTitle || !STATE.currentBook) return;

    STATE.currentBook.title = newTitle;
    document.getElementById('current-title').innerText = displayTitle(newTitle);
    document.getElementById('current-title').title = displayTitle(newTitle);
    const tocLabel = document.getElementById('toc-book-label');
    if (tocLabel) tocLabel.textContent = displayTitle(newTitle);
    updateUI(); // Keep player and author tokens in sync

    try {
        // Force save with new title and verify the write before refreshing the
        // library. A failed write must not silently restore the old title.
        const saved = await saveProgress(true);
        if (!saved) throw new Error('Firestore did not save the new title');
        const storedProgress = await loadProgress(STATE.currentBookId);
        if (storedProgress?.title !== newTitle) {
            throw new Error('Firestore returned a different title after saving');
        }
        await refreshLibrary();
        APP_STATUS.toast(tr('rename-done', 'Đã đổi tên truyện.'), 'success');
    } catch (err) {
        STATE.currentBook.title = previousTitle;
        document.getElementById('current-title').innerText = displayTitle(previousTitle);
        document.getElementById('current-title').title = displayTitle(previousTitle);
        if (tocLabel) tocLabel.textContent = displayTitle(previousTitle);
        updateUI();
        console.error('[Title] Save failed:', err);
        APP_STATUS.error(tr('rename-failed', 'Không thể lưu tên truyện: {reason}', { reason: err.message }));
    }
}

audio.onended = () => {
    console.log("Audio ended (buffer empty)");
    // BỎ CÂU LỆNH: document.getElementById('next-btn').click();

    // Nếu hết buffer thực sự, kích hoạt tải chunk nối tiếp
    if (STATE.currentBook) {
        let lastChap = STATE.chunkTimings.length > 0 ? STATE.chunkTimings[STATE.chunkTimings.length - 1].chapterIndex : STATE.currentChapterIndex;
        let lastIdx = STATE.chunkTimings.length > 0 ? STATE.chunkTimings[STATE.chunkTimings.length - 1].index : STATE.currentSentenceIndex;
        prefetchNext(lastChap, lastIdx);
    }
};

audio.onwaiting = () => {
    if (!STATE.isPlaying || STATE.isTransitioning) return;

    const curTime = audio.currentTime;
    const bufferEnd = STATE.sourceBuffer.buffered.length > 0
        ? STATE.sourceBuffer.buffered.end(STATE.sourceBuffer.buffered.length - 1)
        : 0;

    if (bufferEnd > 0 && Math.abs(curTime - bufferEnd) < 0.3) {
        console.log("Stall detected at buffer end. Nudging and recovery...");

        // Gap Nudge: if we have next chunks in queue but stuck at end, tiny jump
        if (STATE.appendQueue.length > 0 || STATE.fetchingSet.size > 0) {
            audio.currentTime += 0.1;
        }

        // Forced recovery from last known position
        let lastChap = STATE.chunkTimings.length > 0 ? STATE.chunkTimings[STATE.chunkTimings.length - 1].chapterIndex : STATE.currentChapterIndex;
        let lastIdx = STATE.chunkTimings.length > 0 ? STATE.chunkTimings[STATE.chunkTimings.length - 1].index : STATE.currentSentenceIndex;
        prefetchNext(lastChap, lastIdx, null, true); // Immediate fetch
    }
};

audio.ontimeupdate = async () => {
    if (STATE.isTransitioning || STATE.isSwitchingChapter) return;
    const curTime = audio.currentTime || 0;

    // --- OPTIMIZATION: Throttle execution frequency ---
    // Lite-mode: ~1Hz (0.9s interval) — minimal CPU footprint
    // Normal-mode: ~6Hz (0.15s interval) — smooth UI sync
    const throttleInterval = STATE.isLiteMode ? 0.9 : 0.15;
    if (Math.abs(curTime - STATE.lastOntimeUpdateTick) < throttleInterval) return;
    STATE.lastOntimeUpdateTick = curTime;
    applyPlaybackRate();

    // --- UI Synchronization via chunkTimings ---
    if (STATE.chunkTimings.length > 0) {
        // Find which chunk we are currently in
        let currentChunk = STATE.chunkTimings[0];
        for (let i = STATE.chunkTimings.length - 1; i >= 0; i--) {
            if (curTime >= STATE.chunkTimings[i].startTime) {
                currentChunk = STATE.chunkTimings[i];
                break;
            }
        }

        if (currentChunk && (currentChunk.index !== STATE.currentSentenceIndex || currentChunk.chapterIndex !== STATE.currentChapterIndex)) {
            // Chapter Change Detection
            if (currentChunk.chapterIndex !== STATE.currentChapterIndex) {
                // "Hết chương" sleep timer: stop right at the boundary.
                if (STATE.sleepTimerMode === 'chapter' && STATE.sleepTimer) {
                    expireSleepTimer();
                    return;
                }
                console.log(`Transitioning to Chapter ${currentChunk.chapterIndex}`);
                await renderChapter(currentChunk.chapterIndex);

                // [FIX]: Chỉ cập nhật Mục lục nếu tab Mục lục đang mở, tránh lỗi tự động trượt ra trên di động do hàm scrollIntoView
                if (isTOCVisible()) {
                    refreshTOCCurrent();
                    scrollTOCCurrentChapter();
                }

                if ('mediaSession' in navigator) {
                    updateMediaSession();
                }
            }

            STATE.currentSentenceIndex = currentChunk.index;
            highlightSentence(STATE.currentSentenceIndex);
            updatePrefetchUI();
            prefetchNext(currentChunk.chapterIndex, STATE.currentSentenceIndex);
            saveProgress(false);
            updateUI(); // Keep player display in sync
        }
    }

    // --- Segmentation: 80% Proactive Fetching ---
    if (STATE.isSegmented) {
        const chaptersInSegment = STATE.segmentSize || 100;
        const currentRelativeIdx = STATE.currentChapterIndex % chaptersInSegment;
        const nextSegmentIdx = Math.floor(STATE.currentChapterIndex / chaptersInSegment) + 1;

        if (currentRelativeIdx >= 80 && nextSegmentIdx < STATE.segmentsCount && !STATE.loadedSegments.has(nextSegmentIdx)) {
            console.log(`[Segmentation] 80% mark reached in segment. Prefetching segment ${nextSegmentIdx}...`);
            fetchSegment(nextSegmentIdx); // Background fetch
        }
    }

    // --- Proactive Buffer Health Monitor ---
    const bufferEnd = (STATE.sourceBuffer && STATE.sourceBuffer.buffered.length > 0)
        ? STATE.sourceBuffer.buffered.end(STATE.sourceBuffer.buffered.length - 1)
        : 0;

    const timeRemaining = bufferEnd - curTime;
    // If buffer < 5 seconds of listening and not currently fetching, top up from the last known buffered chunk
    if (timeRemaining > 0 && timeRemaining < 5.0 * audio.playbackRate && STATE.fetchingSet.size === 0) {
        let lastChap = STATE.chunkTimings.length > 0 ? STATE.chunkTimings[STATE.chunkTimings.length - 1].chapterIndex : STATE.currentChapterIndex;
        let lastIdx = STATE.chunkTimings.length > 0 ? STATE.chunkTimings[STATE.chunkTimings.length - 1].index : STATE.currentSentenceIndex;
        prefetchNext(lastChap, lastIdx);
    }

    // --- Memory Management (Buffer Cleanup) ---
    if (STATE.sourceBuffer && !STATE.sourceBuffer.updating && curTime > 300) {
        try {
            // Keep the last 10 seconds of played audio to prevent glitches when seeking back slightly
            const removeEnd = curTime - 10;
            if (removeEnd > 10) {
                console.log(`Cleaning up buffer: 0 to ${removeEnd.toFixed(2)}s`);
                STATE.sourceBuffer.remove(0, removeEnd);

                // FIXED MEMORY LEAK: Clean up old elements from chunkTimings
                STATE.chunkTimings = STATE.chunkTimings.filter(t => t.startTime >= removeEnd);
            }
        } catch (e) {
            console.error("Buffer cleanup error:", e);
        }
    }

    // --- Progress Bar & Time Sync ---
    if (STATE.currentBook) {
        const chapter = STATE.currentBook.chapters[STATE.currentChapterIndex];
        const total = chapter.count || (chapter.sentences ? chapter.sentences.length : 0);
        const current = STATE.currentSentenceIndex + 1;

        if (total > 0) {
            const chunkProgress = (current / total) * 100;
            const chunkProgressStr = `${chunkProgress}%`;
            const currentMockStr = `${current} / ${total}`;

            if (STATE.lastProgressWidth !== chunkProgressStr) {
                document.getElementById('progress-bar').style.width = chunkProgressStr;
                STATE.lastProgressWidth = chunkProgressStr;
            }
            if (STATE.lastCurrentMock !== currentMockStr) {
                document.getElementById('current-time-mock').innerText = currentMockStr;
                STATE.lastCurrentMock = currentMockStr;
            }
        }

        const fmt = (s) => new Date(s * 1000).toISOString().substr(14, 5);
        const timeStr = fmt(curTime);
        if (STATE.lastTimeStr !== timeStr) {
            document.getElementById('time-display').innerText = timeStr;
            STATE.lastTimeStr = timeStr;
        }
    }
};

// --- Settings ---
// Cài đặt chỉ lưu local: đổi giọng/tốc độ/pitch/workers/màu chữ không còn
// ghi vào Firestore tiến độ của từng truyện nữa.
function persistLocalSettings() {
    try {
        const { fontSize, ...core } = STATE.settings;
        localStorage.setItem(LOCAL_SETTINGS_KEY, JSON.stringify(core));
    } catch (err) {
        console.debug('[Settings] Local persist skipped:', err.message);
    }
}

const scheduleBookSettingsSave = debounce(persistLocalSettings, 300);

// Server-side TTS toggles sent with every PREFETCH request.
function ttsToggles() {
    return {
        useProxy: STATE.settings.useProxy !== false,
        gttsFallback: STATE.settings.gttsFallback === true,
    };
}

for (const [id, key] of [['proxy-toggle', 'useProxy'], ['gtts-toggle', 'gttsFallback']]) {
    const toggle = document.getElementById(id);
    if (toggle) toggle.onchange = (e) => {
        STATE.settings[key] = e.target.checked;
        scheduleBookSettingsSave();
    };
}

document.getElementById('voice-select').onchange = (e) => {
    STATE.settings.voice = e.target.value;
    scheduleBookSettingsSave();
};
function formatSpeed(value) {
    const v = Math.round(Number(value) * 100) / 100;
    return `${Number.isInteger(v * 10) ? v.toFixed(1) : v.toFixed(2)}×`;
}

document.getElementById('speed-range').oninput = (e) => {
    STATE.settings.speed = Math.round(parseFloat(e.target.value) * 100) / 100;
    document.getElementById('speed-val').innerText = formatSpeed(STATE.settings.speed);
    applyPlaybackRate();
    scheduleBookSettingsSave();
};
document.getElementById('pitch-range').oninput = (e) => {
    const val = parseInt(e.target.value);
    const pitchStr = `${val >= 0 ? '+' : ''}${val}Hz`;
    STATE.settings.pitch = pitchStr;
    document.getElementById('pitch-val').innerText = pitchStr;
    scheduleBookSettingsSave();
};

document.getElementById('prefetch-range').oninput = (e) => {
    const stepIndex = parseInt(e.target.value);
    const count = WORKER_STEPS[stepIndex];
    STATE.settings.numWorkers = count;
    document.getElementById('prefetch-val').innerText = String(count);
    // Trigger immediate prefetch to fill the new buffer size if needed
    prefetchNext(STATE.currentChapterIndex, STATE.currentSentenceIndex);
    scheduleBookSettingsSave();
};

// --- Typography settings ---
const debouncedApplyTypography = debounce(() => {
    applyTypographySettings();
    scheduleBookSettingsSave();
}, 350);

document.getElementById('font-size-range').oninput = (e) => {
    const val = parseInt(e.target.value);
    STATE.settings.fontSize = val;
    localStorage.setItem('reader-font-size', val);
    document.getElementById('font-size-val').innerText = `${val}px`;

    // Instant preview via CSS variable
    document.documentElement.style.setProperty('--reader-font-size', `${val}px`);

    debouncedApplyTypography();
};

document.getElementById('font-color-picker').oninput = (e) => {
    const val = e.target.value;
    STATE.settings.textColor = val;

    // Instant preview via CSS variable
    document.documentElement.style.setProperty('--reader-text-color', val);
    delete document.documentElement.dataset.readerColor;
    syncColorPresets();

    debouncedApplyTypography();
};

document.getElementById('color-reset-btn').onclick = () => {
    STATE.settings.textColor = "default";
    applyTypographySettings();
    scheduleBookSettingsSave();
};

document.querySelectorAll('.preset-color').forEach(btn => {
    btn.onclick = () => {
        if (btn.getAttribute('aria-disabled') === 'true') {
            APP_STATUS.toast(tr('text-color-low-contrast', 'Màu này khó đọc trên giao diện hiện tại.'), 'info', { key: 'text-color' });
            return;
        }
        const color = btn.dataset.color;
        STATE.settings.textColor = color;
        applyTypographySettings();
        scheduleBookSettingsSave();
    };
});

function applyFontFamily(fontFamily, syncElements = true) {
    if (!fontFamily) fontFamily = DEFAULT_READER_FONT;
    STATE.settings.fontFamily = fontFamily;
    try {
        localStorage.setItem('reader-font-family', fontFamily);
    } catch (_) {}

    ensureReaderFont(fontFamily);
    document.documentElement.style.setProperty('--reader-font-family', readerFontStack(fontFamily));
    
    if (syncElements) {
        const sel1 = document.getElementById('font-family-select');
        if (sel1) sel1.value = fontFamily;
    }
}

// Bind Font Selectors
const fontSelect = document.getElementById('font-family-select');
if (fontSelect) {
    fontSelect.onchange = (e) => {
        applyFontFamily(e.target.value);
    };
}

// The reader hides the app header below 1024px; its ⋮ menu stands in for these two buttons.
document.getElementById('reader-settings-btn')?.addEventListener('click', () => window.SettingsSheet?.open('listen'));
document.getElementById('reader-search-btn')?.addEventListener('click', () => document.getElementById('header-search-btn')?.click());

function applyTypographySettings() {
    const s = STATE.settings;
    const root = document.documentElement;

    // Apply Font Size
    root.style.setProperty('--reader-font-size', `${s.fontSize}px`);

    // Apply Font Family
    const currentFont = localStorage.getItem('reader-font-family') || DEFAULT_READER_FONT;
    applyFontFamily(currentFont, true);

    // Apply Text Color
    if (s.textColor === "gold") {
        root.dataset.readerColor = "gold";
        root.style.setProperty('--reader-text-color', 'var(--color-gold)');
    } else if (s.textColor === "default") {
        delete root.dataset.readerColor;
        root.style.setProperty('--reader-text-color', 'var(--theme-text-reading)');
        const defaultColor = getComputedStyle(root).getPropertyValue('--theme-text-reading').trim() || "#CBD5E1";
        const colorPicker = document.getElementById('font-color-picker');
        if (colorPicker && defaultColor.startsWith('#')) {
            colorPicker.value = defaultColor;
        }
    } else {
        delete root.dataset.readerColor;
        root.style.setProperty('--reader-text-color', s.textColor);
        const colorPicker = document.getElementById('font-color-picker');
        if (colorPicker) colorPicker.value = s.textColor;
    }
    syncColorPresets();
}

function syncColorPresets() {
    const current = String(STATE.settings.textColor || '').toLowerCase();
    document.getElementById('color-reset-btn')?.setAttribute('aria-pressed', String(current === 'default'));
    document.querySelectorAll('.preset-color').forEach(btn => {
        btn.setAttribute('aria-pressed', String(btn.dataset.color.toLowerCase() === current));
    });
}

const MIN_TEXT_CONTRAST = 4.5;
let colorProbeCtx = null;

// Resolves any CSS colour (hex, oklch…) to sRGB by painting one canvas pixel.
function cssColorToRgb(color) {
    if (!color) return null;
    if (!colorProbeCtx) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        colorProbeCtx = canvas.getContext('2d', { willReadFrequently: true });
    }
    const ctx = colorProbeCtx;
    if (!ctx) return null;
    ctx.fillStyle = '#010203';
    ctx.fillStyle = color.trim();
    if (ctx.fillStyle === '#010203') return null;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b];
}

function contrastRatio(a, b) {
    const lum = ([r, g, b]) => {
        const ch = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
    };
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

function readerPaperRgb() {
    return cssColorToRgb(getComputedStyle(document.documentElement).getPropertyValue('--color-paper'));
}

function textColorFailsOn(paper, color) {
    if (!paper || !String(color || '').startsWith('#')) return false;
    const rgb = cssColorToRgb(color);
    return !!rgb && contrastRatio(rgb, paper) < MIN_TEXT_CONTRAST;
}

function syncPresetContrast(paper) {
    document.querySelectorAll('.preset-color').forEach(btn => {
        const fails = textColorFailsOn(paper, btn.dataset.color);
        if (fails) btn.setAttribute('aria-disabled', 'true');
        else btn.removeAttribute('aria-disabled');
    });
}

let lastThemeId = null;
window.addEventListener('themechange', (e) => {
    const themeId = e.detail?.themeId || null;
    const themeChanged = lastThemeId !== null && themeId !== lastThemeId;
    lastThemeId = themeId;
    const paper = readerPaperRgb();
    syncPresetContrast(paper);
    if (themeChanged && textColorFailsOn(paper, STATE.settings.textColor)) {
        STATE.settings.textColor = 'default';
        scheduleBookSettingsSave();
        APP_STATUS.toast(tr('text-color-reset-contrast', 'Màu chữ cũ khó đọc trên giao diện này nên đã chuyển về màu mặc định.'), 'info', { key: 'text-color' });
    }
    applyTypographySettings();
});

// --- UI Interactions ---
document.getElementById('prev-btn').onclick = () => playPrevChapter();
document.getElementById('next-btn').onclick = () => playNextChapter();
document.getElementById('prev-chunk-btn').onclick = () => playPrevChunk();
document.getElementById('next-chunk-btn').onclick = () => playNextChunk();

// Manual sync from the account menu: the menu closes on click, so the result is a toast and
// the row's "lúc HH:mm" value. "Đang đồng bộ…" stays up for at least 600ms.
const SYNC_MIN_MS = 600;
function librarySyncLabel() {
    if (libraryView.manualSync) return tr('library-syncing', 'Đang đồng bộ…');
    if (!libraryView.syncedAt) return '';
    const time = new Date(libraryView.syncedAt).toLocaleTimeString(uiLang() === 'vi' ? 'vi-VN' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
    return tr('sync-at', 'lúc {time}', { time });
}
async function syncLibraryNow() {
    if (!STATE.user) return refreshLibrary();
    if (libraryView.manualSync) return;
    const uid = STATE.user.uid;
    libraryView.manualSync = true;
    accountMenu?.render();
    try {
        await Promise.all([refreshLibrary(), new Promise(resolve => setTimeout(resolve, SYNC_MIN_MS))]);
    } finally {
        libraryView.manualSync = false;
        accountMenu?.render();
        applyLibraryFilters();
    }
    if (STATE.user?.uid !== uid) return;
    const ok = libraryView.status === 'ready';
    APP_STATUS.toast(ok
        ? trCount('sync-done', 'Đã đồng bộ · {n} truyện', discoveryLibrary.length)
        : tr('sync-failed', 'Không đồng bộ được thư viện. Thử lại nhé.'), ok ? 'success' : 'error', { key: `library-sync-${ok ? 'ok' : 'error'}` });
}
document.getElementById('edit-title-btn').onclick = () => editTitle();
document.getElementById('toc-download-txt-btn').onclick = () => {
    if (STATE.currentBookId) downloadTextBook(STATE.currentBookId, STATE.currentBook?.title);
};

// TOC Select Mode & Download
document.getElementById('toc-select-mode-btn').onclick = () => toggleSelectMode();
document.getElementById('toc-select-all-btn').onclick = () => selectAllChapters();
document.getElementById('toc-deselect-all-btn').onclick = () => deselectAllChapters();
document.getElementById('toc-download-btn').onclick = () => {
    if (STATE.isDownloading) {
        stopDownload();
    } else {
        downloadSelectedChapters();
    }
};

document.getElementById('toc-delete-btn').onclick = () => deleteSelectedChapters();

// The compact console row is the Home dock; #minimize-btn stays only as the PiP button's anchor.
function toggleMinimize(isMinimized) {
    const mediaPlayer = document.getElementById('media-player');
    if (isMinimized === undefined) isMinimized = !mediaPlayer.classList.contains('minimized-player');
    mediaPlayer.classList.toggle('minimized-player', isMinimized);
}

const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(err => {
            console.error(`Error attempting to enable fullscreen: ${err.message}`);
            if (fullscreenToggle) fullscreenToggle.checked = false;
        });
    } else {
        document.exitFullscreen();
    }
};

// iPhone Safari has no Fullscreen API; the Settings row only shows where it works.
const fullscreenToggle = document.getElementById('settings-fullscreen-toggle');
if (fullscreenToggle && document.fullscreenEnabled) {
    fullscreenToggle.closest('.set-row').hidden = false;
    fullscreenToggle.addEventListener('change', () => {
        if (fullscreenToggle.checked !== !!document.fullscreenElement) toggleFullscreen();
    });
    document.addEventListener('fullscreenchange', () => {
        fullscreenToggle.checked = !!document.fullscreenElement;
    });
}

// Performance / Lite Mode (Chế độ Chỉ Nghe Audio / Pocket Mode)
const liteModeToggle = document.getElementById('lite-mode-toggle');

/**
 * Updates Pocket Mode track info, current sentence preview and play/pause icon.
 */
function updatePocketModeInfo() {
    const pocketOverlay = document.getElementById('pocket-mode-overlay');
    if (!pocketOverlay || pocketOverlay.classList.contains('hidden')) return;

    const bookTitleEl = document.getElementById('pocket-book-title');
    const chapterTitleEl = document.getElementById('pocket-chapter-title');
    const sentenceEl = document.getElementById('pocket-sentence-preview');
    const playIcon = document.getElementById('pocket-play-icon');

    if (STATE.currentBook) {
        if (bookTitleEl) bookTitleEl.textContent = displayTitle(STATE.currentBook.title) || 'NOVA';
        const chap = STATE.currentBook.chapters?.[STATE.currentChapterIndex];
        if (chapterTitleEl) chapterTitleEl.textContent = `C.${STATE.currentChapterIndex + 1} · ${chap?.title || `${tr('chapter-word', 'Chương')} ${STATE.currentChapterIndex + 1}`}`;
        if (sentenceEl) {
            const curSentence = chap?.sentences?.[STATE.currentSentenceIndex];
            sentenceEl.textContent = curSentence ? `“${curSentence}”` : '';
        }
    } else {
        if (bookTitleEl) bookTitleEl.textContent = tr('pocket-no-book', 'Chưa chọn sách');
        if (chapterTitleEl) chapterTitleEl.textContent = tr('pocket-ready', 'Sẵn sàng phát');
        if (sentenceEl) sentenceEl.textContent = '';
    }

    playIcon?.querySelector('use')?.setAttribute('href', STATE.isPlaying ? '#i-pause' : '#i-play');
}
window.updatePocketModeInfo = updatePocketModeInfo;

// --- Anti-Accidental Touch Protection State (Chống chạm nhầm khi bỏ túi quần) ---
let pocketWakeTapCount = 0;
let pocketReturnFocus = null;
let pocketWakeTapTimer = null;
let pocketActiveDimTimer = null;

function setPocketAwake(isAwake) {
    const overlay = document.getElementById('pocket-mode-overlay');
    const exitIcon = document.getElementById('pocket-exit-icon');
    const exitLabel = document.getElementById('pocket-exit-label');
    if (overlay) overlay.dataset.awake = isAwake ? 'true' : 'false';
    overlay?.querySelectorAll('.pocket__btn').forEach(btn => btn.setAttribute('aria-disabled', String(!isAwake)));
    exitIcon?.querySelector('use')?.setAttribute('href', isAwake ? '#i-unlock' : '#i-lock');
    if (exitLabel) {
        const key = isAwake ? 'pocket-tap-again' : 'pocket-mode-exit';
        exitLabel.dataset.i18n = key;
        exitLabel.textContent = tr(key, isAwake ? 'Chạm lần nữa để mở khoá' : 'Chạm 2 lần để mở màn hình');
    }
}

function brightenPocketOverlay() {
    setPocketAwake(true);
    if (pocketActiveDimTimer) clearTimeout(pocketActiveDimTimer);
    pocketActiveDimTimer = setTimeout(dimPocketOverlay, 2400);
}

function dimPocketOverlay() {
    setPocketAwake(false);
    pocketWakeTapCount = 0;
}

function handlePocketWakeRequest(e) {
    if (e) e.stopPropagation();
    pocketWakeTapCount++;

    if (pocketWakeTapCount === 1) {
        // Cú chạm đầu tiên (hoặc vải cọ vào): Đánh thức tạm thời & chờ cú chạm thứ 2
        brightenPocketOverlay();
        if (window.AudioHapticFX) AudioHapticFX.trigger(5);

        if (pocketWakeTapTimer) clearTimeout(pocketWakeTapTimer);
        pocketWakeTapTimer = setTimeout(() => {
            dimPocketOverlay();
        }, 2200);
    } else if (pocketWakeTapCount >= 2) {
        // Cú chạm thứ 2 trong vòng 2.2s: Xác nhận người dùng chủ động mở khóa!
        if (pocketWakeTapTimer) clearTimeout(pocketWakeTapTimer);
        if (pocketActiveDimTimer) clearTimeout(pocketActiveDimTimer);
        pocketWakeTapCount = 0;
        dimPocketOverlay();
        applyLiteMode(false);
        if (window.APP_STATUS) APP_STATUS.toast(tr('pocket-unlocked', 'Đã mở khoá màn hình'), 'info');
        if (window.AudioHapticFX) AudioHapticFX.trigger(12);
    }
}

// While the screen is locked a tap on a control only wakes it; the next tap acts.
function pocketControlLocked() {
    if (document.getElementById('pocket-mode-overlay')?.dataset.awake === 'true') return false;
    brightenPocketOverlay();
    if (window.AudioHapticFX) AudioHapticFX.trigger(5);
    return true;
}

function initPocketModeControls() {
    // Double tap on Wake button
    document.getElementById('pocket-exit-btn')?.addEventListener('click', (e) => {
        handlePocketWakeRequest(e);
    });

    // Double tap anywhere on backdrop
    document.getElementById('pocket-mode-overlay')?.addEventListener('click', (e) => {
        handlePocketWakeRequest(e);
    });

    // Pocket Play / Pause Button with active check
    document.getElementById('pocket-play-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (pocketControlLocked()) return;
        brightenPocketOverlay();
        togglePlayback();
        setTimeout(updatePocketModeInfo, 50);
    });

    // Pocket Prev Chunk Button
    document.getElementById('pocket-prev-chunk-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (pocketControlLocked()) return;
        brightenPocketOverlay();
        playPrevChunk();
        setTimeout(updatePocketModeInfo, 50);
    });

    // Pocket Next Chunk Button
    document.getElementById('pocket-next-chunk-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (pocketControlLocked()) return;
        brightenPocketOverlay();
        playNextChunk();
        setTimeout(updatePocketModeInfo, 50);
    });

    // Keyboard shortcut Escape to immediately exit Pocket Mode
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && STATE.isLiteMode) {
            dimPocketOverlay();
            applyLiteMode(false);
            if (window.APP_STATUS) APP_STATUS.toast(tr('pocket-unlocked', 'Đã mở khoá màn hình'), 'info');
        }
    });
}
initPocketModeControls();

/**
 * Applies or removes Audio-Only Pocket Mode optimizations.
 * When ON: Activates blackout OLED overlay with tap-to-wake, pauses heavy layout/motion.
 * When OFF: Dismisses overlay, restores full reading view and scrolls to current sentence.
 */
function applyLiteMode(isLite) {
    STATE.isLiteMode = !!isLite;
    try {
        localStorage.setItem('lite-mode-enabled', STATE.isLiteMode ? 'true' : 'false');
    } catch (_) {}

    const pocketOverlay = document.getElementById('pocket-mode-overlay');
    if (pocketOverlay) {
        const wasOpen = !pocketOverlay.classList.contains('hidden');
        if (STATE.isLiteMode) {
            if (!wasOpen) pocketReturnFocus = document.activeElement;
            pocketOverlay.classList.remove('hidden');
            pocketOverlay.classList.add('flex');
            updatePocketModeInfo();
            if (!wasOpen) document.getElementById('pocket-play-btn')?.focus({ preventScroll: true });
            // Back only wakes the locked screen; unlocking stays a deliberate double tap.
            openLayer('pocket', () => { brightenPocketOverlay(); return false; });
        } else {
            closeLayer('pocket');
            pocketOverlay.classList.add('hidden');
            pocketOverlay.classList.remove('flex');
            dimPocketOverlay();
            if (wasOpen && pocketReturnFocus?.isConnected) pocketReturnFocus.focus({ preventScroll: true });
            pocketReturnFocus = null;
        }
    }

    if (STATE.isLiteMode) {
        document.body.classList.add('lite-mode');
    } else {
        document.body.classList.remove('lite-mode');
    }

    // Sync all toggle switches across desktop, mobile and quick settings
    const desktopToggle = document.getElementById('lite-mode-toggle');
    if (desktopToggle && desktopToggle.checked !== STATE.isLiteMode) {
        desktopToggle.checked = STATE.isLiteMode;
    }

    const mobileToggle = document.getElementById('lite-mode-toggle-mobile');
    if (mobileToggle && mobileToggle.checked !== STATE.isLiteMode) {
        mobileToggle.checked = STATE.isLiteMode;
    }

    const textContainer = document.getElementById('text-container');
    if (textContainer) {
        textContainer.style.scrollBehavior = STATE.isLiteMode ? 'auto' : '';
    }

    if (STATE.isLiteMode) {
        // Clear minimap DOM to free up memory & layout cost
        const minimapNodes = document.getElementById('minimap-nodes');
        if (minimapNodes) minimapNodes.innerHTML = '';
    } else {
        // Re-render minimap if currentBook is loaded
        if (STATE.currentBook && STATE.currentChapterIndex !== undefined) {
            renderMinimap(STATE.currentChapterIndex);
            syncMinimapScroll();
            highlightSentence(STATE.currentSentenceIndex);
        }

        // Reset throttle tick to force immediate UI refresh
        STATE.lastOntimeUpdateTick = -999;
        STATE.lastProgressWidth = null;
        STATE.lastCurrentMock = null;
        STATE.lastTimeStr = null;
    }

    console.log(`[PocketMode] ${STATE.isLiteMode ? 'ON — Audio-only battery saver' : 'OFF — Full UI restored'}`);
}
window.applyLiteMode = applyLiteMode;

if (liteModeToggle) {
    // Luôn khởi động ở trạng thái hiển thị bình thường khi tải trang
    STATE.isLiteMode = false;
    liteModeToggle.checked = false;
    applyLiteMode(false);

    // Desktop toggle
    liteModeToggle.addEventListener('change', (e) => {
        applyLiteMode(e.target.checked);
    });
}

const liteModeToggleMobile = document.getElementById('lite-mode-toggle-mobile');
liteModeToggleMobile?.addEventListener('change', (e) => applyLiteMode(e.target.checked));

function updateUI() {
    if (STATE.currentBook) {
        const titleEl = document.getElementById('player-title');
        const authorEl = document.getElementById('player-author');
        const chapterTitle = STATE.currentBook.chapters[STATE.currentChapterIndex].title;

        titleEl.innerText = shortChapterTitle(chapterTitle);
        titleEl.title = chapterTitle;

        authorEl.innerText = displayTitle(STATE.currentBook.title);
        authorEl.title = displayTitle(STATE.currentBook.title);
    }
    // Keyboard hints only mean something once a book is open.
    document.body.toggleAttribute('data-has-book', !!STATE.currentBook);
    updatePipUI();
    if (STATE.isLiteMode) {
        updatePocketModeInfo();
    }
}

function updatePipUI() {
    const prevChapterBtn = document.getElementById('prev-btn');
    const nextChapterBtn = document.getElementById('next-btn');
    const prevChunkBtn = document.getElementById('prev-chunk-btn');
    const nextChunkBtn = document.getElementById('next-chunk-btn');
    if (!prevChapterBtn || !nextChapterBtn || !prevChunkBtn || !nextChunkBtn) return;

    if (!STATE.currentBook) {
        [prevChapterBtn, nextChapterBtn, prevChunkBtn, nextChunkBtn].forEach(btn => { btn.disabled = true; });
        const emptySentence = document.getElementById('player-sentence');
        if (emptySentence) emptySentence.innerText = tr('player-no-sentence', 'Chưa có câu đang đọc');
        const counter = document.getElementById('current-time-mock');
        if (counter) counter.innerText = '—';
        STATE.lastCurrentMock = '—';
        return;
    }

    const chapters = STATE.currentBook.chapters || [];
    const chapter = chapters[STATE.currentChapterIndex] || {};
    const sentenceCount = chapter.count || chapter.sentences?.length || 0;
    const currentIndex = Math.max(0, STATE.currentSentenceIndex || 0);

    prevChapterBtn.disabled = STATE.currentChapterIndex <= 0;
    nextChapterBtn.disabled = STATE.currentChapterIndex >= chapters.length - 1;
    prevChunkBtn.disabled = currentIndex <= 0;
    nextChunkBtn.disabled = sentenceCount === 0 || currentIndex >= sentenceCount - 1;

    // Counter: "n / N" once the chapter's size is known, a dash until then.
    const counter = document.getElementById('current-time-mock');
    const counterText = sentenceCount > 0 ? `${Math.min(currentIndex + 1, sentenceCount)} / ${sentenceCount}` : '—';
    if (counter && STATE.lastCurrentMock !== counterText) {
        counter.innerText = counterText;
        STATE.lastCurrentMock = counterText;
    }

    const sentenceEl = document.getElementById('player-sentence');
    if (sentenceEl) {
        const sentence = chapter.sentences?.[currentIndex];
        const text = typeof sentence === 'string' ? sentence : (sentence?.text || '');
        sentenceEl.innerText = text || tr('player-no-sentence', 'Chưa có câu đang đọc');
        sentenceEl.title = text;
    }
}

function applySettingsToUI() {
    const s = STATE.settings;
    if (document.getElementById('voice-select')) document.getElementById('voice-select').value = s.voice;

    if (document.getElementById('speed-range')) {
        document.getElementById('speed-range').value = s.speed;
        document.getElementById('speed-val').innerText = formatSpeed(s.speed);
    }

    if (document.getElementById('pitch-range')) {
        const val = parseInt(s.pitch) || 0;
        document.getElementById('pitch-range').value = val;
        document.getElementById('pitch-val').innerText = s.pitch;
    }

    if (document.getElementById('prefetch-range')) {
        const idx = WORKER_STEPS.indexOf(s.numWorkers);
        if (idx !== -1) {
            document.getElementById('prefetch-range').value = idx;
            document.getElementById('prefetch-val').innerText = String(s.numWorkers);
        }
    }

    if (document.getElementById('proxy-toggle')) {
        document.getElementById('proxy-toggle').checked = s.useProxy !== false;
    }
    if (document.getElementById('gtts-toggle')) {
        document.getElementById('gtts-toggle').checked = s.gttsFallback === true;
    }

    if (document.getElementById('font-size-range')) {
        document.getElementById('font-size-range').value = s.fontSize;
        document.getElementById('font-size-val').innerText = `${s.fontSize}px`;
    }
    document.querySelectorAll('.range').forEach(paintRange);

    if (document.getElementById('font-color-picker')) {
        if (String(s.textColor).startsWith('#')) {
            document.getElementById('font-color-picker').value = s.textColor;
        }
    }

    if (STATE.theme) {
        applyTheme(STATE.theme);
    }

    if (typeof setZenMode === 'function') {
        setZenMode(STATE.zenModeEnabled, false);
    }

    applyTypographySettings();
    // Console chips and panel mirrors re-read the canonical controls.
    document.dispatchEvent(new CustomEvent('playersettingschange'));
}

// --- Navigation helpers (Next/Prev Chunk) ---
async function playNextChunk() {
    if (!STATE.currentBook) return;
    const chapters = STATE.currentBook.chapters;
    const curChap = STATE.currentChapterIndex;
    const curSent = STATE.currentSentenceIndex;

    const curTimingIdx = STATE.chunkTimings.findIndex(
        t => t.chapterIndex === curChap && t.index === curSent
    );
    if (curTimingIdx !== -1 && curTimingIdx < STATE.chunkTimings.length - 1
        && STATE.chunkTimings[curTimingIdx + 1].chapterIndex === curChap) {
        const nextChunk = STATE.chunkTimings[curTimingIdx + 1];
        audio.currentTime = nextChunk.startTime + 0.01;
        if (audio.paused) resumeAudio();
    } else {
        const sentenceCount = chapters[curChap]?.sentences?.length ?? 0;
        if (sentenceCount > 0 && curSent < sentenceCount - 1) {
            await playFromSentence(curSent + 1);
        }
    }
}

async function playPrevChunk() {
    if (!STATE.currentBook) return;
    const chapters = STATE.currentBook.chapters;
    const curChap = STATE.currentChapterIndex;
    const curSent = STATE.currentSentenceIndex;

    const curTimingIdx = STATE.chunkTimings.findIndex(
        t => t.chapterIndex === curChap && t.index === curSent
    );
    if (curTimingIdx > 0 && STATE.chunkTimings[curTimingIdx - 1].chapterIndex === curChap) {
        const prevChunk = STATE.chunkTimings[curTimingIdx - 1];
        audio.currentTime = prevChunk.startTime + 0.01;
        if (audio.paused) resumeAudio();
    } else {
        if (curSent > 0) {
            await playFromSentence(curSent - 1);
        }
    }
}

/**
 * Chuyển chương tập trung an toàn, ngăn chặn xung đột Race Condition
 * khi truyện đang phát audio hoặc người dùng click liên tiếp.
 * @param {number} targetChapterIndex
 * @param {number} startSentenceIndex
 * @param {boolean} autoPlay
 */
async function switchChapter(targetChapterIndex, startSentenceIndex = 0, autoPlay = true, onRendered = null) {
    if (!STATE.currentBook || !Array.isArray(STATE.currentBook.chapters)) return false;
    const chapters = STATE.currentBook.chapters;
    if (targetChapterIndex < 0 || targetChapterIndex >= chapters.length) return false;

    // Chặn click lặp khi đang trong tiến trình chuyển đổi
    if (STATE.isSwitchingChapter) {
        console.warn(`[SwitchChapter] Chapter transition already in progress. Ignoring switch to ${targetChapterIndex}`);
        return false;
    }

    const switchSeq = ++STATE.chapterSwitchSeq;
    const isSuperseded = () => switchSeq !== STATE.chapterSwitchSeq;
    STATE.isSwitchingChapter = true;
    STATE.isTransitioning = true;

    try {
        // 1. Tạm dừng ngay audio cũ từ mili-giây đầu tiên để triệt tiêu mọi ontimeupdate can thiệp
        if (audio && !audio.paused) {
            try { audio.pause(); } catch (_) { }
        }
        if (STATE.prefetchTimeout) {
            clearTimeout(STATE.prefetchTimeout);
            STATE.prefetchTimeout = null;
        }

        // 2. Render nội dung chương mới
        const renderOk = await renderChapter(targetChapterIndex);
        if (!renderOk) {
            // Close the TOC sheet so the load error in the reader is visible.
            if (textContainer.querySelector('.reader-error')) onRendered?.();
            return false;
        }

        // The old chapter's progress must not linger on the console while the new one loads.
        const progressBar = document.getElementById('progress-bar');
        if (progressBar) progressBar.style.width = '0%';
        STATE.lastProgressWidth = null;
        STATE.lastCurrentMock = null;
        // The console, the library row and the chapter buttons follow the reader
        // now, even if playback below is blocked or waits for the socket.
        STATE.currentSentenceIndex = startSentenceIndex;
        updateUI();
        updateLibraryHighlight();

        // 3. Cập nhật TOC UI nếu đang mở
        if (isTOCVisible()) {
            refreshTOCCurrent();
            scrollTOCCurrentChapter();
        }
        onRendered?.();

        // The lock only guards rendering. Waiting for the socket/TTS can take
        // up to 40 s; a newer chapter tap in that window supersedes this one.
        STATE.isSwitchingChapter = false;

        // 4. Phát audio chương mới nếu autoPlay được bật
        if (autoPlay) {
            await playFromSentence(startSentenceIndex, STATE.loadGeneration, isSuperseded);
        } else {
            STATE.currentSentenceIndex = startSentenceIndex;
            highlightSentence(startSentenceIndex);
            updateUI();
        }

        return true;
    } catch (err) {
        console.error('[SwitchChapter] Failed to switch chapter:', err);
        return false;
    } finally {
        if (!isSuperseded()) {
            STATE.isSwitchingChapter = false;
            STATE.isTransitioning = false;
        }
    }
}

async function playNextChapter() {
    if (!STATE.currentBook) return;
    const curChap = STATE.currentChapterIndex;
    const chapters = STATE.currentBook.chapters;
    if (curChap < chapters.length - 1) {
        await switchChapter(curChap + 1, 0, true);
    }
}

async function playPrevChapter() {
    if (!STATE.currentBook) return;
    const curChap = STATE.currentChapterIndex;
    if (curChap > 0) {
        await switchChapter(curChap - 1, 0, true);
    }
}

// --- Media Session API ---
function hasBufferedAhead() {
    const ranges = audio.buffered;
    for (let i = 0; i < ranges.length; i++) {
        if (audio.currentTime >= ranges.start(i) - 0.25 && audio.currentTime < ranges.end(i) - 0.3) return true;
    }
    return false;
}

let mediaActionsBound = false;
function bindMediaSessionActions() {
    if (mediaActionsBound || !('mediaSession' in navigator)) return;
    mediaActionsBound = true;
    const set = (action, handler) => {
        try { navigator.mediaSession.setActionHandler(action, handler); } catch (_) { }
    };
    set('play', () => { if (audio.paused) togglePlayback(); });
    // A single play/pause button sends "pause" whenever the browser believes audio is
    // playing; if it is in fact paused, the press means "resume".
    set('pause', () => { if (audio.paused) togglePlayback(); else audio.pause(); });
    set('previoustrack', () => playPrevChapter());
    set('nexttrack', () => playNextChapter());
    set('seekbackward', () => playPrevChunk());
    set('seekforward', () => playNextChunk());
    set('stop', () => stopPlaybackSession());
}
bindMediaSessionActions();
audio.addEventListener('ended', () => {
    if ('mediaSession' in navigator && audio.paused) navigator.mediaSession.playbackState = 'paused';
});

function updateMediaSession() {
    if ('mediaSession' in navigator && STATE.currentBook) {
        const chapter = STATE.currentBook.chapters[STATE.currentChapterIndex];

        navigator.mediaSession.metadata = new MediaMetadata({
            title: chapter.title,
            artist: displayTitle(STATE.currentBook.title),
            album: `Chapter ${STATE.currentChapterIndex + 1}`,
            artwork: [
                // Same object URL as the library cover; the app icon stays as fallback.
                ...(STATE.coverResolved.get(STATE.currentBookId)?.url
                    ? [{ src: STATE.coverResolved.get(STATE.currentBookId).url, sizes: '512x512', type: 'image/webp' }]
                    : []),
                { src: '/static/icon-512.png', sizes: '512x512', type: 'image/png' },
                { src: '/static/icon.svg', sizes: 'any', type: 'image/svg+xml' }
            ]
        });

        bindMediaSessionActions();
    }
}

window.addEventListener('pagehide', () => {
    // DISABLED: Strict Sync Mode
    if (STATE.currentBookId) {
        saveProgress(true);
        if (STATE.user) STATS_MANAGER.syncToFirestore();
    }
});

// --- Screen Wake Lock API ---
async function requestWakeLock() {
    if ('wakeLock' in navigator) {
        try {
            if (STATE.wakeLockSentinel && !STATE.wakeLockSentinel.released) return;
            const sentinel = await navigator.wakeLock.request('screen');
            STATE.wakeLockSentinel = sentinel;
            sentinel.addEventListener('release', () => {
                if (STATE.wakeLockSentinel === sentinel) {
                    STATE.wakeLockSentinel = null;
                }
                console.log('Screen Wake Lock was released');
            });
            console.log('Screen Wake Lock is active');
            updateWakeLockUI(true);
        } catch (err) {
            console.error(`Wake Lock error: ${err.name}, ${err.message}`);
            updateWakeLockUI(false);
            STATE.wakeLockEnabled = false;
            localStorage.setItem('wakeLockEnabled', 'false');
        }
    } else {
        console.warn("Screen Wake Lock API not supported.");
        updateWakeLockUI(false);
    }
}

function releaseWakeLock() {
    if (STATE.wakeLockSentinel !== null) {
        STATE.wakeLockSentinel.release()
            .then(() => {
                STATE.wakeLockSentinel = null;
                updateWakeLockUI(false);
            });
    }
}

function updateWakeLockUI(isActive) {
    const settingsWake = document.getElementById('settings-wake-toggle');
    if (settingsWake) settingsWake.checked = !!isActive;
}
window.updateWakeLockUI = updateWakeLockUI;
window.requestWakeLock = requestWakeLock;
window.releaseWakeLock = releaseWakeLock;

// --- Sleep Timer & Manual Save Logic ---
// Modes: minutes (countdown), 'chapter' (stop when the current chapter ends).
function setSleepTimerPreset(minutes) {
    STATE.sleepTimerMode = minutes;
    startSleepTimer(Math.round(minutes * 60));
}

function startSleepTimerFromCustom(minutes) {
    const value = Math.round(Number(minutes));
    if (!Number.isFinite(value) || value <= 0 || value > 600) {
        APP_STATUS.toast(tr('sleep-invalid', 'Nhập số phút từ 1 đến 600.'), 'warning');
        return false;
    }
    STATE.sleepTimerMode = 'custom';
    startSleepTimer(value * 60);
    return true;
}

function setSleepTimerEndOfChapter() {
    if (!STATE.currentBook) {
        APP_STATUS.toast(tr('sleep-need-book', 'Mở một truyện trước khi hẹn giờ theo chương.'), 'info');
        return;
    }
    if (STATE.sleepTimer) clearInterval(STATE.sleepTimer);
    STATE.sleepTimerMode = 'chapter';
    STATE.sleepTimerEnd = null;
    STATE.sleepTimerTarget = { bookId: STATE.currentBookId, chapterIndex: STATE.currentChapterIndex };
    // Playback stops at the chapter boundary (see ontimeupdate); this only drops
    // the timer when the reader opens another book.
    STATE.sleepTimer = setInterval(() => {
        if (STATE.currentBookId !== STATE.sleepTimerTarget?.bookId) cancelSleepTimer();
    }, 1000);
    updateSleepTimerUI(true, 0);
}

function startSleepTimer(seconds) {
    if (STATE.sleepTimer) clearInterval(STATE.sleepTimer);

    STATE.sleepTimerEnd = Date.now() + seconds * 1000;
    STATE.sleepTimerTarget = null;
    STATE.sleepTimer = setInterval(() => {
        const remaining = Math.max(0, Math.round((STATE.sleepTimerEnd - Date.now()) / 1000));
        updateSleepTimerUI(true, remaining);
        if (remaining <= 0) expireSleepTimer();
    }, 1000);
    updateSleepTimerUI(true, seconds);
}

function expireSleepTimer() {
    if (STATE.sleepTimer) clearInterval(STATE.sleepTimer);
    STATE.sleepTimer = null;
    STATE.sleepTimerMode = null;
    STATE.sleepTimerTarget = null;
    console.log("Sleep Timer Expired: Stopping Playback and Disconnecting");

    audio.pause();
    STATE.isPlaying = false;

    // Closing the socket also stops the server's prefetch workers.
    closeWebSocketIntentionally();
    STATE.socketParked = true;

    // A new session id makes replies already in flight ignorable.
    STATE.sessionId++;

    STATE.appendQueue = [];
    STATE.chunkTimings = [];
    STATE.fetchingSet.clear();
    STATE.metadataQueue = [];

    if (STATE.sourceBuffer && !STATE.sourceBuffer.updating) {
        try {
            if (STATE.sourceBuffer.buffered.length > 0) {
                const end = STATE.sourceBuffer.buffered.end(STATE.sourceBuffer.buffered.length - 1);
                STATE.sourceBuffer.remove(0, end + 10);
            }
        } catch (e) { }
    }

    if (STATE.wakeLockEnabled) {
        releaseWakeLock();
        STATE.wakeLockEnabled = false;
        localStorage.setItem('wakeLockEnabled', 'false');
    }

    updateSleepTimerUI(false);
    updateUI();
    document.getElementById('status-indicator').innerText = tr('status-sleep-stopped', 'Sleep timer · stopped');
}

function cancelSleepTimer() {
    if (STATE.sleepTimer) {
        clearInterval(STATE.sleepTimer);
        STATE.sleepTimer = null;
    }
    STATE.sleepTimerMode = null;
    STATE.sleepTimerTarget = null;
    updateSleepTimerUI(false);
}

function updateSleepTimerUI(isActive, seconds = 0) {
    document.dispatchEvent(new CustomEvent('sleeptimerchange', {
        detail: { active: !!isActive, seconds, mode: isActive ? STATE.sleepTimerMode : null }
    }));
}

async function triggerManualSave() {
    const btn = document.getElementById('manual-save-btn');
    const icon = document.getElementById('manual-save-icon');
    const expectedBookId = STATE.currentBookId;
    const expectedChunk = expectedBookId ? getGlobalIndex(STATE.currentChapterIndex, STATE.currentSentenceIndex) : null;

    if (!btn || btn.dataset.state) return;
    const setSaveState = (state, iconId) => {
        if (state) btn.dataset.state = state;
        else delete btn.dataset.state;
        btn.setAttribute('aria-busy', state === 'busy' ? 'true' : 'false');
        icon?.querySelector('use')?.setAttribute('href', `#${iconId}`);
    };
    setSaveState('busy', 'i-sync');

    try {
        // Force sync both progress and statistics
        const [progressSaved, statsSaved] = await Promise.all([
            saveProgress(true),
            STATS_MANAGER.syncToFirestore(true)
        ]);
        if (progressSaved !== true) {
            throw new Error('Firestore did not confirm the reading progress write');
        }
        if (STATE.user && statsSaved !== true) {
            console.warn('[Manual save] Progress saved, but statistics sync failed.');
        }
        const persistedProgress = await loadProgress(expectedBookId);
        if (!persistedProgress || Number(persistedProgress.last_read_chunk) !== expectedChunk) {
            throw new Error(`Firestore read-back mismatch (expected chunk ${expectedChunk})`);
        }
        console.info('[Manual save] Verified progress', {
            bookId: expectedBookId,
            lastReadChunk: persistedProgress.last_read_chunk
        });

        setSaveState('ok', 'i-check');
        APP_STATUS.toast(tr('progress-saved-cloud', 'Đã lưu tiến độ đọc lên đám mây.'), 'success');
        setTimeout(() => setSaveState('', 'i-cloud-up'), 2000);
    } catch (e) {
        console.error("Manual save failed:", e);
        APP_STATUS.error(e, tr('progress-save-failed', 'Không thể lưu tiến độ lên Firestore.'));
        setSaveState('error', 'i-x');
        setTimeout(() => setSaveState('', 'i-cloud-up'), 2000);
    }
}

// --- Stall Detection Logic (Poll every 1s) ---
setInterval(() => {
    if (!STATE.isPlaying || STATE.isTransitioning || !audio.currentTime) {
        if (!STATE.isPlaying && STATE.currentBook && !STATE.isTransitioning
            && !STATE.isDownloading && !STATE.pauseTimeoutHandled) {
            STATE.pauseCount++;
            if (STATE.pauseCount % 10 === 0) console.log(`Inactivity: ${STATE.pauseCount}s / 60s`);

            if (STATE.pauseCount >= 60) {
                handlePauseTimeout();
            }
        }

        STATE.stallCount = 0;
        STATE.lastPlaybackTime = audio.currentTime;
        return;
    }

    // Reset pause count if playing
    STATE.pauseCount = 0;

    if (audio.currentTime === STATE.lastPlaybackTime) {
        STATE.stallCount++;
        console.warn(`Stall Warning: ${STATE.stallCount}s at ${audio.currentTime}`);
    } else {
        STATE.stallCount = 0;
        STATE._stallWaitCount = 0;
    }

    STATE.lastPlaybackTime = audio.currentTime;

    if (STATE.stallCount >= 5) {
        // Another tab or device holds the account's socket; reconnecting now would only be refused again.
        if (wsRefusedRecently()) {
            STATE.stallCount = 0;
            document.getElementById('status-indicator').innerText = tr('status-conn-busy', 'Listening in another tab or device');
        } else {
            handlePlaybackStall();
        }
    }
}, 1000);

async function handlePauseTimeout() {
    console.warn("Pause Timeout: 1 minute reached. Saving and Disconnecting...");
    STATE.pauseCount = 0; // Reset to avoid double trigger
    STATE.pauseTimeoutHandled = true;
    let progressSaved = true;

    // 1. Save Progress
    if (STATE.user && STATE.currentBookId) {
        document.getElementById('status-indicator').innerText = tr('status-session-expiring', 'Session expiring…');
        progressSaved = await saveProgress(true);
    }

    // 2. [TASK 3] Disconnect WebSocket ONLY (Preserve Buffer & Cache)
    closeWebSocketIntentionally();
    STATE.socketParked = true;

    STATE.isPlaying = false;
    setPlayIcon(false);

    const indicator = document.getElementById('status-indicator');
    if (progressSaved) {
        indicator.innerText = tr('status-session-expired', 'Đã tạm dừng · tự kết nối lại khi phát');
        indicator.style.color = "#FFB347";
    } else {
        // enqueueProgressSnapshot has already retained the exact cursor and
        // scheduled its retry. Do not overwrite its visible failure state.
        indicator.innerText = tr('status-progress-unsaved', 'Progress not saved · retrying');
        indicator.style.color = "#FF5252";
    }
}

async function handlePlaybackStall() {
    STATE.stallCount = 0;

    // On a healthy socket a stall almost always means Edge is slow or failing
    // (requests in flight, chunks being retried, or a jump / chapter switch
    // still waiting for its first sentence). Reconnecting would cancel exactly
    // that work on the server, so wait; only a stall lasting ~60s (12 checks
    // of 5s) escalates to the reset stages below.
    const wsOpen = STATE.ws && STATE.ws.readyState === WebSocket.OPEN;
    STATE._stallWaitCount = (STATE._stallWaitCount || 0) + 1;
    if (wsOpen && STATE._stallWaitCount < 12) {
        const waitingForFirstChunk = STATE.chunkTimings.length === 0;
        if (STATE.fetchingSet.size === 0 && STATE.streamingRetryCount.size === 0 && !waitingForFirstChunk) {
            // Nothing in flight: the buffer ran dry because prefetch never ran
            // (e.g. throttled timers in a hidden tab). Refill it directly.
            console.warn("[Stall] Buffer dry, re-prefetching...");
            prefetchNext(STATE.lastAppendedChapter, STATE.lastAppendedIndex, null, true);
        } else {
            console.warn("[Stall] Waiting for TTS, skipping reset");
        }
        document.getElementById('status-indicator').innerText = tr('status-tts-wait', 'Đang chờ máy chủ TTS…');
        return;
    }
    STATE._stallWaitCount = 0;

    const currentAttempt = (STATE._stallRecoveryCount || 0) + 1;
    STATE._stallRecoveryCount = currentAttempt;

    // [TASK 3] Graduated Recovery Strategy
    if (currentAttempt <= 2) {
        // --- STAGE 1: SOFT RESET (Reconnect & Re-fetch) ---
        console.warn(`[Stall Stage 1] Soft Reset Attempt #${currentAttempt}...`);
        document.getElementById('status-indicator').innerText = tr('status-stalled', 'Stalled · recovering ({n})…', { n: currentAttempt });
        document.getElementById('status-indicator').style.color = "#FFD700";

        // Reconnect WebSocket
        closeWebSocketIntentionally();
        STATE.fetchingSet.clear();
        STATE.metadataQueue = [];
        STATE.appendQueue = [];

        // Attempt to trigger fresh prefetch from current position
        setTimeout(() => {
            if (STATE.isPlaying) {
                initWebSocket();
                // Check if we need to re-fetch the next chunk
                const lastAppendIdx = STATE.lastAppendedIndex;
                const lastAppendChap = STATE.lastAppendedChapter;
                prefetchNext(lastAppendChap, lastAppendIdx, null, true);
            }
        }, 1500);
        return;
    }

    // --- STAGE 2: HARD RESET (Emergency Cleanup) ---
    console.error("[Stall Stage 2] Hard Reset triggered. Clearing Cache/Buffer.");
    STATE._stallRecoveryCount = 0; // Reset for next time
    STATE.isStalled = true;
    STATE.isPlaying = false;
    audio.pause();

    // 1. Disconnect WebSocket & Clear Heartbeat
    closeWebSocketIntentionally();

    // 2. Clear RAM (Queues)
    STATE.appendQueue = [];
    STATE.chunkTimings = [];
    STATE.fetchingSet.clear();
    STATE.metadataQueue = [];
    STATE.streamingRetryCount.clear();

    // 3. Clear IndexedDB (Offline Storage) - "Dọn dẹp sạch cho cái mới đi vào"
    await OFFLINE_MANAGER.clearCache();

    // 4. Clear ROM (MSE Buffer)
    if (STATE.sourceBuffer && !STATE.sourceBuffer.updating) {
        try {
            if (STATE.sourceBuffer.buffered.length > 0) {
                const end = STATE.sourceBuffer.buffered.end(STATE.sourceBuffer.buffered.length - 1);
                STATE.sourceBuffer.remove(0, end + 10);
            }
        } catch (e) {
            console.error("Error clearing stalled buffer:", e);
        }
    }

    if (!statusMatches(document.getElementById('status-indicator').innerText, 'status-session-expiring', 'status-session-expired')) {
        document.getElementById('status-indicator').innerText = tr('status-stalled-cleared', 'Stalled · buffer cleared');
        document.getElementById('status-indicator').style.color = "#FF5252";
    }

    STATE.stallCount = 0;
    STATE.pauseCount = 0;

    setPlayIcon(false);
}

// Expose functions to window for HTML onclick attributes
window.setSleepTimerPreset = setSleepTimerPreset;
window.startSleepTimerFromCustom = startSleepTimerFromCustom;
window.cancelSleepTimer = cancelSleepTimer;
window.setSleepTimerEndOfChapter = setSleepTimerEndOfChapter;

document.getElementById('manual-save-btn')?.addEventListener('click', () => triggerManualSave());

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && STATE.wakeLockEnabled) {
        requestWakeLock();
    }

    // BACKGROUND TAB FIX: When page is hidden, ontimeupdate is throttled by the browser.
    // Fill a bounded buffer before browser timer throttling becomes aggressive.
    if (document.visibilityState === 'hidden' && STATE.isPlaying && STATE.currentBook) {
        console.log(`Tab hidden: filling a bounded ${BACKGROUND_PREFETCH_CHUNKS}-chunk background buffer...`);
        let lastChap = STATE.chunkTimings.length > 0 ? STATE.chunkTimings[STATE.chunkTimings.length - 1].chapterIndex : STATE.currentChapterIndex;
        let lastIdx = STATE.chunkTimings.length > 0 ? STATE.chunkTimings[STATE.chunkTimings.length - 1].index : STATE.currentSentenceIndex;
        prefetchNext(lastChap, lastIdx, BACKGROUND_PREFETCH_CHUNKS, true);
    }

    // Browser throttling can delay ontimeupdate while a tab is hidden. Save a
    // forced checkpoint as soon as the page leaves the foreground.
    if (document.visibilityState === 'hidden' && STATE.currentBookId) {
        void saveProgress(true).catch(err => console.debug('[Progress] Hidden-tab save skipped:', err.message));
        if (STATE.user) void STATS_MANAGER.syncToFirestore();
    }
});

// Initialize Wake Lock UI on load if previously enabled
// Note: Some browsers require user interaction first, so it might fail on auto-load.
// It will be recovered when visibility changes or clicked.
if (STATE.wakeLockEnabled) {
    requestWakeLock().catch(e => console.warn("Auto-wake lock failed on load:", e));
} else {
    updateWakeLockUI(false);
}

console.log("NOVA initialized.");

// --- Keyboard Shortcuts ---
// Space       → Play / Pause
// →           → Câu tiếp theo (next sentence)
// ←           → Câu trước (prev sentence)
// Shift + → / ]  → Chương tiếp theo (next chapter)
// Shift + ← / [  → Chương trước (prev chapter)
document.addEventListener('keydown', async (e) => {
    // Bỏ qua nếu đang gõ trong input, textarea, hoặc contenteditable
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
    // Menus, sheets and dialogs own their keys (Space activates the focused item there).
    if (document.activeElement?.closest?.('[role="menu"], [role="dialog"]')) return;

    // Bỏ qua nếu chưa load sách
    if (!STATE.currentBook) return;

    const chapters = STATE.currentBook.chapters;
    const curChap = STATE.currentChapterIndex;
    const curSent = STATE.currentSentenceIndex;

    if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        togglePlayback();
    } else if (e.code === 'ArrowRight' && !e.shiftKey) {
        e.preventDefault();
        await playNextChunk();
    } else if (e.code === 'ArrowLeft' && !e.shiftKey) {
        e.preventDefault();
        await playPrevChunk();

    } else if ((e.code === 'ArrowRight' && e.shiftKey) || (e.key === ']' && !e.ctrlKey && !e.metaKey && !e.altKey)) {
        e.preventDefault();
        if (curChap >= chapters.length - 1) APP_STATUS.toast(tr('at-last-chapter', 'Đã ở chương cuối.'), 'info', { key: 'chapter-edge' });
        else await playNextChapter();
    } else if ((e.code === 'ArrowLeft' && e.shiftKey) || (e.key === '[' && !e.ctrlKey && !e.metaKey && !e.altKey)) {
        e.preventDefault();
        if (curChap <= 0) APP_STATUS.toast(tr('at-first-chapter', 'Đã ở chương đầu.'), 'info', { key: 'chapter-edge' });
        else await playPrevChapter();
    }
});

// --- Service Worker Registration for PWA ---
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        // The server sends Service-Worker-Allowed: / so the worker can control the app page.
        navigator.serviceWorker.register('/static/sw.js', { scope: '/' })
            .then(registration => {
                registration.update();
                console.log('ServiceWorker registration successful with scope: ', registration.scope);
            })
            .catch(err => {
                console.log('ServiceWorker registration failed: ', err);
            });
        // Older builds registered with the default /static/ scope, which never controlled '/'.
        navigator.serviceWorker.getRegistrations?.().then(registrations => {
            registrations
                .filter(registration => new URL(registration.scope).pathname === '/static/')
                .forEach(registration => registration.unregister());
        }).catch(() => {});
    });
}

// --- Edit Chapter Logic ---
let editingChapterIndex = -1;
let editReturnFocus = null;

async function openEditChapterModal(index, triggerBtn = null) {
    if (!STATE.user || !STATE.currentFilename) return;
    // A pending chapter delete shifts indices once sent, so send it before picking a chapter.
    if (pendingChapterDelete) await flushChapterDelete();
    if (index >= (STATE.currentBook?.chapters?.length || 0)) return;

    editingChapterIndex = index;
    const modal = document.getElementById('edit-chapter-modal');
    const textarea = document.getElementById('edit-chapter-textarea');
    const statusIndicator = document.getElementById('status-indicator');

    editReturnFocus = triggerBtn || document.activeElement;
    if (triggerBtn) {
        triggerBtn.disabled = true;
        triggerBtn.setAttribute('aria-busy', 'true');
    }

    const chapTitle = STATE.currentBook?.chapters?.[index]?.title || `${tr('chapter-word', 'Chương')} ${index + 1}`;
    const editSub = document.getElementById('edit-chapter-sub');
    if (editSub) editSub.textContent = `C.${index + 1} · ${chapTitle}`;
    showLoading("Đang tải nội dung chương...", {
        subtext: `Chương ${index + 1}: ${chapTitle}`
    });

    if (statusIndicator) statusIndicator.innerText = tr('status-fetching-raw', 'Fetching original text…');

    try {
        const formData = new FormData();
        formData.append('userId', STATE.user.uid);
        formData.append('bookId', STATE.currentBookId);
        formData.append('filename', STATE.currentFilename);
        formData.append('chapterIndex', index);

        const response = await authFetch('/api/get-chapter-content', {
            method: 'POST',
            body: formData
        });

        const data = await response.json();
        if (data.content !== undefined) {
            // The server takes a chapter's title from its first non-empty line;
            // edit that line in its own field.
            const parts = splitChapterContent(data.content);
            const nameInput = document.getElementById('edit-chapter-name');
            if (nameInput) nameInput.value = parts.title;
            editingChapterGap = parts.gap;
            textarea.value = nameInput ? parts.body : data.content;
            modal.classList.remove('hidden');
            openLayer('edit-chapter-modal', closeEditModal);
            textarea.scrollTop = 0;
            (nameInput || textarea).focus({ preventScroll: true });
            if (statusIndicator) statusIndicator.innerText = tr('status-ready', 'Ready');
        } else {
            throw new Error(data.error || "Failed to fetch content");
        }
    } catch (err) {
        console.error("Edit fetch error:", err);
        APP_STATUS.error(`Lỗi tải nội dung: ${err.message}`);
        if (statusIndicator) statusIndicator.innerText = tr('status-error', 'Error');
    } finally {
        hideLoading();
        if (triggerBtn) {
            triggerBtn.disabled = false;
            triggerBtn.removeAttribute('aria-busy');
        }
    }
}

function splitChapterContent(content) {
    const text = String(content ?? '');
    const match = text.match(/^\s*([^\n]*?)[ \t]*(?:\r?\n|$)/);
    if (!match || !match[1].trim()) return { title: '', body: text, gap: '\n\n' };
    const rest = text.slice(match[0].length);
    const blank = rest.match(/^(?:[ \t]*\r?\n)*/)[0];
    return { title: match[1].trim(), body: rest.slice(blank.length), gap: (match[0].endsWith('\n') ? '\n' : '') + blank };
}

let editingChapterGap = '\n\n';

function joinChapterContent(title, body) {
    const name = String(title ?? '').trim().replace(/\s+/g, ' ');
    if (!name) return body;
    return body ? `${name}${editingChapterGap.includes('\n') ? editingChapterGap : '\n\n'}${body}` : name;
}

// After a save, point at the changed row: brief tint, focus on its edit pen.
function flashTOCRow(index) {
    const row = document.getElementById(`toc-item-${index}`);
    if (!row) return;
    row.classList.remove('is-flash');
    void row.offsetWidth;
    row.classList.add('is-flash');
    setTimeout(() => row.classList.remove('is-flash'), 1200);
    row.scrollIntoView({ block: 'nearest' });
}

function closeEditModal() {
    closeLayer('edit-chapter-modal');
    document.getElementById('edit-chapter-modal').classList.add('hidden');
    const index = editingChapterIndex;
    editingChapterIndex = -1;
    // Saving re-renders the TOC, so the pen that opened the dialog may be a new node.
    let target = editReturnFocus;
    if (!target?.isConnected && target?.matches?.('[data-toc-edit]')) {
        target = document.querySelector(`#toc-item-${index} [data-toc-edit]`);
    }
    if (target?.isConnected) target.focus({ preventScroll: true });
    editReturnFocus = null;
}

async function saveChapterEdit() {
    if (editingChapterIndex === -1 || !STATE.user || !STATE.currentFilename) return;

    const textarea = document.getElementById('edit-chapter-textarea');
    const nameInput = document.getElementById('edit-chapter-name');
    const newContent = nameInput ? joinChapterContent(nameInput.value, textarea.value) : textarea.value;
    const savedIndex = editingChapterIndex;
    const saveBtn = document.getElementById('save-edit-btn');
    const statusIndicator = document.getElementById('status-indicator');

    const originalText = saveBtn.innerText;
    saveBtn.innerText = tr("saving", "Đang lưu…");
    saveBtn.disabled = true;
    if (statusIndicator) statusIndicator.innerText = tr('status-saving', 'Saving changes…');

    showLoading("Đang lưu thay đổi chương...", {
        subtext: `Cập nhật chương ${editingChapterIndex + 1}...`
    });

    try {
        const formData = new FormData();
        formData.append('userId', STATE.user.uid);
        formData.append('bookId', STATE.currentBookId);
        formData.append('filename', STATE.currentFilename);
        formData.append('chapterIndex', editingChapterIndex);
        formData.append('newContent', newContent);

        const response = await authFetch('/api/update-chapter', {
            method: 'POST',
            body: formData
        });

        const data = await response.json();
        if (response.ok) {
            STATE.libraryTocCache.delete(STATE.currentBookId);
            // Update local state
            const chapter = STATE.currentBook.chapters[editingChapterIndex];
            if (chapter) {
                chapter.title = data.title;
                chapter.count = data.count;
                chapter.sentences = data.sentences;
            }

            // Invalidate the segment cache to force a fresh fetch from the server
            if (STATE.isSegmented) {
                const segIdx = Math.floor(editingChapterIndex / (STATE.segmentSize || 100));
                STATE.loadedSegments.delete(segIdx);
            }

            // If we're currently viewing this chapter, re-render it
            if (STATE.currentChapterIndex === editingChapterIndex) {
                renderChapter(editingChapterIndex);
                // Also reset playback session to reflect changes in chunks
                await resetAudioEngine();

                // If it was playing, restart from current sentence or start
                if (STATE.isPlaying) {
                    playFromSentence(STATE.currentSentenceIndex);
                }
            }

            // Refresh TOC to show new title/metadata
            renderTOC();

            // Sync progress to update total_chunks if needed
            saveProgress(true);

            closeEditModal();
            flashTOCRow(savedIndex);
            if (STATE.currentChapterIndex === savedIndex) updateUI();
            APP_STATUS.toast(tr('chapter-saved', 'Đã lưu chương {n}.', { n: savedIndex + 1 }), 'success');
            if (statusIndicator) {
                statusIndicator.innerText = tr('status-saved', 'Changes saved');
                setTimeout(() => statusIndicator.innerText = tr('status-ready', 'Ready'), 3000);
            }
        } else {
            throw new Error(data.error || "Failed to save changes");
        }
    } catch (err) {
        console.error("Save edit error:", err);
        APP_STATUS.error(`Lỗi lưu nội dung: ${err.message}`);
        if (statusIndicator) statusIndicator.innerText = tr('status-save-error', 'Error saving');
    } finally {
        hideLoading();
        saveBtn.innerText = originalText;
        saveBtn.disabled = false;
    }
}

// Event Listeners for Edit Modal
document.getElementById('close-edit-modal')?.addEventListener('click', closeEditModal);
document.getElementById('cancel-edit-btn')?.addEventListener('click', closeEditModal);
document.getElementById('save-edit-btn')?.addEventListener('click', saveChapterEdit);

// --- Stats & offline cache: shown in the Settings sheet (Bộ nhớ & cache, Thống kê) ---
// Reloads streak/time from Firestore and re-measures the audio cache; the sheet calls it on open.
window.refreshInsights = () => {
    STATS_MANAGER.load();
    OFFLINE_MANAGER.updateUsageUI();
};

document.getElementById('clear-offline-cache')?.addEventListener('click', async () => {
    const ok = await askConfirm({
        title: tr('clear-cache-title', 'Xoá âm thanh đã lưu?'),
        message: tr('clear-cache-body', 'Âm thanh đã lưu trên máy này sẽ bị xoá. Truyện và vị trí đọc vẫn giữ nguyên; khi nghe lại, âm thanh sẽ được tạo lại.'),
        confirmLabel: tr('clear-cache-ok', 'Xoá âm thanh'),
        danger: true
    });
    if (!ok) return;
    await OFFLINE_MANAGER.clearCache();
    APP_STATUS.toast(tr('clear-cache-done', 'Đã xoá cache âm thanh.'), 'success');
});

// --- Theme Management: four console themes live in ui-interactions.js ---
function applyTheme(themeId) {
    const actualId = normalizeThemeId(themeId);
    const curThemeAttr = document.documentElement.getAttribute('data-theme');
    const update = () => applyThemeTokens(actualId);
    if (curThemeAttr === actualId) {
        update();
        return;
    }
    safeViewTransition(update);
}

window.addEventListener('themechange', (e) => {
    STATE.theme = e.detail?.themeId || normalizeThemeId(null);
    if (typeof saveProgress === 'function') {
        saveProgress(true);
    }
});

// --- Easter egg: hold the logo for 3s to copy the chapter crawler script ---
(function () {
    const logoBtn = document.getElementById('logo-btn');
    if (!logoBtn) return;

    let holdTimer;
    const holdDuration = 3000;

    const startHold = (e) => {
        holdTimer = setTimeout(activateEasterEgg, holdDuration);
    };

    const cancelHold = () => {
        clearTimeout(holdTimer);
    };

    const activateEasterEgg = () => {
        const crawlerScript = `(function() {
    let titleElement = document.getElementById('bookchapnameholder');
    let chapterTitle = titleElement ? titleElement.innerText.trim() : "";
    let box = document.getElementById('content-container').cloneNode(true);
    let span = box.querySelector('span');
    if(span) span.remove();
    box.querySelectorAll('br').forEach(br => br.replaceWith('\\n'));
    let rawText = box.textContent;
    let contentText = rawText.split('\\n')
                           .map(line => line.trim().replace(/\\s+/g, ' '))
                           .join('\\n');
    let finalResult = chapterTitle + "\\n\\n" + contentText.trim();
    if (typeof copy === 'function') {
        copy(finalResult);
        console.log("Chapter copied to clipboard using DevTools copy()!");
    } else {
        console.log("Result computed, but copy() is only available in DevTools Console. Result:\\n" + finalResult);
    }
})();`;

        window._lastEasterEggAt = Date.now();
        navigator.clipboard.writeText(crawlerScript).then(() => {
            const indicator = document.getElementById('status-indicator');
            if (indicator) {
                const oldText = indicator.innerText;
                indicator.innerText = tr('status-crawler-copied', 'Crawler script copied');

                logoBtn.classList.add('is-egg');

                setTimeout(() => {
                    indicator.innerText = oldText;
                    logoBtn.classList.remove('is-egg');
                }, 3000);
            }
        }).catch(err => {
            console.error('Failed to copy Easter Egg script:', err);
        });
    };

    logoBtn.addEventListener('mousedown', startHold);
    logoBtn.addEventListener('touchstart', startHold, { passive: true });
    logoBtn.addEventListener('mouseup', cancelHold);
    logoBtn.addEventListener('mouseleave', cancelHold);
    logoBtn.addEventListener('touchend', cancelHold);
    logoBtn.addEventListener('touchcancel', cancelHold);
})();

// ============================================================
// [MiniPlayer] Bridge for static/js/mini-player-widget.js.
// PiP is injected only into the Reader player; Discovery explicitly closes it.
// ============================================================
window.MPW_BRIDGE = {
    get STATE() { return STATE; },
    audio,
    togglePlayback,
    resetAudioEngine,
    stopPlaybackSession,
    toggleDiscoveryMode,
    playNextChunk,
    playPrevChunk,
    playNextChapter,
    playPrevChapter,
    switchChapter,
    playFromSentence,
    applyLiteMode,
    renderTOC,
    scrollTOCCurrentChapter,
};

// --- Zen Mode Control & Persistence ---
function setZenMode(enabled, persist = true) {
    STATE.zenModeEnabled = !!enabled;
    document.body.classList.toggle('zen-focus-mode', STATE.zenModeEnabled);
    const settingsZen = document.getElementById('settings-zen-toggle');
    if (settingsZen) settingsZen.checked = STATE.zenModeEnabled;
    if (persist) {
        try {
            localStorage.setItem('zen-mode-enabled', STATE.zenModeEnabled ? 'true' : 'false');
        } catch (_) { /* private browsing mode fallback */ }
    }
}
window.setZenMode = setZenMode;

// --- Reader tools menu (⋮) ---
function requireOpenBook() {
    if (STATE.currentBook) return true;
    APP_STATUS.toast(tr('need-open-book', 'Mở một truyện trước đã.'), 'info');
    return false;
}

document.addEventListener('reader-menu-open', () => {
    const hasBook = !!STATE.currentBook;
    ['reader-edit-chapter-btn', 'reader-rename-btn', 'reader-images-btn', 'reader-merge-btn', 'reader-delete-btn', 'manual-save-btn'].forEach(id => {
        const item = document.getElementById(id);
        if (item) item.disabled = !hasBook;
    });
});
document.getElementById('reader-edit-chapter-btn')?.addEventListener('click', () => {
    if (requireOpenBook()) void openEditChapterModal(STATE.currentChapterIndex, null);
});
document.getElementById('reader-rename-btn')?.addEventListener('click', () => {
    if (requireOpenBook()) void editTitle();
});
document.getElementById('reader-images-btn')?.addEventListener('click', () => {
    if (requireOpenBook()) void openImageManager();
});
document.getElementById('reader-merge-btn')?.addEventListener('click', () => {
    const entry = requireOpenBook() && findLibraryEntry(STATE.currentBookId);
    if (entry) runBookAction('merge', entry);
});
document.getElementById('reader-delete-btn')?.addEventListener('click', () => {
    const entry = requireOpenBook() && findLibraryEntry(STATE.currentBookId);
    if (entry) runBookAction('delete', entry);
});

// --- Aa: reading type panel (font, size, line height, column width, theme) ---
const READER_TYPE_DEFAULTS = { leading: '1.72', measure: '66ch' };
const READER_TYPE_KEYS = { leading: 'reader-line-height', measure: 'reader-measure' };
const READER_TYPE_VARS = { leading: '--reader-leading', measure: '--reader-measure' };
const READER_TYPE_ALLOWED = { leading: ['1.55', '1.72', '1.9'], measure: ['52ch', '60ch', '66ch'] };
const readerTypePanel = document.getElementById('reader-type-panel');
const readerTypeScrim = document.getElementById('reader-type-scrim');
let readerTypeReturnFocus = null;

function readerTypeValue(group) {
    let value = null;
    try { value = localStorage.getItem(READER_TYPE_KEYS[group]); } catch (_) {}
    return READER_TYPE_ALLOWED[group].includes(value) ? value : READER_TYPE_DEFAULTS[group];
}

function syncReaderTypePanel() {
    const size = Number(STATE.settings.fontSize) || 20;
    let font = DEFAULT_READER_FONT;
    try { font = localStorage.getItem('reader-font-family') || DEFAULT_READER_FONT; } catch (_) {}
    const fontSelect = document.getElementById('reader-type-font');
    if (fontSelect) fontSelect.value = font;
    const sizeVal = document.getElementById('reader-type-size-val');
    if (sizeVal) sizeVal.textContent = `${size}px`;
    const range = document.getElementById('font-size-range');
    const dec = document.getElementById('reader-type-size-dec');
    const inc = document.getElementById('reader-type-size-inc');
    if (dec) dec.disabled = size <= Number(range?.min || 10);
    if (inc) inc.disabled = size >= Number(range?.max || 48);
    Object.keys(READER_TYPE_KEYS).forEach(group => {
        const current = readerTypeValue(group);
        document.querySelectorAll(`[data-type-group="${group}"] > button`).forEach(btn => {
            btn.setAttribute('aria-pressed', String(btn.dataset.value === current));
        });
    });
}

function setReaderFontSize(size) {
    const range = document.getElementById('font-size-range');
    if (!range) return;
    const next = Math.min(Number(range.max) || 48, Math.max(Number(range.min) || 10, Math.round(size)));
    range.value = String(next);
    range.dispatchEvent(new Event('input'));
    syncReaderTypePanel();
}

function setReaderTypeOption(group, value) {
    if (!READER_TYPE_ALLOWED[group]?.includes(value)) return;
    try { localStorage.setItem(READER_TYPE_KEYS[group], value); } catch (_) {}
    document.documentElement.style.setProperty(READER_TYPE_VARS[group], value);
    syncReaderTypePanel();
}

function onReaderTypeOutside(event) {
    if (readerTypePanel?.contains(event.target) || event.target.closest?.('#reader-type-btn')) return;
    closeReaderTypePanel();
}

function onReaderTypeKey(event) {
    if (event.key === 'Tab' && readerTypePanel?.getAttribute('aria-modal') === 'true') {
        trapTab(readerTypePanel, event);
        return;
    }
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closeReaderTypePanel({ restoreFocus: true });
}

function openReaderTypePanel({ fromKeyboard = false } = {}) {
    if (!readerTypePanel || !readerTypePanel.hidden) return;
    readerTypeReturnFocus = document.getElementById('reader-type-btn');
    syncReaderTypePanel();
    readerTypePanel.hidden = false;
    readerTypeReturnFocus?.setAttribute('aria-expanded', 'true');
    const isSheet = window.matchMedia('(max-width: 639.98px)').matches;
    if (readerTypeScrim) readerTypeScrim.hidden = !isSheet;
    readerTypePanel.setAttribute('aria-modal', String(isSheet));
    document.addEventListener('pointerdown', onReaderTypeOutside, true);
    document.addEventListener('keydown', onReaderTypeKey, true);
    openLayer('reader-type', () => closeReaderTypePanel({ restoreFocus: true }));
    const target = fromKeyboard ? document.getElementById('reader-type-font') : readerTypePanel;
    target?.focus({ preventScroll: true });
}

function closeReaderTypePanel({ restoreFocus = false } = {}) {
    if (!readerTypePanel || readerTypePanel.hidden) return;
    closeLayer('reader-type');
    readerTypePanel.hidden = true;
    document.getElementById('reader-type-btn')?.setAttribute('aria-expanded', 'false');
    if (readerTypeScrim) readerTypeScrim.hidden = true;
    document.removeEventListener('pointerdown', onReaderTypeOutside, true);
    document.removeEventListener('keydown', onReaderTypeKey, true);
    if (restoreFocus && readerTypeReturnFocus?.isConnected) readerTypeReturnFocus.focus({ preventScroll: true });
    readerTypeReturnFocus = null;
}

document.getElementById('reader-type-btn')?.addEventListener('click', (event) => {
    if (readerTypePanel?.hidden) openReaderTypePanel({ fromKeyboard: event.detail === 0 });
    else closeReaderTypePanel();
});
document.getElementById('reader-type-close')?.addEventListener('click', () => closeReaderTypePanel({ restoreFocus: true }));
readerTypeScrim?.addEventListener('click', () => closeReaderTypePanel());
document.getElementById('reader-type-font')?.addEventListener('change', event => {
    const select = document.getElementById('font-family-select');
    if (select) {
        select.value = event.target.value;
        select.dispatchEvent(new Event('change'));
    } else {
        applyFontFamily(event.target.value);
    }
});
document.getElementById('reader-type-size-dec')?.addEventListener('click', () => setReaderFontSize((Number(STATE.settings.fontSize) || 20) - 1));
document.getElementById('reader-type-size-inc')?.addEventListener('click', () => setReaderFontSize((Number(STATE.settings.fontSize) || 20) + 1));
document.querySelectorAll('[data-type-group] > button').forEach(btn => {
    btn.addEventListener('click', () => setReaderTypeOption(btn.parentElement.dataset.typeGroup, btn.dataset.value));
});
document.getElementById('reader-type-more')?.addEventListener('click', () => {
    closeReaderTypePanel();
    window.SettingsSheet?.open('display');
});
syncReaderTypePanel();

// Apply initial settings to UI on startup
applySettingsToUI();
if (!STATE.currentBookId) {
    toggleDiscoveryMode(true);
}
document.dispatchEvent(new CustomEvent('mpw-bridge-ready'));
