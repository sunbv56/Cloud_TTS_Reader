// Firebase Modules
import { initializeFirestore, getFirestore, waitForPendingWrites, terminate, doc, setDoc, getDoc, deleteDoc, serverTimestamp, collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { compressImageForStorage, IMAGE_MAX_BYTES } from "./js/image-manager.js";
import { toggleSidebar, normalizeThemeId, applyTheme as applyThemeTokens, ensureReaderFont, readerFontStack, DEFAULT_READER_FONT } from "./js/modules/ui-interactions.js";
import { AccountSessions } from "./js/modules/account-sessions.js";
import { createAccountMenu } from "./js/modules/account-menu.js";

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
            const isAndroid = /Android/i.test(navigator.userAgent);
            return isAndroid ? 10 : 20;
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
    tocAutoMinimized: false,
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
        const streakDot = document.getElementById('streak-dot');

        if (streakEl) streakEl.innerText = STATE.stats.streak;
        if (timeEl) {
            const mins = Math.floor(STATE.stats.totalTime / 60);
            timeEl.innerText = mins > 60 ? `${(mins / 60).toFixed(1)}h` : `${mins}m`;
        }
        if (streakDot && STATE.stats.streak > 0) streakDot.classList.remove('hidden');
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
            document.getElementById('status-indicator').innerText = "Config Error";
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
                onStatus: text => APP_STATUS.set(text)
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
    APP_STATUS.set('Ready');
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
        if (response.status === 401) throw new Error('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
        if (response.status === 403) throw new Error('Bạn không có quyền thực hiện thao tác này.');
        return response;
    } catch (error) {
        if (error instanceof NetworkTimeoutError) {
            const timeoutError = new Error('Máy chủ phản hồi quá lâu. Hãy thử lại.');
            timeoutError.code = 'NETWORK_TIMEOUT';
            timeoutError.cause = error;
            throw timeoutError;
        }
        if (error instanceof TypeError) throw new Error('Không thể kết nối máy chủ. Hãy kiểm tra mạng và thử lại.');
        throw error;
    }
}

const AudioHapticFX = {
    audioCtx: null,
    isMuted: false,
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

function setAudioWaveState(isPlaying) {
    if (window.MotionLayer?.setAudioWaveState) {
        window.MotionLayer.setAudioWaveState(isPlaying);
        return;
    }
    document.querySelectorAll('.audio-wave-bars').forEach(el => el.classList.toggle('is-playing', !!isPlaying));
}

const APP_STATUS = {
    set(text) {
        const indicator = document.getElementById('status-indicator');
        if (!indicator) return;
        indicator.innerText = text;
        indicator.style.color = '';
    },
    toast(message, kind = 'error') {
        const region = document.getElementById('app-toast-region');
        if (!region) return;

        AudioHapticFX.haptic(14);

        const icons = {
            success: '<i class="fas fa-check-circle text-emerald-400 text-base"></i>',
            error: '<i class="fas fa-exclamation-circle text-rose-400 text-base"></i>',
            warning: '<i class="fas fa-triangle-exclamation text-amber-400 text-base"></i>',
            info: '<i class="fas fa-info-circle text-primary text-base"></i>'
        };
        const titles = {
            success: 'Thành công',
            error: 'Thông báo lỗi',
            warning: 'Cảnh báo',
            info: 'Hệ thống'
        };

        const kindClass = `toast-kind-${kind || 'info'}`;
        const iconHtml = icons[kind] || icons.info;
        const titleText = titles[kind] || titles.info;

        const toast = document.createElement('div');
        toast.className = `toast-hud-glass p-3.5 text-sm flex items-start gap-3 ${kindClass} pointer-events-auto cursor-pointer select-none`;
        toast.setAttribute('role', 'alert');
        toast.innerHTML = `
            <div class="flex-shrink-0 mt-0.5">${iconHtml}</div>
            <div class="flex-1 min-w-0 pr-1">
                <div class="font-bold text-[11px] uppercase tracking-wider opacity-80 mb-0.5 text-white">${titleText}</div>
                <div class="text-slate-200 text-xs leading-relaxed break-words">${message}</div>
            </div>
            <button type="button" class="text-slate-400 hover:text-white p-1 -mr-1 -mt-1 text-xs opacity-70 hover:opacity-100 transition-opacity" aria-label="Đóng">
                <i class="fas fa-times"></i>
            </button>
            <div class="toast-progress-track">
                <div class="toast-progress-fill"></div>
            </div>
        `;

        const closeBtn = toast.querySelector('button');
        let removeTimer = null;
        const dismiss = () => {
            if (removeTimer) clearTimeout(removeTimer);
            if (window.MotionLayer?.animateToastOut) {
                window.MotionLayer.animateToastOut(toast);
            } else {
                toast.remove();
            }
        };

        closeBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            dismiss();
        });
        toast.addEventListener('click', dismiss);

        region.appendChild(toast);
        if (window.MotionLayer?.animateToastIn) {
            window.MotionLayer.animateToastIn(toast);
        }
        removeTimer = setTimeout(dismiss, 4800);
    },
    error(error, fallback = 'Đã xảy ra lỗi. Vui lòng thử lại.') {
        const message = (typeof error === 'string' ? error : error?.message) || fallback;
        this.set('Lỗi');
        this.toast(message, 'error');
    }
};
let imageManagerBookId = null;
let imageManagerBookTitle = '';

function updateNetworkStatus() {
    const banner = document.getElementById('network-status');
    if (!banner) return;
    banner.classList.toggle('hidden', navigator.onLine);
    APP_STATUS.set(navigator.onLine ? 'Ready' : 'Ngoại tuyến');
}
window.addEventListener('offline', updateNetworkStatus);
window.addEventListener('online', () => {
    updateNetworkStatus();
    APP_STATUS.toast('Đã kết nối lại mạng.', 'success');
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
            playerInfoLayer?.setAttribute('aria-label', 'Bấm để quay lại trình đọc');
        }

        // PiP belongs to Reader. Close its floating surface before the player
        // becomes Discovery's return dock.
        if (window.MiniPlayerWidget) window.MiniPlayerWidget.onDiscoveryEnter();

        if (discoveryMode) discoveryMode.classList.remove('hidden');
        updateDiscoveryContinueCard();
        applyDiscoverySearch();
        // Master–detail: from 1024px the library column stays beside Home;
        // below that the sidebar is the off-canvas drawer, so just close it.
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
                    current.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            });
        }
    }
}

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
        toggleDiscoveryMode(false);
    }
});

// ── Library + Home (kệ sách) ────────────────────────────────────────────────
// One snapshot of the user's progress collection feeds three views: the
// mục lục rows in the left column / drawer, Home's list or cover grid, and the
// "Nghe tiếp" card. Filter and sort are shared; each view keeps its own search.
const DISCOVERY_VIEW_STORAGE_KEY = 'cloud-tts-discovery-view';
const LIBRARY_FILTER_KEY = 'cloud-tts-library-filter';
const LIBRARY_SORT_KEY = 'cloud-tts-library-sort';
const LIBRARY_FILTERS = ['listening', 'all', 'done'];
const LIBRARY_SORTS = ['recent', 'title', 'progress'];
const COVER_CONCURRENCY = 3;
const IMAGE_URL_CACHE_LIMIT = 48;
const LIBRARY_TOC_CACHE_LIMIT = 12;
let discoveryLibrary = [];

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
    filter: readPref(LIBRARY_FILTER_KEY, LIBRARY_FILTERS, 'listening'),
    sort: readPref(LIBRARY_SORT_KEY, LIBRARY_SORTS, 'recent'),
    discovery: readPref(DISCOVERY_VIEW_STORAGE_KEY, ['grid', 'list'], window.innerWidth < 768 ? 'list' : 'grid'),
    expanded: { sidebar: null, shelf: null },
    refreshSeq: 0
};

function uiLang() {
    try { return localStorage.getItem('ui-lang') === 'vi' ? 'vi' : 'en'; } catch (_) { return 'en'; }
}

function tr(key, fallback, vars = null) {
    const text = window.translations?.[uiLang()]?.[key] ?? fallback ?? key;
    return vars ? text.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? '')) : text;
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

function createLibraryEntry(bookId, data) {
    const title = data.title || data.filename;
    const done = isBookDone(data);
    return {
        id: bookId,
        data,
        title,
        percent: done ? 100 : getProgressPercent(data),
        done,
        lastListenedAt: listenedTime(data.last_listened_at),
        hasImages: data.has_images === true,
        searchKey: librarySearchKey(title),
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

function formatEntryMeta(entry) {
    const chapter = getLibraryChapter(entry);
    const parts = [];
    if (chapter) parts.push(`C.${chapter.index + 1}/${chapter.total}`);
    parts.push(formatPercent(entry.percent));
    parts.push(formatListenedAgo(entry.lastListenedAt));
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
    const url = await getImageURL(bookId, cover);
    if (!url) return undefined;
    return { url, imageId: cover.id, crop: cover.coverCrop || null };
}

function paintCover(element, info) {
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
    title.textContent = entry.title;
    const meta = document.createElement('span');
    meta.className = 'lib-row__meta';
    meta.textContent = formatEntryMeta(entry);
    text.append(title, meta);
    main.append(createCoverElement(entry, 'thumb'), text);
    head.append(main, buildProgressRing(entry));

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
    title.textContent = entry.title;
    const meta = document.createElement('span');
    meta.className = 'shelf-card__meta';
    meta.textContent = formatEntryMeta(entry);
    open.append(createCoverElement(entry, 'grid'), bar, title, meta);
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'icon-btn shelf-card__more';
    more.dataset.action = 'more';
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    more.setAttribute('aria-label', tr('book-options', 'Tuỳ chọn cho {title}', { title: entry.title }));
    more.innerHTML = iconSVG('dots');
    card.append(open, more);
    return card;
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
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'icon-btn icon-btn--line';
    more.dataset.action = 'more';
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    more.setAttribute('aria-label', tr('book-options', 'Tuỳ chọn cho {title}', { title: entry.title }));
    more.innerHTML = iconSVG('dotsh');
    actions.append(open, play, more);
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
                .forEach(meta => { meta.textContent = formatEntryMeta(entry); });
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
    return libraryView.filter === 'done' ? entry.done : !entry.done;
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
        return { text: tr('search-no-match', 'Không tìm thấy “{query}”.', { query: rawQuery }), action: 'clear-search', label: tr('clear-search', 'Xoá tìm kiếm') };
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
    setLibraryEmpty('discovery-search-empty', 'discovery-search-empty-text', 'discovery-clear-search',
        libraryEmptyState(shelf.query, shelfSearch?.value.trim(), shelf.visible), 'shelf');
    const count = document.getElementById('discovery-result-count');
    if (count) {
        count.textContent = libraryView.status === 'ready' && discoveryLibrary.length
            ? tr('shelf-count', '{shown}/{total} truyện', { shown: shelf.visible, total: discoveryLibrary.length })
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
    libraryView.discovery = view === 'list' ? 'list' : 'grid';
    if (persist) writePref(DISCOVERY_VIEW_STORAGE_KEY, libraryView.discovery);
    renderLibraryViews();
}

// ── Current book: highlight, ring state, "Nghe tiếp" ───────────────────────
function syncLibraryItemState(item, entry) {
    const isCurrent = item.dataset.bookId === STATE.currentBookId && !!STATE.currentBook;
    const isPlaying = isCurrent && typeof audio !== 'undefined' && !audio.paused;
    if (isCurrent) item.setAttribute('aria-current', 'true');
    else item.removeAttribute('aria-current');
    const vars = { title: entry.title, percent: formatPercent(entry.percent) };
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
        meta.textContent = formatEntryMeta(entry);
    });
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
    title.textContent = entry.title;
    meta.textContent = formatEntryMeta(entry);
    progress.style.width = `${entry.percent}%`;
    if (label) {
        label.textContent = isPlaying
            ? tr('now-playing', 'Đang phát')
            : (isOpen ? tr('resume-open', 'Đang mở') : tr('resume-last', 'Nghe gần nhất'));
    }
    card.dataset.bookId = entry.id;
    const oldCover = document.getElementById('discovery-continue-cover');
    if (oldCover?.dataset.coverFor !== entry.id) {
        const cover = createCoverElement(entry, 'resume');
        cover.id = 'discovery-continue-cover';
        oldCover?.replaceWith(cover);
    }
}

function handleContinueListening(event) {
    event?.stopPropagation?.();
    const target = getResumeTarget();
    if (!target) return;
    if (target.isOpen) {
        toggleDiscoveryMode(false);
        if (audio.paused) void togglePlayback();
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

async function renameLibraryBook(entry) {
    if (entry.id === STATE.currentBookId && STATE.currentBook) {
        await editTitle();
        return;
    }
    if (!STATE.user) return;
    const requested = prompt(tr('rename-prompt', 'Tên mới cho truyện:'), entry.title);
    const newTitle = requested?.trim();
    if (!newTitle || newTitle === entry.title) return;
    try {
        await setDoc(doc(db, 'users', STATE.user.uid, 'progress', entry.id), { title: newTitle }, { merge: true });
        await refreshLibrary();
        APP_STATUS.toast(tr('rename-done', 'Đã đổi tên truyện.'), 'success');
    } catch (err) {
        console.error('[Title] Rename failed:', err);
        APP_STATUS.error(`Không thể lưu tên truyện: ${err.message}`);
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
        closeBookMenu();
    }
}

function onBookMenuViewportChange() {
    closeBookMenu();
}

function openBookMenu(entry, trigger) {
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
    const title = document.getElementById('book-menu-title');
    if (title) title.textContent = entry.title;
    const isSheet = window.matchMedia('(max-width: 639.98px)').matches;
    menu.style.left = '';
    menu.style.top = '';
    menu.hidden = false;
    if (scrim) scrim.hidden = !isSheet;
    if (!isSheet) {
        const rect = trigger.getBoundingClientRect();
        const width = menu.offsetWidth;
        const height = menu.offsetHeight;
        const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
        let top = rect.bottom + 6;
        if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
    }
    trigger.setAttribute('aria-expanded', 'true');
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
    closeBookMenu();
    if (!entry) return;
    switch (action) {
        case 'open': openLibraryBook(entry); break;
        case 'rename': void renameLibraryBook(entry); break;
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
        case 'delete': void deleteBook(entry.id, entry.data.filename, entry.title); break;
        default: break;
    }
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
window.addEventListener('uilanguagechange', () => {
    if (libraryView.status !== 'idle') renderLibraryViews();
});


// ── Sidebar Segmented Tabs (library | toc | voice) ──────────────────────────
const SIDEBAR_TAB_KEY = 'sidebar-active-tab';
const SIDEBAR_TABS = ['library', 'toc', 'voice'];

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
            if (isActive && window.gsap) {
                window.gsap.fromTo(panel,
                    { opacity: 0, x: -8 },
                    { opacity: 1, x: 0, duration: 0.22, ease: 'power2.out', clearProps: 'all' });
            }
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
    const numberQuery = query.replace(/^(c\.?|chuong|chapter|ch\.?)\s*/, '');
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

// --- Loading Overlay Helpers (UI/UX Pro Max + GSAP) ---
function showLoading(text = "Processing Masterpiece", { subtext = "Vui lòng đợi trong giây lát...", progress = null, status = "Tiến trình" } = {}) {
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
                if (window.MotionLayer?.animateProgressBar && progressBar) {
                    window.MotionLayer.animateProgressBar(progressBar, safePercent);
                } else if (progressBar) {
                    progressBar.style.width = `${safePercent}%`;
                }
                if (window.MotionLayer?.animateCounter && progressPercent) {
                    window.MotionLayer.animateCounter(progressPercent, safePercent);
                } else if (progressPercent) {
                    progressPercent.innerText = `${safePercent}%`;
                }
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
        if (window.MotionLayer?.animateProgressBar && progressBar) {
            window.MotionLayer.animateProgressBar(progressBar, safePercent);
        } else if (progressBar) {
            progressBar.style.width = `${safePercent}%`;
        }
        if (window.MotionLayer?.animateCounter && progressPercent) {
            window.MotionLayer.animateCounter(progressPercent, safePercent);
        } else if (progressPercent) {
            progressPercent.innerText = `${safePercent}%`;
        }
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

function setButtonLoading(button, isLoading, loadingText = '') {
    if (typeof button === 'string') button = document.getElementById(button);
    if (!button) return;
    if (window.MotionLayer?.setButtonLoading) {
        window.MotionLayer.setButtonLoading(button, isLoading, loadingText);
    } else {
        button.disabled = !!isLoading;
        button.classList.toggle('is-loading', !!isLoading);
        if (isLoading) button.setAttribute('aria-busy', 'true');
        else button.removeAttribute('aria-busy');
    }
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
    if (document.startViewTransition && !STATE.isLiteMode && document.visibilityState !== 'hidden') {
        return document.startViewTransition(callback);
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
    document.getElementById('status-indicator').innerText = "Ready";
    const playBtn = document.getElementById('play-btn');
    if (playBtn) playBtn.innerHTML = '<i class="fas fa-play ml-1"></i>';

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

    if (STATE.isSegmented) {
        const segmentSize = STATE.segmentSize || 100;
        const activeSegment = Math.floor(activeChapterIndex / segmentSize);
        const keepSegments = new Set([activeSegment, activeSegment + 1]);
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
    const lastKept = Math.min(STATE.currentBook.chapters.length - 1, activeChapterIndex + 1);
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

function setModalVisibility(id, visible) {
    const modal = document.getElementById(id);
    if (!modal) return;
    const wasVisible = !modal.classList.contains('hidden');
    modal.classList.toggle('hidden', !visible);
    modal.classList.toggle('flex', visible);
    if (visible && !wasVisible) {
        modalReturnFocus.set(id, document.activeElement);
        requestAnimationFrame(() => {
            const target = modal.querySelector('[data-autofocus]')
                || modal.querySelector('.modal-card button:not([disabled]):not([data-close-upload-options]):not([data-close-upload-files]):not([data-close-image-manager]), .modal-card input:not([type="file"]):not([readonly])')
                || modal.querySelector('.modal-card button');
            target?.focus({ preventScroll: true });
        });
    } else if (!visible && wasVisible) {
        const previous = modalReturnFocus.get(id);
        modalReturnFocus.delete(id);
        if (previous?.isConnected && typeof previous.focus === 'function') previous.focus({ preventScroll: true });
    }
}

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
    setModalVisibility('upload-files-modal', false);
}

function updateUploadFilePaths() {
    const textPath = document.getElementById('book-text-path');
    const imagePath = document.getElementById('book-image-path');
    if (textPath) textPath.value = STATE.pendingUploadTextFile?.name || '';
    if (imagePath) {
        const images = STATE.pendingUploadImageFiles;
        imagePath.value = images.length ? `${images.length} ảnh: ${images.map(file => file.name).join(', ')}` : '';
    }
}

document.getElementById('browse-book-text-btn')?.addEventListener('click', () => document.getElementById('book-text-input')?.click());
document.getElementById('browse-book-image-btn')?.addEventListener('click', () => document.getElementById('book-image-input')?.click());
document.getElementById('book-text-input')?.addEventListener('change', event => {
    STATE.pendingUploadTextFile = event.target.files?.[0] || null;
    updateUploadFilePaths();
});
document.getElementById('book-image-input')?.addEventListener('change', event => {
    STATE.pendingUploadImageFiles = Array.from(event.target.files || []);
    updateUploadFilePaths();
});
document.getElementById('confirm-upload-files-btn')?.addEventListener('click', () => {
    if (!STATE.pendingUploadTextFile) {
        APP_STATUS.toast('Vui lòng chọn file .txt trước.', 'warning');
        return;
    }
    const files = [STATE.pendingUploadTextFile, ...STATE.pendingUploadImageFiles];
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
    setButtonLoading(addBtn, true, 'Đang xử lý...');
    showLoading(`Đang xử lý ${files.length} ảnh...`, { progress: 0, status: 'Nén & Tải ảnh' });
    try {
        const bookId = imageManagerBookId || STATE.currentBookId;
        if (!bookId || !STATE.user) throw new Error('Hãy mở một truyện và đăng nhập trước.');
        if (STATE.imageEditTargetId) {
            await replaceBookImage(bookId, STATE.imageEditTargetId, files[0]);
        } else {
            await uploadBookImages(bookId, files, imageManagerBookTitle || STATE.currentBook?.title || '');
        }
        await renderImageManager();
        await refreshLibrary();
        APP_STATUS.toast(`Đã cập nhật ${files.length} ảnh thành công.`, 'success');
    } catch (err) {
        console.error('[Images] Manage error:', err);
        APP_STATUS.error(`Không thể cập nhật ảnh: ${err.message}`);
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
document.getElementById('discovery-add-btn')?.addEventListener('click', () => {
    STATE.uploadInputTarget = 'discovery';
    openUploadOptions();
});
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
    const socket = STATE.ws;
    STATE.wsConnecting = false;

    STATE.ws.onopen = () => {
        console.log("Connected to WebSocket");
        document.getElementById('status-indicator').innerText = "Ready";
        socket.send(JSON.stringify({ type: "AUTH", token }));

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
                            document.getElementById('status-indicator').innerText = `Retrying chunk... (${retries})`;

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
                                const { voice, speed, pitch, volume } = STATE.settings;
                                const rate = `${Math.round((speed - 1) * 100) >= 0 ? '+' : ''}${Math.round((speed - 1) * 100)}%`;

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
                                    if (statusEl) statusEl.innerText = `Retrying failed chunk (${retries}/${MAX_RETRIES})... (${received}/${total})`;

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
                } else {
                    document.getElementById('status-indicator').innerText = "Ready";
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

            const arrayBuffer = await event.data.arrayBuffer();

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
                if (chapterInfo) chapterInfo.innerText = `${received} / ${total} chunks`;
                if (statusEl) statusEl.innerText = `Workers processing... (${received}/${total})`;

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

            STATE.appendQueue.push({
                index: currentMetadata.index,
                chapterIndex: currentMetadata.chapterIndex,
                sessionId: currentMetadata.sessionId,
                part: hasParts ? currentMetadata.part : undefined,
                data: arrayBuffer,
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

    STATE.ws.onclose = () => {
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
            document.getElementById('status-indicator').innerText = "Disconnected";
            return;
        }

        if (STATE.isPlaying || STATE.isDownloading) {
            STATE.isStalled = false; // FIX #2: Reset isStalled so future reconnects work
            console.log("Unexpected disconnect, reconnecting in 3s...");
            document.getElementById('status-indicator').innerText = "Reconnecting...";
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
            document.getElementById('status-indicator').innerText = "Disconnected";
        }
    };
}

/**
 * Ensures the WebSocket is connected before proceeding.
 * If not connected, initiates connection and waits for the OPEN state.
 */
async function waitForWebSocket() {
    if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) return true;

    if (!STATE.ws || STATE.ws.readyState === WebSocket.CLOSED || STATE.ws.readyState === WebSocket.CLOSING) {
        console.warn("WebSocket not connected. Connecting...");
        document.getElementById('status-indicator').innerText = "Connecting...";
        initWebSocket();
    }

    return new Promise((resolve) => {
        const startTime = Date.now();
        const check = () => {
            if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
                resolve(true);
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
    if (STATE.currentBook && STATE.currentBook.chapters[expectedChap]) {
        if (expectedIdx >= STATE.currentBook.chapters[expectedChap].sentences.length) {
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
    if (getBufferedAheadSeconds() >= MAX_BUFFER_AHEAD_SECONDS) {
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

async function loadImageManifest(bookId) {
    if (!STATE.user || !bookId) return { version: 1, coverId: null, images: [], _found: false };
    if (STATE.imageManifestCache.has(bookId)) return STATE.imageManifestCache.get(bookId);
    const emptyManifest = { version: 1, coverId: null, images: [], _found: false };
    try {
        const response = await authFetch(`/api/stories/${encodeURIComponent(STATE.user.uid)}/${encodeURIComponent(bookId)}/images/manifest`, { cache: 'no-store' });
        const storageBackend = response.headers.get('X-Storage-Backend') || 'unknown';
        const manifestFound = response.headers.get('X-Manifest-Found') === 'true';

        if (!response.ok) {
            console.warn(`[Images] Manifest HTTP ${response.status} for book "${bookId}" (storage backend: ${storageBackend})`);
            if (response.status >= 500) {
                // Do not permanently cache 5xx server errors so that the app can retry later
                return { ...emptyManifest, _error: `HTTP ${response.status}`, _storageBackend: storageBackend, _retryable: true };
            }
            throw new Error(`Manifest HTTP ${response.status}`);
        }
        const manifest = await response.json();
        const normalized = {
            version: 1,
            coverId: null,
            images: [],
            _storageBackend: storageBackend || manifest._storage_backend || 'unknown',
            _found: manifestFound || manifest._found !== false,
            ...manifest
        };
        if (!Array.isArray(normalized.images) || normalized.images.some(image => !image || typeof image.id !== 'string' || !image.id.trim())) {
            throw new Error('Image manifest has an invalid images list');
        }
        STATE.imageManifestCache.set(bookId, normalized);
        return normalized;
    } catch (err) {
        console.warn('[Images] Manifest lookup warning for book', bookId, ':', err.message);
        STATE.imageManifestCache.set(bookId, emptyManifest);
        return emptyManifest;
    }
}

async function saveImageManifest(bookId, manifest) {
    const response = await authFetch(`/api/stories/${encodeURIComponent(STATE.user.uid)}/${encodeURIComponent(bookId)}/images/manifest`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(manifest)
    });
    if (!response.ok) throw new Error(`Manifest save failed (${response.status})`);
    STATE.imageManifestCache.set(bookId, manifest);
}

async function uploadBookImages(bookId, files, bookTitle = '') {
    if (!STATE.user || !bookId || !files?.length) return null;
    // Start from the book's stored manifest so images added from the
    // library (book not open) keep the ones already there.
    const manifest = STATE.currentBookId === bookId && STATE.imageManifest?.images
        ? STATE.imageManifest
        : await loadImageManifest(bookId);
    if (manifest._retryable) throw new Error('Không đọc được danh sách ảnh hiện có. Hãy thử lại sau.');
    const totalFiles = files.length;
    for (let idx = 0; idx < totalFiles; idx++) {
        const sourceFile = files[idx];
        const basePercent = (idx / totalFiles) * 100;
        const fileWeight = (1 / totalFiles) * 100;

        updateLoadingProgress(
            basePercent + fileWeight * 0.2,
            `Đang xử lý ảnh (${idx + 1}/${totalFiles})`,
            `Nén ${sourceFile.name}...`,
            `Xử lý ảnh ${idx + 1}/${totalFiles}`
        );

        const file = await compressImageForStorage(sourceFile, {
            onProgress: (passPercent) => {
                updateLoadingProgress(
                    basePercent + fileWeight * (passPercent / 100 * 0.4),
                    `Đang xử lý ảnh (${idx + 1}/${totalFiles})`,
                    `Tối ưu dung lượng ${sourceFile.name}...`
                );
            }
        });
        if (file.size > IMAGE_MAX_BYTES) throw new Error(`${sourceFile.name} vượt quá 150 KB sau tối ưu.`);

        updateLoadingProgress(
            basePercent + fileWeight * 0.65,
            `Đang tải lên ảnh (${idx + 1}/${totalFiles})`,
            `Đang tải ${file.name} lên đám mây...`,
            `Tải lên ${idx + 1}/${totalFiles}`
        );

        const imageId = `img_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
        const formData = new FormData();
        formData.append('imageId', imageId);
        formData.append('file', file, `${imageId}.webp`);
        const response = await authFetch(`/api/stories/${encodeURIComponent(STATE.user.uid)}/${encodeURIComponent(bookId)}/images`, {
            method: 'POST',
            body: formData
        });
        if (!response.ok) throw new Error(`Image upload failed (${response.status})`);
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
            `Đã xong ảnh ${idx + 1}/${totalFiles}`,
            `Hoàn tất ${sourceFile.name}`
        );
    }
    await saveImageManifest(bookId, manifest);
    await setDoc(doc(db, 'users', STATE.user.uid, 'progress', bookId), {
        has_images: manifest.images.length > 0
    }, { merge: true });
    if (bookId === STATE.currentBookId) STATE.imageManifest = manifest;
    releaseImageURLs();
    return manifest;
}

async function getImageURL(bookId, image) {
    if (!image?.id) return null;
    if (STATE.imageURLCache.has(image.id)) {
        const cached = STATE.imageURLCache.get(image.id);
        // Re-insert so the least recently used URLs are trimmed first.
        STATE.imageURLCache.delete(image.id);
        STATE.imageURLCache.set(image.id, cached);
        return cached;
    }
    try {
        const response = await authFetch(`/api/stories/${encodeURIComponent(STATE.user.uid)}/${encodeURIComponent(bookId)}/images/${encodeURIComponent(image.id)}`);
        if (!response.ok) {
            const storageBackend = response.headers.get('X-Storage-Backend') || 'unknown';
            throw new Error(`Image HTTP ${response.status} (backend: ${storageBackend})`);
        }
        const blob = await response.blob();
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

async function deleteBookImages(bookId) {
    if (!STATE.user || !bookId) return;
    const response = await authFetch(`/api/stories/${encodeURIComponent(STATE.user.uid)}/${encodeURIComponent(bookId)}/images`, { method: 'DELETE' });
    if (!response.ok) throw new Error(`Image cleanup failed (${response.status})`);
    STATE.imageManifestCache.delete(bookId);
    releaseImageURLs();
}

async function saveBookImageCrop(bookId, imageId, crop, sourceWidth, sourceHeight) {
    const manifest = await loadImageManifest(bookId);
    const image = manifest.images.find(item => item.id === imageId);
    if (!image) throw new Error('Ảnh không còn tồn tại.');
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
    if (!image) throw new Error('Ảnh không còn tồn tại.');
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
}

async function removeBookImage(bookId, imageId) {
    const manifest = await loadImageManifest(bookId);
    if (!manifest.images.some(item => item.id === imageId)) return;
    const response = await authFetch(`/api/stories/${encodeURIComponent(STATE.user.uid)}/${encodeURIComponent(bookId)}/images/${encodeURIComponent(imageId)}`, { method: 'DELETE' });
    if (!response.ok) throw new Error(`Image delete failed (${response.status})`);
    manifest.images = manifest.images.filter(item => item.id !== imageId);
    if (manifest.coverId === imageId) manifest.coverId = manifest.images[0]?.id || null;
    await saveImageManifest(bookId, manifest);
    await setDoc(doc(db, 'users', STATE.user.uid, 'progress', bookId), {
        has_images: manifest.images.length > 0
    }, { merge: true });
    if (bookId === STATE.currentBookId) STATE.imageManifest = manifest;
    releaseImageURL(imageId);
}

async function setBookCover(bookId, imageId) {
    const manifest = await loadImageManifest(bookId);
    const image = manifest.images.find(item => item.id === imageId);
    if (!image) throw new Error('Ảnh không còn tồn tại.');
    manifest.coverId = imageId;
    manifest.images.forEach(image => { image.role = image.id === imageId ? 'cover' : 'illustration'; });
    await saveImageManifest(bookId, manifest);
    if (bookId === STATE.currentBookId) STATE.imageManifest = manifest;
}

function imageManagerButton(label, onClick, { danger = false, disabled = false, title = '' } = {}) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = danger ? 'btn btn--danger' : 'btn';
    button.textContent = label;
    button.disabled = disabled;
    if (title) button.title = title;
    if (onClick) button.addEventListener('click', onClick);
    return button;
}

async function afterImageChange(message) {
    await renderImageManager();
    await refreshLibrary();
    if (message) APP_STATUS.toast(message, 'success');
}

async function renderImageManager() {
    const list = document.getElementById('image-manager-list');
    const title = document.getElementById('image-manager-book-title');
    const bookId = imageManagerBookId || STATE.currentBookId;
    if (!list || !bookId) return;

    if (!list.children.length) {
        list.innerHTML = '<div class="img-skeleton"></div><div class="img-skeleton"></div>';
    }

    const manifest = await loadImageManifest(bookId);
    if (bookId === STATE.currentBookId) STATE.imageManifest = manifest;
    const bookTitle = imageManagerBookTitle || STATE.currentBook?.title || tr('current-book', 'Truyện hiện tại');
    if (title) title.textContent = `${bookTitle} · ${tr(manifest.images.length === 1 ? 'image-count-one' : 'image-count', '{count} ảnh', { count: manifest.images.length })}`;
    list.replaceChildren();
    if (!manifest.images.length) {
        const backendNote = manifest._storageBackend && manifest._storageBackend !== 'unknown' ? ` (${manifest._storageBackend.toUpperCase()})` : '';
        const empty = document.createElement('div');
        empty.className = 'img-empty';
        const line1 = document.createElement('p');
        line1.textContent = tr('images-empty', 'Chưa có ảnh trong kho lưu trữ') + backendNote + '.';
        const line2 = document.createElement('p');
        line2.textContent = tr('images-empty-hint', 'Bấm “Thêm ảnh” để tải ảnh bìa và tranh minh hoạ.');
        empty.append(line1, line2);
        list.append(empty);
        return;
    }
    for (const image of manifest.images) {
        const isCover = manifest.coverId === image.id;
        const row = document.createElement('div');
        row.className = 'img-row';
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
        const coverBtn = imageManagerButton(isCover ? tr('is-cover', 'Đang là bìa') : tr('set-cover', 'Đặt bìa'), async () => {
            setButtonLoading(coverBtn, true, '…');
            try {
                await setBookCover(bookId, image.id);
                await afterImageChange(tr('cover-set-done', 'Đã đặt làm ảnh bìa.'));
            } catch (err) {
                APP_STATUS.error(err, 'Không thể đặt ảnh bìa');
            } finally {
                setButtonLoading(coverBtn, false);
            }
        }, { disabled: isCover });
        const cropBtn = imageManagerButton(tr('crop-title', 'Căn bìa'), () => openImageCropper(bookId, image),
            { title: tr('crop-hint', 'Kéo ảnh để chọn vùng hiện trên bìa. Ảnh gốc không bị cắt.') });
        const replaceBtn = imageManagerButton(tr('replace-image', 'Thay'), () => {
            STATE.imageEditTargetId = image.id;
            imageInput?.click();
        });
        const deleteBtn = imageManagerButton(tr('delete', 'Xoá'), async () => {
            if (!confirm(tr('delete-image-confirm', 'Xoá ảnh “{name}”?', { name: image.alt || tr('illustration', 'Ảnh minh hoạ') }))) return;
            setButtonLoading(deleteBtn, true, '…');
            try {
                await removeBookImage(bookId, image.id);
                await afterImageChange(tr('image-deleted', 'Đã xoá ảnh.'));
            } catch (err) {
                APP_STATUS.error(err, 'Không thể xoá ảnh');
                setButtonLoading(deleteBtn, false);
            }
        }, { danger: true });
        actions.append(coverBtn, cropBtn, replaceBtn, deleteBtn);
        row.append(thumb, info, actions);
        list.append(row);
    }
}

async function openImageManager(bookId = STATE.currentBookId, bookTitle = STATE.currentBook?.title || '') {
    if (!bookId) {
        APP_STATUS.toast('Hãy mở một truyện trước.', 'warning');
        return;
    }
    if (imageManagerBookId !== bookId) document.getElementById('image-manager-list')?.replaceChildren();
    imageManagerBookId = bookId;
    imageManagerBookTitle = bookTitle;
    setModalVisibility('image-manager-modal', true);
    try { await renderImageManager(); } catch (err) {
        console.error('[Images] Manager load error:', err);
        APP_STATUS.error(`Không thể tải danh sách ảnh: ${err.message}`);
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
            window.APP_STATUS.toast('Vui lòng đăng nhập để đồng bộ thư viện đám mây.', 'info');
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
        // A newer refresh or an account switch owns the views now.
        if (STATE.user?.uid !== libraryUid || refreshId !== libraryView.refreshSeq) return;

        const entries = [];
        querySnapshot.forEach((docSnap) => {
            const data = docSnap.data();
            const bookId = docSnap.id;
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
        entries.sort((a, b) => (b.lastListenedAt - a.lastListenedAt) || a.title.localeCompare(b.title, 'vi'));

        discoveryLibrary = entries;
        libraryView.status = 'ready';
        // Covers are re-derived from the cached manifests/URLs, so a cover
        // change made in the image manager shows up after this refresh.
        STATE.coverResolved.clear();
        if (!STATE.currentBookId) toggleDiscoveryMode(true);
        renderLibraryViews();
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
        APP_STATUS.toast('Vui lòng đăng nhập để tải sách về máy.', 'warning');
        return;
    }

    const btn = triggerBtn || (bookId === STATE.currentBookId ? document.getElementById('toc-download-txt-btn') : null);
    if (btn) setButtonLoading(btn, true, 'Đang chuẩn bị...');

    const status = document.getElementById('status-indicator');
    const previousStatus = status?.innerText || 'Ready';
    if (status) status.innerText = 'Preparing TXT...';
    APP_STATUS.toast('Đang xuất file TXT toàn bộ tác phẩm...', 'info');

    try {
        const response = await authFetch(`/api/stories/${encodeURIComponent(STATE.user.uid)}/${encodeURIComponent(bookId)}/export-text`);

        if (!response.ok) {
            let message = 'Unable to download the TXT file.';
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
        if (status) status.innerText = 'TXT download started';
        APP_STATUS.toast(`Đã tải xuống file "${filename}" thành công!`, 'success');
        if (btn && window.MotionLayer?.animateSuccessCheck) {
            window.MotionLayer.animateSuccessCheck(btn);
        }
    } catch (err) {
        console.error('[Export TXT]', err);
        APP_STATUS.error(`Không thể tải file TXT: ${err.message}`);
        if (status) status.innerText = 'TXT download failed';
    } finally {
        if (btn) setButtonLoading(btn, false);
        setTimeout(() => {
            if (status && (status.innerText === 'TXT download started' || status.innerText === 'TXT download failed')) {
                status.innerText = previousStatus || 'Ready';
            }
        }, 2500);
    }
}

// ── Feature 1: Delete Book ───────────────────────────────────────────────────

/**
 * Deletes a book's Firestore document AND Storage file in parallel.
 * Gracefully handles the case where the Storage file doesn't exist.
 */
async function deleteBook(bookId, filename, title, bypassConfirm = false) {
    closeAllKebabMenus(); // close menu first

    if (!bypassConfirm && !confirm(`Xóa truyện "${title}"?\n\nHành động này sẽ xóa vĩnh viễn dữ liệu trên Cloud. Không thể hoàn tác!`)) return;
    if (!STATE.user) return;

    document.getElementById('status-indicator').innerText = 'Đang xóa...';

    try {
        // ── 1. Firestore delete ──────────────────────────────────────────────
        const deleteFirestore = deleteDoc(doc(db, 'users', STATE.user.uid, 'progress', bookId));

        // ── 2. Delete all file/segment/image objects through the backend ─────
        const storageQuery = filename ? `?filename=${encodeURIComponent(filename)}` : '';
        const deleteStorage = authFetch(`/api/stories/${encodeURIComponent(STATE.user.uid)}/${encodeURIComponent(bookId)}/storage${storageQuery}`, { method: 'DELETE' }).then(response => {
            if (!response.ok) throw new Error(`Storage delete failed (${response.status})`);
        });

        // ── 3. Run Firestore and storage cleanup in parallel ────────────────
        await Promise.all([deleteFirestore, deleteStorage]);
        console.log(`[Delete] "${title}" deleted successfully.`);

        // ── 4. If the deleted book is currently open, reset the reader ────────
        if (STATE.currentBookId === bookId) {
            await handlePlaybackStall(); // This handles WS close, RAM/ROM clear, and UI reset
            closeCurrentBook();
        }

        // ── 5. Refresh library sidebar ────────────────────────────────────────
        await refreshLibrary();
        document.getElementById('status-indicator').innerText = 'Đã xóa!';
        setTimeout(() => document.getElementById('status-indicator').innerText = 'Ready', 2500);

    } catch (err) {
        console.error('[Delete] Error:', err);
        APP_STATUS.error(`Xóa thất bại: ${err.message}`);
        document.getElementById('status-indicator').innerText = 'Error';
        setTimeout(() => document.getElementById('status-indicator').innerText = 'Ready', 3000);
    }
}

function closeCurrentBook() {
    STATE.currentBook = null;
    STATE.currentBookId = null;
    STATE.currentFilename = null;
    STATE.currentChapterIndex = 0;
    STATE.currentSentenceIndex = 0;
    document.getElementById('current-title').innerText = 'Select a Masterpiece';
    document.getElementById('current-chapter').innerText = 'Standby Mode';
    textContainer.replaceChildren(...(readerEmptyTemplate ? [readerEmptyTemplate.cloneNode(true)] : []));
    document.getElementById('minimap-nodes')?.replaceChildren();
    document.getElementById('edit-title-btn').classList.add('hidden');
    const playerTitle = document.getElementById('player-title');
    const playerAuthor = document.getElementById('player-author');
    if (playerTitle) { playerTitle.innerText = 'System Ready'; playerTitle.title = ''; }
    if (playerAuthor) { playerAuthor.innerText = 'Cloud TTS'; playerAuthor.title = ''; }
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
    document.getElementById('merge-chapter-position').innerText = `Chương ${activeIndex + 1}/${chapters.length}`;
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
    document.getElementById('merge-chapters-modal').classList.add('hidden');
}

async function mergeChapterFile(event, bookId, bookData) {
    const newFile = event.target.files[0];
    event.target.value = '';
    if (!newFile || !STATE.user) return;
    const filename = bookData.filename || (bookId.replace('book_', '') + '.txt');
    APP_STATUS.set('Đang phân tích chương...');
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
        document.getElementById('merge-chapters-modal').classList.remove('hidden');
        APP_STATUS.set('Sẵn sàng');
    } catch (error) {
        console.error('[Merge preview] Error:', error);
        APP_STATUS.error(error, 'Không thể mở bản xem trước nối chương.');
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
    if (imageCropSession?.objectURL) URL.revokeObjectURL(imageCropSession.objectURL);
    imageCropSession = null;
    setModalVisibility('image-crop-modal', false);
}

async function openImageCropper(bookId, image) {
    try {
        const sourceURL = await getImageURL(bookId, image);
        if (!sourceURL) throw new Error('Không thể tải ảnh để crop.');
        const sourceBlob = await fetch(sourceURL).then(response => {
            if (!response.ok) throw new Error(`Không thể tải ảnh (${response.status}).`);
            return response.blob();
        });
        const sourceFile = new File([sourceBlob], `${image.alt || 'image'}.webp`, { type: sourceBlob.type || 'image/webp' });
        const objectURL = URL.createObjectURL(sourceFile);
        const preview = document.getElementById('image-crop-preview');
        const stage = document.getElementById('image-crop-stage');
        const zoom = document.getElementById('image-crop-zoom');
        if (!preview || !stage || !zoom) throw new Error('Không thể mở công cụ crop.');

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
        APP_STATUS.error(`Không thể mở crop: ${err.message}`);
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
        APP_STATUS.toast(tr('crop-saved', 'Đã lưu vùng bìa.'), 'success');
    } catch (err) {
        console.error('[Images] Crop save error:', err);
        APP_STATUS.error(`Không thể lưu crop: ${err.message}`);
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
        APP_STATUS.toast('Hãy chọn ít nhất một chương có nội dung.');
        return;
    }
    const button = document.getElementById('confirm-merge-btn');
    setButtonLoading(button, true, 'Đang nối chương...');
    APP_STATUS.set(`Đang nối ${chapters.length} chương...`);
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
        APP_STATUS.set('Nối chương thành công');
        APP_STATUS.toast(`Đã nối ${chapters.length} chương thành công.`, 'success');
    } catch (error) {
        console.error('[Merge save] Error:', error);
        APP_STATUS.error(error, 'Nối chương thất bại; bạn có thể thử lại.');
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

    showLoading("Fetching " + bookData.title + "...");
    document.getElementById('status-indicator').innerText = "Loading Metadata...";
    const currentTitleEl = document.getElementById('current-title');
    currentTitleEl.innerText = "Fetching " + bookData.title + "...";
    currentTitleEl.title = bookData.title;

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
        document.getElementById('status-indicator').innerText = "Ready";
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
        APP_STATUS.error("Không thể tải sách từ bộ nhớ. Hãy kiểm tra file có còn tồn tại.");
    } finally {
        if (STATE.loadController === loadController) {
            STATE.loadController = null;
            hideLoading();
        }
    }
}

// --- Auth state is now handled inside startFirebase() ---

// --- File Handling ---
const handleFileUpload = async (e) => {
    const selectedFiles = Array.from(e.target.files || []);
    const file = selectedFiles.find(candidate => /\.(txt|epub|pdf)$/i.test(candidate.name));
    const includeImages = STATE.uploadImagesChoice;
    STATE.uploadImagesChoice = false;
    if (!file) {
        APP_STATUS.toast('Hãy chọn file .txt, .epub hoặc .pdf cho truyện.');
        e.target.value = '';
        return;
    }

    if (!/\.(txt|epub|pdf)$/i.test(file.name)) {
        APP_STATUS.toast('Chỉ hỗ trợ file .txt, .epub hoặc .pdf.');
        e.target.value = '';
        return;
    }
    if (file.size === 0) {
        APP_STATUS.toast('File đang trống. Vui lòng chọn file có nội dung.', 'warning');
        e.target.value = '';
        return;
    }
    if (file.size > 25 * 1024 * 1024) {
        APP_STATUS.toast('File vượt quá giới hạn 25 MB. Hãy chia nhỏ nội dung trước khi tải lên.', 'warning');
        e.target.value = '';
        return;
    }

    if (!STATE.user) {
        APP_STATUS.toast("Vui lòng đăng nhập trước khi tải sách lên.", 'warning');
        return;
    }

    const illustrations = includeImages ? selectedFiles.filter(candidate => candidate !== file) : [];

    showLoading("Đang tải lên " + file.name, {
        subtext: "Đang kiểm tra & phân tách chương...",
        progress: 10,
        status: "Tải sách"
    });
    const uploaderUid = STATE.user.uid;
    const formData = new FormData();
    formData.append('userId', uploaderUid);
    formData.append('file', file);

    document.getElementById('status-indicator').innerText = "Processing Story...";
    try {
        // Give the user a useful preview without reading a large file into memory:
        // inspect only the first 4 MB for chapter separators.
        let separatorCount = 0;
        if (file.name.toLowerCase().endsWith('.txt')) {
            const preview = await file.slice(0, 4 * 1024 * 1024).text();
            separatorCount = (preview.match(/^\s*={3,}\s*$/gm) || []).length;
            if (separatorCount === 0 && !confirm('Không tìm thấy dòng === để phân cách chương. File sẽ được nhập thành một chương. Tiếp tục?')) {
                hideLoading();
                return;
            }
        }
        const estimatedChapters = separatorCount + 1;
        updateLoadingProgress(25, "Đang xử lý truyện...", file.name.toLowerCase().endsWith('.txt') ? `Tìm thấy ~${estimatedChapters} chương. Đang gửi lên cloud...` : 'Đang phân tích cấu trúc...', 'Gửi dữ liệu');
        const response = await authFetch('/api/upload-story', {
            method: 'POST',
            body: formData
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
        const data = await response.json();

        updateLoadingProgress(illustrations.length ? 50 : 85, "Đang khởi tạo mục lục...", "Tải thông tin metadata từ server...", "Khởi tạo");
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

        if (illustrations.length) {
            document.getElementById('status-indicator').innerText = `Đang tối ưu ${illustrations.length} ảnh...`;
            try {
                await uploadBookImages(data.storyId, illustrations, bookInfo.title || file.name);
            } catch (imageError) {
                console.error('[Images] Upload failed:', imageError);
                APP_STATUS.toast(`Sách đã tải lên nhưng ảnh minh họa chưa lưu được: ${imageError.message}`, 'warning');
            }
        }

        updateLoadingProgress(95, "Đang mở sách...", "Sắp xong rồi!", "Hoàn tất");
        if (STATE.user?.uid !== uploaderUid) return;
        // --- FIX BUG 6: Await loadBook and call refreshLibrary directly ---
        const loaded = await loadBook(bookInfo, data.storyId, data.filename || file.name);
        if (!loaded) return;
        await refreshLibrary();
        APP_STATUS.toast(`Đã thêm "${bookInfo.title || file.name}" vào thư viện!`, 'success');
        STATE.pendingImageFiles = [];
        if (imageInput) imageInput.value = '';
    } catch (err) {
        console.error(err);
        APP_STATUS.error(err, 'Không thể import sách.');
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
    const imageManifestPromise = loadImageManifest(STATE.currentBookId).then(manifest => {
        if (loadGeneration !== STATE.loadGeneration || STATE.currentBookId !== expectedBookId) return manifest;
        STATE.imageManifest = manifest;
        if (manifest.images.length && STATE.user) {
            void setDoc(doc(db, 'users', STATE.user.uid, 'progress', STATE.currentBookId), { has_images: true }, { merge: true })
                .catch(err => console.debug('[Images] Progress flag skipped:', err.message));
            // Text is already visible; add images without blocking first render.
            if (STATE.currentBook?.chapters?.[STATE.currentChapterIndex]?.sentences) {
                void renderChapter(STATE.currentChapterIndex).catch(err => console.debug('[Images] Deferred render skipped:', err.message));
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
    currentTitleEl.innerText = STATE.currentBook.title;
    currentTitleEl.title = STATE.currentBook.title;
    document.getElementById('edit-title-btn').classList.remove('hidden');

    await renderChapter(STATE.currentChapterIndex);
    if (loadGeneration !== STATE.loadGeneration) return false;
    renderTOC();
    updateUI();

    if (progress) {
        highlightSentence(STATE.currentSentenceIndex);
    }

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

    document.getElementById('status-indicator').innerText = "Loading Chapter...";

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
            document.getElementById('status-indicator').innerText = "Ready";
        } else {
            throw new Error(data.error || "Failed to load chapter content.");
        }
        return true;
    } catch (e) {
        console.error(e);
        document.getElementById('status-indicator').innerText = "Error loading chapter";
        throw e;
    }
}

async function renderChapterImages(index) {
    if (!STATE.imageManifest?.images?.length) return [];
    const images = STATE.imageManifest.images.filter(image => image.chapterIndex === index || (image.chapterIndex == null && index === 0));
    const figures = [];
    for (const image of images) {
        const url = await getImageURL(STATE.currentBookId, image);
        if (!url) continue;
        const figure = document.createElement('figure');
        figure.className = 'reader-figure';
        const img = document.createElement('img');
        img.src = url;
        img.alt = image.alt || tr('illustration', 'Ảnh minh hoạ');
        img.loading = 'lazy';
        img.decoding = 'async';
        figure.appendChild(img);
        if (image.alt) {
            const caption = document.createElement('figcaption');
            caption.textContent = image.alt;
            figure.appendChild(caption);
        }
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
    chapterLabel.innerText = `C.${index + 1}/${chapterCount} · ${chapterTitle}`;
    chapterLabel.title = chapterTitle;

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
            error.textContent = tr('chapter-load-error', 'Không thể tải nội dung chương: {reason}', { reason: e.message });
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
                target.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
    name.textContent = title;
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

function buildTOCNowLabel() {
    const now = document.createElement('span');
    now.className = 'toc-row__now';
    now.textContent = tr('toc-now', 'đang nghe');
    return now;
}

function updateTOCCount() {
    const countEl = document.getElementById('toc-count');
    if (!countEl) return;
    const total = STATE.currentBook?.chapters?.length || 0;
    if (!total) {
        countEl.textContent = '';
        return;
    }
    const shown = document.querySelectorAll('#toc-list > .toc-row:not([style*="none"])').length;
    const query = tocSearchInput?.value.trim();
    countEl.textContent = query
        ? tr('toc-count-filtered', '{shown}/{total} chương', { shown, total })
        : tr('toc-count', '{total} chương · đang nghe C.{current}', { total, current: STATE.currentChapterIndex + 1 });
}

function renderTOC() {
    const tocList = document.getElementById('toc-list');
    if (!tocList) return;
    tocList.innerHTML = '';

    const labelEl = document.getElementById('toc-book-label');
    if (labelEl) labelEl.textContent = STATE.currentBook?.title || tr('toc-no-book', 'Chưa mở truyện');

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
        fragment.appendChild(buildTOCRow(chap, i, i === STATE.currentChapterIndex));
    });
    tocList.appendChild(fragment);

    // Re-apply TOC search if query exists
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
        await switchChapter(i, 0, true);
        closeTOC();
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
    // The pinned row sticks to an edge, so scroll by its layout position, not its box.
    const target = activeItem.offsetTop - (tocList.clientHeight - activeItem.offsetHeight) / 2;
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
        countEl.innerText = tr('toc-selected', '{n} chương đã chọn', { n: checkboxes.length });
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
        APP_STATUS.toast('Vui lòng chọn ít nhất một chương.', 'warning');
        return;
    }

    const selectedIndices = Array.from(checkboxes).map(cb => parseInt(cb.dataset.chapterIndex));
    if (selectedIndices.length > 5) {
        APP_STATUS.toast('Tối đa chỉ cho tải 5 chương trong một lần tải để đảm bảo tốc độ siêu tốc và kết nối ổn định. Vui lòng chọn tối đa 5 chương.', 'warning');
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
    statusEl.innerText = "Preparing chapters for download...";
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

            statusEl.innerText = `Preparing chapter ${i + 1}/${selectedIndices.length}...`;
            progressBar.style.width = `${prepProgress}%`;
            percentEl.innerText = `${prepProgress}%`;
            chapterInfo.innerText = `Chapter ${idx + 1}`;

            if (!STATE.currentBook.chapters[idx].sentences) {
                await fetchChapterSentences(idx);
            }
        }

        const chapters = selectedIndices.map(idx => ({
            chapterIndex: idx,
            title: STATE.currentBook.chapters[idx].title,
            sentences: STATE.currentBook.chapters[idx].sentences
        }));

        const { voice, speed, pitch, volume } = STATE.settings;
        const rate = `${Math.round((speed - 1) * 100) >= 0 ? '+' : ''}${Math.round((speed - 1) * 100)}%`;

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

        document.getElementById('status-indicator').innerText = "Downloading Offline (50 Workers)...";
        progressBar.style.width = '0%';
        percentEl.innerText = '0%';
        chapterInfo.innerText = `0 / ${STATE.downloadExpected} chunks`;
        statusEl.innerText = `Dispatching ${STATE.downloadExpected} chunks to 50 parallel workers...`;

        console.log(`[Download] Starting 50-worker parallel download: ${STATE.downloadExpected} chunks across ${chapters.length} chapters`);

        // 4. Ensure WebSocket is connected (workers are needed!)
        if (!(await waitForWebSocket())) {
            throw new Error("WebSocket connection timeout.");
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
        chapterInfo.innerText = 'Merging audio...';
        statusEl.innerText = 'All chunks received. Building MP3...';

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

        statusEl.innerText = '✓ Download complete!';
        setTimeout(() => {
            statusEl.classList.add('hidden');
            progressContainer.classList.add('hidden');
            progressBar.style.width = '0%';
        }, 4000);
    } catch (err) {
        console.error('Download Error:', err);
        statusEl.innerText = `✗ ${err.message || 'Download failed.'}`;
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
        document.getElementById('status-indicator').innerText = "Disconnected";
        const playBtn = document.getElementById('play-btn');
        if (playBtn) playBtn.innerHTML = '<i class="fas fa-play ml-1"></i>';
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

async function deleteSelectedChapters() {
    const checkboxes = document.querySelectorAll('.toc-chapter-checkbox:checked');
    if (checkboxes.length === 0) {
        APP_STATUS.toast('Vui lòng chọn ít nhất một chương để xóa.');
        return;
    }

    const selectedIndices = Array.from(checkboxes).map(cb => parseInt(cb.dataset.chapterIndex));
    const confirmMsg = `Bạn có chắc chắn muốn xóa ${selectedIndices.length} chương đã chọn không?\nThao tác này sẽ cập nhật trực tiếp vào file lưu trữ.`;

    if (!confirm(confirmMsg)) return;

    const btn = document.getElementById('toc-delete-btn');
    setButtonLoading(btn, true, 'Đang xóa...');

    try {
        const formData = new FormData();
        formData.append('userId', STATE.user.uid);
        formData.append('bookId', STATE.currentBookId);
        formData.append('filename', STATE.currentFilename);
        formData.append('indices', JSON.stringify(selectedIndices));

        const response = await authFetch('/api/delete-chapters', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error || 'Failed to delete chapters');
        }

        const data = await response.json();

        // Calculate total chunks from metadata chapters
        const newTotalChunks = data.chapters.reduce((sum, ch) => sum + (ch.count || 0), 0);

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

        // Update Firestore total_chunks (to keep library in sync)
        const bookRef = doc(db, "users", STATE.user.uid, "progress", STATE.currentBookId);
        await setDoc(bookRef, { total_chunks: newTotalChunks }, { merge: true });

        APP_STATUS.toast(`Đã xóa ${selectedIndices.length} chương thành công!`, 'success');

        // Reset UI
        toggleSelectMode();
        renderTOC();

        // --- AUTO-DELETE STORY IF EMPTY ---
        if (data.chapters.length === 0) {
            APP_STATUS.toast('Tất cả các chương đã bị xóa. Đang gỡ truyện khỏi thư viện...', 'info');
            await deleteBook(STATE.currentBookId, STATE.currentFilename, STATE.currentBook.title, true);
            return;
        }

        // If we deleted the current chapter or shifted things, it's safer to just reset to chapter 0 or reload
        if (STATE.currentChapterIndex >= data.chapters.length) {
            STATE.currentChapterIndex = 0;
        }
        await renderChapter(STATE.currentChapterIndex);

    } catch (err) {
        console.error('Delete Error:', err);
        APP_STATUS.error(err, 'Không thể xóa chương.');
    } finally {
        setButtonLoading(btn, false);
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
        const maxSentences = count * PREFETCH_MAX_COUNT_FACTOR;
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
                    metadata: [] // Cached blobs might not have word timings saved yet
                });
                processAppendQueue();
                currentSentIdx++;
                continue;
            }

            STATE.fetchingSet.add(key);
            const text = applySkipDictionary(STATE.currentBook.chapters[currentChapIdx].sentences[currentSentIdx]);
            const { voice, speed, pitch, volume } = STATE.settings;
            const rate = `${Math.round((speed - 1) * 100) >= 0 ? '+' : ''}${Math.round((speed - 1) * 100)}%`;

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

async function playFromSentence(index, expectedLoadGeneration = STATE.loadGeneration) {
    if (!STATE.currentBook) return;
    const expectedBookId = STATE.currentBookId;
    const isCurrentPlayback = () => (
        expectedLoadGeneration === STATE.loadGeneration &&
        expectedBookId === STATE.currentBookId &&
        STATE.currentBook
    );

    // 0. Robust Engine Reset - Dọn dẹp triệt để phiên cũ (dừng audio, xóa buffer, reset sessionId)
    await resetAudioEngine();
    if (!isCurrentPlayback()) return;

    // Dọn dẹp cache cũ khi nhảy tới vị trí mới (jump) - "Dọn dẹp sạch cho cái mới đi vào"
    await OFFLINE_MANAGER.clearCache();
    if (!isCurrentPlayback()) return;

    if (!(await waitForWebSocket())) {
        if (!isCurrentPlayback()) return;
        document.getElementById('status-indicator').innerText = "Connection failed";
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

    // Use the sessionId incremented by resetAudioEngine
    const currentSessionId = STATE.sessionId;
    STATE.lastAppendedIndex = index - 1; // Restart sequence from the target index
    STATE.lastAppendedPartKey = null;
    STATE.lastAppendedPart = -1;
    STATE.lastAppendedChapter = STATE.currentChapterIndex;
    console.log(`Starting new audio session: ${currentSessionId} (Jump to chunk ${index})`);

    updatePrefetchUI();
    document.getElementById('status-indicator').innerText = "Buffering...";
    const { voice, speed, pitch, volume } = STATE.settings;
    const rate = `${Math.round((speed - 1) * 100) >= 0 ? '+' : ''}${Math.round((speed - 1) * 100)}%`;

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
        if (attempts === 50) document.getElementById('status-indicator').innerText = "Đang chờ máy chủ TTS...";
    }
    if (STATE.chunkTimings.length === 0 && STATE.sessionId === currentSessionId && isCurrentPlayback()) {
        document.getElementById('status-indicator').innerText = "Máy chủ TTS không phản hồi — bấm Play để thử lại";
    }

    if (STATE.chunkTimings.length > 0 && STATE.sessionId === currentSessionId && isCurrentPlayback()) {
        try {
            await audio.play();
        } catch (err) {
            // Do not claim playback is active when the browser rejected
            // autoplay. The old code marked STATE.isPlaying=true anyway,
            // which made inactivity handling save the initial sentence.
            STATE.isPlaying = false;
            document.getElementById('status-indicator').innerText = 'Bấm Play để bắt đầu nghe';
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
                } else if (window.MotionLayer?.smoothScrollToSweetSpot) {
                    window.MotionLayer.smoothScrollToSweetSpot(container, cur, 0.28, 0.42);
                } else {
                    container.scrollTo({
                        top: targetScroll,
                        behavior: 'smooth'
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
            miniNode.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
        document.getElementById('status-indicator').innerText = "Connecting...";
        if (!(await waitForWebSocket())) {
            document.getElementById('status-indicator').innerText = "Connection failed";
            return;
        }
        if (STATE.chunkTimings.length === 0) {
            await playFromSentence(STATE.currentSentenceIndex);
        } else {
            audio.play();
        }
    } else {
        audio.pause();
    }
}

playBtn.onclick = () => togglePlayback();


audio.onplay = async () => {
    STATE.isTransitioning = false;
    STATE.isPlaying = true;
    STATE.pauseTimeoutHandled = false;

    // [Audio Waves] Activate wave motion
    setAudioWaveState(true);

    // [TASK 3] Reset stall recovery counters on successful play
    STATE._stallRecoveryCount = 0;
    STATE._stallWaitCount = 0;
    STATE.streamingRetryCount.clear();

    playBtn.innerHTML = '<i class="fas fa-pause"></i>';
    document.getElementById('status-indicator').innerText = "Streaming";
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

    playBtn.innerHTML = '<i class="fas fa-play ml-1"></i>';
    document.getElementById('status-indicator').innerText = "Paused";
    updatePipUI();
    if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'paused';
    }
    if (!STATE.isTransitioning && !audio.ended) {
        saveProgress(true); // Checkpoint progress on manual pause or buffer wait
        if (STATE.user && !STATE.strictSyncMode) STATS_MANAGER.syncToFirestore();
    }
};

async function editTitle() {
    if (!STATE.currentBook || !STATE.user) return;
    const previousTitle = STATE.currentBook.title;
    const requestedTitle = prompt("Enter title for this book:", previousTitle);
    const newTitle = requestedTitle?.trim();
    if (!newTitle || newTitle === previousTitle) return;

    STATE.currentBook.title = newTitle;
    document.getElementById('current-title').innerText = newTitle;
    document.getElementById('current-title').title = newTitle;
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
    } catch (err) {
        STATE.currentBook.title = previousTitle;
        document.getElementById('current-title').innerText = previousTitle;
        document.getElementById('current-title').title = previousTitle;
        updateUI();
        console.error('[Title] Save failed:', err);
        APP_STATUS.error(`Không thể lưu tên truyện: ${err.message}`);
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
    // If buffer < 5 seconds and not currently fetching, top up from the last known buffered chunk
    if (timeRemaining > 0 && timeRemaining < 5.0 && STATE.fetchingSet.size === 0) {
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
document.getElementById('speed-range').oninput = (e) => {
    STATE.settings.speed = parseFloat(e.target.value);
    document.getElementById('speed-val').innerText = `${e.target.value}x`;
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
    document.getElementById('prefetch-val').innerText = `${count} Workers`;
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

    debouncedApplyTypography();
};

document.getElementById('color-reset-btn').onclick = () => {
    STATE.settings.textColor = "default";
    applyTypographySettings();
    scheduleBookSettingsSave();
};

document.querySelectorAll('.preset-color').forEach(btn => {
    btn.onclick = () => {
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
        const sel2 = document.getElementById('quick-font-family-select');
        if (sel2) sel2.value = fontFamily;
        const badge = document.getElementById('quick-font-family-badge');
        if (badge) badge.innerText = fontFamily;
        const val1 = document.getElementById('font-family-val');
        if (val1) val1.innerText = fontFamily;
        const sample = document.getElementById('quick-font-sample-preview');
        if (sample) sample.style.fontFamily = readerFontStack(fontFamily);
    }
}

// Bind Font Selectors
const fontSelect = document.getElementById('font-family-select');
if (fontSelect) {
    fontSelect.onchange = (e) => {
        applyFontFamily(e.target.value);
    };
}

const quickFontSelect = document.getElementById('quick-font-family-select');
if (quickFontSelect) {
    quickFontSelect.onchange = (e) => {
        applyFontFamily(e.target.value);
    };
}

// Quick Appearance & Theme Settings Controller Bridge
const quickSettingsBtn = document.getElementById('quick-settings-btn');
quickSettingsBtn?.addEventListener('click', () => {
    window.QuickSettingsController?.open();
});

function applyTypographySettings() {
    const s = STATE.settings;
    const root = document.documentElement;

    // Apply Font Size
    root.style.setProperty('--reader-font-size', `${s.fontSize}px`);

    // Apply Font Family
    const currentFont = localStorage.getItem('reader-font-family') || DEFAULT_READER_FONT;
    applyFontFamily(currentFont, true);

    // Apply Text Color
    if (s.textColor === "default") {
        root.style.setProperty('--reader-text-color', 'var(--theme-text-reading)');
        const defaultColor = getComputedStyle(root).getPropertyValue('--theme-text-reading').trim() || "#CBD5E1";
        const colorPicker = document.getElementById('font-color-picker');
        if (colorPicker && defaultColor.startsWith('#')) {
            colorPicker.value = defaultColor;
        }
    } else {
        root.style.setProperty('--reader-text-color', s.textColor);
        const colorPicker = document.getElementById('font-color-picker');
        if (colorPicker) colorPicker.value = s.textColor;
    }
}

window.addEventListener('themechange', () => {
    applyTypographySettings();
});

// --- UI Interactions ---
document.getElementById('prev-btn').onclick = () => playPrevChapter();
document.getElementById('next-btn').onclick = () => playNextChapter();
document.getElementById('prev-chunk-btn').onclick = () => playPrevChunk();
document.getElementById('next-chunk-btn').onclick = () => playNextChunk();

document.getElementById('sync-btn').onclick = () => refreshLibrary();
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

// // Player Minimize Logic
function toggleMinimize(isMinimized) {
    const mediaPlayer = document.getElementById('media-player');
    const minimizeBtn = document.getElementById('minimize-btn');

    if (isMinimized === undefined) {
        isMinimized = !mediaPlayer.classList.contains('minimized-player');
    }

    mediaPlayer.classList.toggle('minimized-player', isMinimized);
    minimizeBtn.innerHTML = isMinimized ?
        '<i class="fas fa-chevron-up text-[10px]"></i>' :
        '<i class="fas fa-chevron-down text-[10px]"></i>';
    minimizeBtn.setAttribute('aria-expanded', String(!isMinimized));
    minimizeBtn.setAttribute('aria-label', isMinimized ? 'Mở rộng trình phát' : 'Thu gọn thành PiP');
    minimizeBtn.title = isMinimized ? 'Mở rộng trình phát' : 'Thu gọn thành PiP';

    localStorage.setItem('player-minimized', isMinimized);
}

document.getElementById('minimize-btn').onclick = () => toggleMinimize();

// Default to expanded on load per user request
toggleMinimize(false);

const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(err => {
            console.error(`Error attempting to enable fullscreen: ${err.message}`);
        });
    } else {
        document.exitFullscreen();
    }
};

const fullscreenBtn = document.getElementById('fullscreen-btn');
if (fullscreenBtn) {
    fullscreenBtn.onclick = toggleFullscreen;
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
        if (bookTitleEl) bookTitleEl.textContent = STATE.currentBook.title || 'Cloud TTS Reader';
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
    exitIcon?.querySelector('use')?.setAttribute('href', isAwake ? '#i-unlock' : '#i-lock');
    if (exitLabel) {
        const key = isAwake ? 'pocket-tap-again' : 'pocket-mode-exit';
        exitLabel.dataset.i18n = key;
        exitLabel.textContent = tr(key, isAwake ? 'Chạm lần nữa để mở khóa' : 'Chạm 2 lần để mở màn hình');
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
        if (window.APP_STATUS) APP_STATUS.toast(tr('pocket-unlocked', 'Đã mở lại màn hình đọc sách.'), 'info');
        if (window.AudioHapticFX) AudioHapticFX.trigger(12);
    }
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
        brightenPocketOverlay();
        togglePlayback();
        setTimeout(updatePocketModeInfo, 50);
    });

    // Pocket Prev Chunk Button
    document.getElementById('pocket-prev-chunk-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        brightenPocketOverlay();
        playPrevChunk();
        setTimeout(updatePocketModeInfo, 50);
    });

    // Pocket Next Chunk Button
    document.getElementById('pocket-next-chunk-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        brightenPocketOverlay();
        playNextChunk();
        setTimeout(updatePocketModeInfo, 50);
    });

    // Keyboard shortcut Escape to immediately exit Pocket Mode
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && STATE.isLiteMode) {
            dimPocketOverlay();
            applyLiteMode(false);
            if (window.APP_STATUS) APP_STATUS.toast(tr('pocket-unlocked', 'Đã mở lại màn hình đọc sách.'), 'info');
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
        } else {
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

    const quickToggle = document.getElementById('quick-lite-mode-toggle');
    if (quickToggle && quickToggle.checked !== STATE.isLiteMode) {
        quickToggle.checked = STATE.isLiteMode;
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

// Mobile toggle: override the inline onchange with a proper listener for symmetry
const liteModeToggleMobile = document.getElementById('lite-mode-toggle-mobile');
if (liteModeToggleMobile) {
    liteModeToggleMobile.removeAttribute('onchange');
    liteModeToggleMobile.addEventListener('change', (e) => {
        applyLiteMode(e.target.checked);
    });
}

// Quick Speed Cycle for Player Chip
const speedChip = document.getElementById('speak-speed-chip');
if (speedChip) {
    speedChip.addEventListener('click', (e) => {
        e.stopPropagation();
        const speeds = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
        const currentSpeed = (STATE.settings && STATE.settings.speed) ? Number(STATE.settings.speed) : 1.0;
        let nextIndex = speeds.findIndex(s => Math.abs(s - currentSpeed) < 0.05);
        if (nextIndex === -1) {
            nextIndex = speeds.findIndex(s => s > currentSpeed);
            if (nextIndex === -1) nextIndex = 0;
        } else {
            nextIndex = (nextIndex + 1) % speeds.length;
        }
        const nextSpeed = speeds[nextIndex];
        if (window.QuickSettingsController && typeof window.QuickSettingsController.setSpeed === 'function') {
            window.QuickSettingsController.setSpeed(nextSpeed);
        } else {
            if (STATE.settings) STATE.settings.speed = nextSpeed;
            speedChip.innerText = `${nextSpeed.toFixed(1)}X`;
            const sRange = document.getElementById('speed-range');
            if (sRange) sRange.value = nextSpeed;
            const sVal = document.getElementById('speed-val');
            if (sVal) sVal.innerText = `${nextSpeed.toFixed(1)}x`;
            const qRange = document.getElementById('quick-speed-range');
            if (qRange) qRange.value = nextSpeed;
            const qVal = document.getElementById('quick-speed-val');
            if (qVal) qVal.innerText = `${nextSpeed.toFixed(1)}x`;
        }
        if (window.AudioHapticFX) AudioHapticFX.trigger(10);
        if (window.APP_STATUS) APP_STATUS.toast(`Tốc độ đọc: ${nextSpeed.toFixed(2)}x`, 'info');
    });
}

function updateUI() {
    if (STATE.currentBook) {
        const titleEl = document.getElementById('player-title');
        const authorEl = document.getElementById('player-author');
        const chapterTitle = STATE.currentBook.chapters[STATE.currentChapterIndex].title;

        titleEl.innerText = chapterTitle;
        titleEl.title = chapterTitle;

        authorEl.innerText = STATE.currentBook.title;
        authorEl.title = STATE.currentBook.title;
    }
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

    const sentenceEl = document.getElementById('player-sentence');
    if (sentenceEl) {
        const sentence = chapter.sentences?.[currentIndex];
        const text = typeof sentence === 'string' ? sentence : (sentence?.text || '');
        sentenceEl.innerText = text || 'Chưa có câu đang đọc';
        sentenceEl.title = text;
    }
}

function applySettingsToUI() {
    const s = STATE.settings;
    if (document.getElementById('voice-select')) document.getElementById('voice-select').value = s.voice;

    if (document.getElementById('speed-range')) {
        document.getElementById('speed-range').value = s.speed;
        document.getElementById('speed-val').innerText = `${s.speed}x`;
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
            document.getElementById('prefetch-val').innerText = `${s.numWorkers} Workers`;
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

    if (document.getElementById('font-color-picker')) {
        if (s.textColor !== "default") {
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
        if (audio.paused) audio.play();
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
        if (audio.paused) audio.play();
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
async function switchChapter(targetChapterIndex, startSentenceIndex = 0, autoPlay = true) {
    if (!STATE.currentBook || !Array.isArray(STATE.currentBook.chapters)) return false;
    const chapters = STATE.currentBook.chapters;
    if (targetChapterIndex < 0 || targetChapterIndex >= chapters.length) return false;

    // Chặn click lặp khi đang trong tiến trình chuyển đổi
    if (STATE.isSwitchingChapter) {
        console.warn(`[SwitchChapter] Chapter transition already in progress. Ignoring switch to ${targetChapterIndex}`);
        return false;
    }

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
            return false;
        }

        // 3. Cập nhật TOC UI nếu đang mở
        if (isTOCVisible()) {
            refreshTOCCurrent();
            scrollTOCCurrentChapter();
        }

        // 4. Phát audio chương mới nếu autoPlay được bật
        if (autoPlay) {
            await playFromSentence(startSentenceIndex);
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
        STATE.isSwitchingChapter = false;
        STATE.isTransitioning = false;
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
function updateMediaSession() {
    if ('mediaSession' in navigator && STATE.currentBook) {
        const chapter = STATE.currentBook.chapters[STATE.currentChapterIndex];

        navigator.mediaSession.metadata = new MediaMetadata({
            title: chapter.title,
            artist: STATE.currentBook.title,
            album: `Chapter ${STATE.currentChapterIndex + 1}`,
            artwork: [
                // Same object URL as the library cover; the app icon stays as fallback.
                ...(STATE.coverResolved.get(STATE.currentBookId)?.url
                    ? [{ src: STATE.coverResolved.get(STATE.currentBookId).url, sizes: '512x512', type: 'image/webp' }]
                    : []),
                { src: '/static/icon.svg', sizes: '512x512', type: 'image/svg+xml' },
                { src: 'https://cdn-icons-png.flaticon.com/512/3771/3771417.png', sizes: '512x512', type: 'image/png' }
            ]
        });

        // OS Handlers
        navigator.mediaSession.setActionHandler('play', () => {
            if (audio.paused) togglePlayback();
        });
        navigator.mediaSession.setActionHandler('pause', () => {
            if (!audio.paused) audio.pause();
        });
        navigator.mediaSession.setActionHandler('previoustrack', () => {
            playPrevChapter();
        });
        navigator.mediaSession.setActionHandler('nexttrack', () => {
            playNextChapter();
        });

        // Skip Handlers (10s mapped to Prev/Next Chunk)
        try {
            navigator.mediaSession.setActionHandler('seekbackward', () => {
                playPrevChunk();
            });
            navigator.mediaSession.setActionHandler('seekforward', () => {
                playNextChunk();
            });
        } catch (e) { console.warn("Seek handlers not supported"); }

        // Android/Chrome support for jumping chapters
        try {
            navigator.mediaSession.setActionHandler('stop', () => {
                stopPlaybackSession();
            });
        } catch (e) { }

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

function toggleWakeLock() {
    STATE.wakeLockEnabled = !STATE.wakeLockEnabled;
    localStorage.setItem('wakeLockEnabled', STATE.wakeLockEnabled);
    if (STATE.wakeLockEnabled) {
        requestWakeLock();
    } else {
        releaseWakeLock();
    }
}

// Toggle rows in the reader menu: aria-checked drives the look, the state chip says Bật/Tắt.
function setMenuToggleState(button, pill, isOn) {
    if (button) button.setAttribute('aria-checked', isOn ? 'true' : 'false');
    if (pill) {
        const key = isOn ? 'state-on' : 'state-off';
        pill.dataset.i18n = key;
        pill.textContent = tr(key, isOn ? 'Bật' : 'Tắt');
    }
}

function updateWakeLockUI(isActive) {
    const btn = document.getElementById('wake-lock-btn');
    if (!btn) return;
    btn.title = isActive ? tr('wake-on-title', 'Giữ màn hình sáng: đang bật') : tr('wake-off-title', 'Giữ màn hình sáng: đang tắt');
    setMenuToggleState(btn, document.getElementById('wake-lock-status-pill'), !!isActive);

    const qWake = document.getElementById('quick-wakelock-toggle') || document.getElementById('quick-wakeLockEnabled');
    if (qWake && qWake.checked !== !!isActive) {
        qWake.checked = !!isActive;
    }

    updateReaderMoreActiveDot();
}
window.updateWakeLockUI = updateWakeLockUI;
window.requestWakeLock = requestWakeLock;
window.releaseWakeLock = releaseWakeLock;

// --- Sleep Timer & Manual Save Logic ---
function toggleSleepTimerDropdown() {
    const dropdown = document.getElementById('sleep-timer-dropdown');
    if (!dropdown) return;
    dropdown.classList.toggle('hidden');

    // Close dropdown when clicking outside
    if (!dropdown.classList.contains('hidden')) {
        const closeDropdown = (e) => {
            if (!dropdown.contains(e.target) && !document.getElementById('sleep-timer-btn')?.contains(e.target)) {
                dropdown.classList.add('hidden');
                document.removeEventListener('click', closeDropdown);
            }
        };
        setTimeout(() => document.addEventListener('click', closeDropdown), 10);
    }
}

function setSleepTimerPreset(minutes) {
    const seconds = Math.round(minutes * 60);
    startSleepTimer(seconds);
}

function startSleepTimerFromCustom() {
    const h = parseInt(document.getElementById('sleep-h').value) || 0;
    const m = parseInt(document.getElementById('sleep-m').value) || 0;
    const s = parseInt(document.getElementById('sleep-s').value) || 0;

    const seconds = h * 3600 + m * 60 + s;
    if (seconds <= 0) {
        APP_STATUS.toast("Vui lòng thiết lập thời gian hẹn giờ hợp lệ.", 'warning');
        return;
    }
    startSleepTimer(seconds);
}

function startSleepTimer(seconds) {
    if (STATE.sleepTimer) clearInterval(STATE.sleepTimer);

    STATE.sleepTimerEnd = Date.now() + seconds * 1000;
    updateSleepTimerUI(true, seconds);
    const sleepDropdown = document.getElementById('sleep-timer-dropdown');
    if (sleepDropdown) sleepDropdown.classList.add('hidden');

    STATE.sleepTimer = setInterval(() => {
        const remaining = Math.max(0, Math.round((STATE.sleepTimerEnd - Date.now()) / 1000));
        updateSleepTimerUI(true, remaining);

        if (remaining <= 0) {
            clearInterval(STATE.sleepTimer);
            STATE.sleepTimer = null;
            console.log("Sleep Timer Expired: Stopping Playback and Disconnecting");

            // Action: Stop playback
            audio.pause();
            STATE.isPlaying = false;

            // Action: Disconnect WebSocket to stop backend workers
            closeWebSocketIntentionally();

            // Action: Increment Session ID to invalidate any pending work
            STATE.sessionId++;

            // Action: Clear RAM/ROM
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

            // Action: Disable Wake Lock
            if (STATE.wakeLockEnabled) {
                releaseWakeLock();
                STATE.wakeLockEnabled = false;
                localStorage.setItem('wakeLockEnabled', 'false');
            }

            updateSleepTimerUI(false);
            updateUI();
            document.getElementById('status-indicator').innerText = "Sleep Timer - Disconnected";
        }
    }, 1000);
}

function cancelSleepTimer() {
    if (STATE.sleepTimer) {
        clearInterval(STATE.sleepTimer);
        STATE.sleepTimer = null;
    }
    updateSleepTimerUI(false);
    const sleepDropdown = document.getElementById('sleep-timer-dropdown');
    if (sleepDropdown) sleepDropdown.classList.add('hidden');
}

function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return [h, m, s].map(v => v < 10 ? "0" + v : v).join(":");
}

function updateSleepTimerUI(isActive, seconds = 0) {
    const block = document.querySelector('.sleep-block');
    const badge = document.getElementById('sleep-timer-badge');
    const controls = document.getElementById('sleep-timer-active-controls');
    const remainingText = document.getElementById('sleep-timer-remaining');

    if (block) block.dataset.on = isActive ? 'true' : 'false';
    if (badge) {
        badge.dataset.on = isActive ? 'true' : 'false';
        if (isActive) {
            delete badge.dataset.i18n;
            badge.textContent = seconds > 60 ? `${Math.ceil(seconds / 60)}′` : `${seconds}s`;
        } else {
            badge.dataset.i18n = 'state-off';
            badge.textContent = tr('state-off', 'Tắt');
        }
    }
    if (controls) controls.classList.toggle('hidden', !isActive);
    if (isActive && remainingText) remainingText.textContent = formatTime(seconds);
    updateReaderMoreActiveDot();
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
        APP_STATUS.toast('Đã lưu tiến độ đọc lên đám mây.', 'success');
        setTimeout(() => setSaveState('', 'i-cloud-up'), 2000);
    } catch (e) {
        console.error("Manual save failed:", e);
        APP_STATUS.error(e, 'Không thể lưu tiến độ lên Firestore.');
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
        handlePlaybackStall();
    }
}, 1000);

async function handlePauseTimeout() {
    console.warn("Pause Timeout: 1 minute reached. Saving and Disconnecting...");
    STATE.pauseCount = 0; // Reset to avoid double trigger
    STATE.pauseTimeoutHandled = true;
    let progressSaved = true;

    // 1. Save Progress
    if (STATE.user && STATE.currentBookId) {
        document.getElementById('status-indicator').innerText = "Session Expired...";
        progressSaved = await saveProgress(true);
    }

    // 2. [TASK 3] Disconnect WebSocket ONLY (Preserve Buffer & Cache)
    closeWebSocketIntentionally();

    STATE.isPlaying = false;
    const playBtn = document.getElementById('play-btn');
    if (playBtn) playBtn.innerHTML = '<i class="fas fa-play ml-1"></i>';

    const indicator = document.getElementById('status-indicator');
    if (progressSaved) {
        indicator.innerText = "Session Expired (1m Inactivity)";
        indicator.style.color = "#FFB347";
    } else {
        // enqueueProgressSnapshot has already retained the exact cursor and
        // scheduled its retry. Do not overwrite its visible failure state.
        indicator.innerText = "Chưa lưu tiến độ — đang tự thử lại";
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
        document.getElementById('status-indicator').innerText = "Đang chờ máy chủ TTS...";
        return;
    }
    STATE._stallWaitCount = 0;

    const currentAttempt = (STATE._stallRecoveryCount || 0) + 1;
    STATE._stallRecoveryCount = currentAttempt;

    // [TASK 3] Graduated Recovery Strategy
    if (currentAttempt <= 2) {
        // --- STAGE 1: SOFT RESET (Reconnect & Re-fetch) ---
        console.warn(`[Stall Stage 1] Soft Reset Attempt #${currentAttempt}...`);
        document.getElementById('status-indicator').innerText = `Stalled - Recovering (${currentAttempt})...`;
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

    if (!document.getElementById('status-indicator').innerText.startsWith("Session Expired")) {
        document.getElementById('status-indicator').innerText = "Stalled - RAM/ROM Cleared";
        document.getElementById('status-indicator').style.color = "#FF5252";
    }

    STATE.stallCount = 0;
    STATE.pauseCount = 0;

    const playBtn = document.getElementById('play-btn');
    if (playBtn) playBtn.innerHTML = '<i class="fas fa-play ml-1"></i>';
}

// Expose functions to window for HTML onclick attributes
window.setSleepTimerPreset = setSleepTimerPreset;
window.startSleepTimerFromCustom = startSleepTimerFromCustom;
window.cancelSleepTimer = cancelSleepTimer;

document.getElementById('sleep-timer-btn')?.addEventListener('click', () => toggleSleepTimerDropdown());
document.getElementById('manual-save-btn')?.addEventListener('click', () => triggerManualSave());
document.getElementById('wake-lock-btn')?.addEventListener('click', () => toggleWakeLock());

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

console.log("Cloud TTS Reader Pro Initialized.");

// --- Keyboard Shortcuts ---
// Space       → Play / Pause
// →           → Câu tiếp theo (next sentence)
// ←           → Câu trước (prev sentence)
// Shift + →   → Chương tiếp theo (next chapter)
// Shift + ←   → Chương trước (prev chapter)
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

    } else if (e.code === 'ArrowRight' && e.shiftKey) {
        e.preventDefault();
        await playNextChapter();
    } else if (e.code === 'ArrowLeft' && e.shiftKey) {
        e.preventDefault();
        await playPrevChapter();
    }
});

// --- Service Worker Registration for PWA ---
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/static/sw.js')
            .then(registration => {
                console.log('ServiceWorker registration successful with scope: ', registration.scope);
            })
            .catch(err => {
                console.log('ServiceWorker registration failed: ', err);
            });
    });
}

// --- Edit Chapter Logic ---
let editingChapterIndex = -1;
let editReturnFocus = null;

async function openEditChapterModal(index, triggerBtn = null) {
    if (!STATE.user || !STATE.currentFilename) return;

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

    if (statusIndicator) statusIndicator.innerText = "Fetching raw content...";

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
            textarea.value = data.content;
            modal.classList.remove('hidden');
            textarea.scrollTop = 0;
            textarea.focus({ preventScroll: true });
            if (statusIndicator) statusIndicator.innerText = "Ready";
        } else {
            throw new Error(data.error || "Failed to fetch content");
        }
    } catch (err) {
        console.error("Edit fetch error:", err);
        APP_STATUS.error(`Lỗi tải nội dung: ${err.message}`);
        if (statusIndicator) statusIndicator.innerText = "Error";
    } finally {
        hideLoading();
        if (triggerBtn) {
            triggerBtn.disabled = false;
            triggerBtn.removeAttribute('aria-busy');
        }
    }
}

function closeEditModal() {
    document.getElementById('edit-chapter-modal').classList.add('hidden');
    editingChapterIndex = -1;
    if (editReturnFocus?.isConnected) editReturnFocus.focus({ preventScroll: true });
    editReturnFocus = null;
}

async function saveChapterEdit() {
    if (editingChapterIndex === -1 || !STATE.user || !STATE.currentFilename) return;

    const textarea = document.getElementById('edit-chapter-textarea');
    const newContent = textarea.value;
    const saveBtn = document.getElementById('save-edit-btn');
    const statusIndicator = document.getElementById('status-indicator');

    const originalText = saveBtn.innerText;
    saveBtn.innerText = tr("saving", "Đang lưu…");
    saveBtn.disabled = true;
    if (statusIndicator) statusIndicator.innerText = "Saving changes...";

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
            if (statusIndicator) {
                statusIndicator.innerText = "Changes saved!";
                setTimeout(() => statusIndicator.innerText = "Ready", 3000);
            }
        } else {
            throw new Error(data.error || "Failed to save changes");
        }
    } catch (err) {
        console.error("Save edit error:", err);
        APP_STATUS.error(`Lỗi lưu nội dung: ${err.message}`);
        if (statusIndicator) statusIndicator.innerText = "Error saving";
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

// --- Stats & Offline UI Event Listeners ---
const statsModal = document.getElementById('stats-modal');
const statsToggleBtn = document.getElementById('stats-toggle-btn');
const closeStatsBtn = document.getElementById('close-stats-modal');
const statsOverlay = document.getElementById('stats-modal-overlay');
const clearCacheBtn = document.getElementById('clear-offline-cache');

statsToggleBtn?.addEventListener('click', () => {
    if (statsModal) {
        STATS_MANAGER.load(); // Refresh data from Firebase
        OFFLINE_MANAGER.updateUsageUI();
        statsModal.classList.remove('hidden');
        statsModal.classList.add('flex');
    }
});

const hideStatsModal = () => {
    if (statsModal) {
        statsModal.classList.add('hidden');
        statsModal.classList.remove('flex');
    }
};

closeStatsBtn?.addEventListener('click', hideStatsModal);
statsOverlay?.addEventListener('click', hideStatsModal);

clearCacheBtn?.addEventListener('click', async () => {
    if (confirm('Are you sure you want to clear all offline audio cache?')) {
        await OFFLINE_MANAGER.clearCache();
        APP_STATUS.toast('Đã dọn sạch bộ nhớ cache ngoại tuyến!', 'success');
    }
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

// --- Easter Egg: Crawler Script Copy (5s Hold on Logo) ---
(function () {
    const logoBtn = document.getElementById('logo-btn');
    if (!logoBtn) return;

    let holdTimer;
    const holdDuration = 3000; // 3 seconds

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
                indicator.innerText = "Crawler Script Copied!";

                // Visual feedback on logo
                logoBtn.style.transition = "transform 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275)";
                logoBtn.style.transform = "scale(1.2) rotate(10deg)";

                setTimeout(() => {
                    indicator.innerText = oldText;
                    logoBtn.style.transform = "scale(1) rotate(0deg)";
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
    renderTOC,
    scrollTOCCurrentChapter,
};

// --- Zen Mode Control & Persistence ---
function updateReaderMoreActiveDot() {
    const dot = document.getElementById('reader-more-active-dot');
    if (!dot) return;
    const hasActive = !!(STATE.zenModeEnabled || STATE.wakeLockEnabled || STATE.sleepTimer);
    dot.classList.toggle('hidden', !hasActive);
}
window.updateReaderMoreActiveDot = updateReaderMoreActiveDot;

function setZenMode(enabled, persist = true) {
    STATE.zenModeEnabled = !!enabled;
    document.body.classList.toggle('zen-focus-mode', STATE.zenModeEnabled);
    setMenuToggleState(document.getElementById('zen-mode-toggle-btn'), document.getElementById('zen-mode-status-pill'), STATE.zenModeEnabled);
    const qZenToggle = document.getElementById('quick-zen-mode-toggle');
    if (qZenToggle && qZenToggle.checked !== STATE.zenModeEnabled) {
        qZenToggle.checked = STATE.zenModeEnabled;
    }
    updateReaderMoreActiveDot();
    if (persist) {
        try {
            localStorage.setItem('zen-mode-enabled', STATE.zenModeEnabled ? 'true' : 'false');
        } catch (_) { /* private browsing mode fallback */ }
    }
}
window.setZenMode = setZenMode;

const zenToggleBtn = document.getElementById('zen-mode-toggle-btn');
if (zenToggleBtn) {
    zenToggleBtn.addEventListener('click', () => {
        AudioHapticFX.trigger(12);
        const nextState = !STATE.zenModeEnabled;
        setZenMode(nextState, true);
        APP_STATUS.toast(nextState ? 'Đã bật chế độ tập trung (Zen Mode).' : 'Đã tắt chế độ tập trung (Zen Mode).', 'info');
    });
}

// --- Reader tools menu (⋮) ---
function requireOpenBook() {
    if (STATE.currentBook) return true;
    APP_STATUS.toast(tr('need-open-book', 'Mở một truyện trước đã.'), 'info');
    return false;
}

document.addEventListener('reader-menu-open', () => {
    const hasBook = !!STATE.currentBook;
    ['reader-edit-chapter-btn', 'reader-rename-btn', 'reader-images-btn', 'manual-save-btn'].forEach(id => {
        const item = document.getElementById(id);
        if (item) item.disabled = !hasBook;
    });
    syncReaderTypePanel();
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
document.getElementById('reader-pocket-btn')?.addEventListener('click', () => applyLiteMode(true));

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
    const summary = document.getElementById('reader-type-summary');
    if (summary) summary.textContent = `${size}px`;
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
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closeReaderTypePanel({ restoreFocus: true });
}

function openReaderTypePanel() {
    if (!readerTypePanel || !readerTypePanel.hidden) return;
    readerTypeReturnFocus = document.getElementById('reader-more-menu-btn');
    syncReaderTypePanel();
    readerTypePanel.hidden = false;
    const isSheet = window.matchMedia('(max-width: 639.98px)').matches;
    if (readerTypeScrim) readerTypeScrim.hidden = !isSheet;
    document.addEventListener('pointerdown', onReaderTypeOutside, true);
    document.addEventListener('keydown', onReaderTypeKey, true);
    document.getElementById('reader-type-font')?.focus({ preventScroll: true });
}

function closeReaderTypePanel({ restoreFocus = false } = {}) {
    if (!readerTypePanel || readerTypePanel.hidden) return;
    readerTypePanel.hidden = true;
    if (readerTypeScrim) readerTypeScrim.hidden = true;
    document.removeEventListener('pointerdown', onReaderTypeOutside, true);
    document.removeEventListener('keydown', onReaderTypeKey, true);
    if (restoreFocus && readerTypeReturnFocus?.isConnected) readerTypeReturnFocus.focus({ preventScroll: true });
    readerTypeReturnFocus = null;
}

document.getElementById('reader-type-btn')?.addEventListener('click', () => {
    // Let the menu close first, then open the panel in its place.
    requestAnimationFrame(openReaderTypePanel);
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
    window.QuickSettingsController?.open();
    window.QuickSettingsController?.switchTab?.('appearance');
});
syncReaderTypePanel();

// Apply initial settings to UI on startup
applySettingsToUI();
if (!STATE.currentBookId) {
    toggleDiscoveryMode(true);
}
document.dispatchEvent(new CustomEvent('mpw-bridge-ready'));
