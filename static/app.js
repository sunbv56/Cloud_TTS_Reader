// Firebase Modules
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc, deleteDoc, serverTimestamp, collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { getStorage, ref, uploadBytes, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";

// Firebase placeholders (Initialized via API)
let app, auth, db, storage, provider;

// Keep enough compressed audio for background playback without dispatching
// hundreds of TTS jobs at once. The old 150/500-chunk policy caused large
// network, MSE and server bursts on phones.
const FOREGROUND_PREFETCH_CHUNKS = 40;
const BACKGROUND_PREFETCH_CHUNKS = 80;

// App State
let STATE = {
    user: null,
    currentBook: null,
    currentBookId: null,
    currentFilename: null,
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
        numWorkers: 5,
        fontSize: (function() {
            const saved = localStorage.getItem('reader-font-size');
            if (saved) return parseInt(saved, 10);
            const isAndroid = /Android/i.test(navigator.userAgent);
            return isAndroid ? 10 : 20;
        })(),
        textColor: "default"
    },
    theme: localStorage.getItem('reader-theme') || 'default',
    isTransitioning: false,
    // MSE State
    mediaSource: null,
    sourceBuffer: null,
    appendQueue: [],
    chunkTimings: [], // { index, startTime, duration }
    isAppending: false,
    sessionId: 0,
    lastAppendedIndex: -1,
    lastAppendedChapter: 0,
    isFirstChunkOfSession: false,
    prefetchTimeout: null,
    prefetchBatchStatus: {
        completed: 0,
        total: 0
    },
    wakeLockEnabled: localStorage.getItem('wakeLockEnabled') === 'true',
    wakeLockSentinel: null,
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
    downloadResolve: null,
    downloadReject: null,
    downloadChunkMeta: new Map(), // key -> { chapterIndex, index, text, voice, rate, pitch, volume } for retry
    downloadRetryCount: new Map(), // key -> retry attempt count
    streamingRetryCount: new Map(), // key -> retry attempt count for streaming
    _stallRecoveryCount: 0, // tracking recovery attempts
    tocAutoMinimized: false,
    // Segmentation & Pagination
    isSegmented: false,
    segmentsCount: 0,
    currentSegmentIndex: -1,
    loadedSegments: new Set(), // indices of segments currently in memory
    // Performance Optimization State
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

const DEFAULT_SETTINGS = JSON.parse(JSON.stringify(STATE.settings));

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

    init() {
        this._lastActiveTime = Date.now();
        // Start tracking only when playing
        setInterval(() => this.track(), 10000); // Track every 10s
    },

    async track() {
        const now = Date.now();
        const deltaMs = now - this._lastActiveTime;
        this._lastActiveTime = now;

        if (!STATE.isPlaying || !STATE.user) return;

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
        if (!STATE.user || (STATE.strictSyncMode && !force)) return;
        try {
            const statsRef = doc(db, 'users', STATE.user.uid, 'stats', 'reading');
            await setDoc(statsRef, STATE.stats, { merge: true });
        } catch (err) {
            console.warn('[Stats] Sync failed:', err);
        }
    },

    async load() {
        if (!STATE.user) return;
        try {
            const statsRef = doc(db, 'users', STATE.user.uid, 'stats', 'reading');
            const snap = await getDoc(statsRef);
            if (snap.exists()) {
                STATE.stats = { ...STATE.stats, ...snap.data() };
            }
            this.updateUI();
        } catch (err) {
            console.warn('[Stats] Load failed:', err);
        }
    }
};

// --- Firebase Initialization ---
async function startFirebase() {
    try {
        const response = await fetch('/api/firebase-config');
        const firebaseConfig = await response.json();

        if (!firebaseConfig.apiKey) {
            console.error("Firebase Configuration is missing! Check your environment variables.");
            document.getElementById('status-indicator').innerText = "Config Error";
            return;
        }

        app = initializeApp(firebaseConfig);
        auth = getAuth(app);
        db = getFirestore(app);
        storage = getStorage(app);
        provider = new GoogleAuthProvider();

        // Bind Auth Change
        onAuthStateChanged(auth, async (user) => {
            STATE.user = user;
            const authInfo = document.getElementById('auth-info');
            const authBtn = document.getElementById('auth-btn');
            if (user) {
                authInfo.innerHTML = `<img src="${user.photoURL}" class="w-6 h-6 rounded-full"> ${user.displayName}`;
                authBtn.innerHTML = '<i class="fas fa-sign-out-alt"></i>';
                authBtn.onclick = () => signOut(auth);

                // Fetch recent books from Firestore
                await refreshLibrary();
            } else {
                authInfo.innerHTML = `<span class="text-slate-500">Guest Mode</span>`;
                authBtn.innerHTML = '<i class="fab fa-google"></i>';
                authBtn.onclick = () => signInWithPopup(auth, provider);
                
                // --- Reset UI on Logout ---
                document.getElementById('book-list').innerHTML = '<div class="text-center p-8 text-slate-500 italic text-sm">Login to see your library.</div>';
                
                const discoveryGrid = document.getElementById('discovery-grid');
                if (discoveryGrid) {
                    discoveryGrid.innerHTML = '<div class="col-span-full text-center p-20 text-slate-500 italic">Login to discover your library.</div>';
                }
                
                // Clear any search query
                const discoverySearch = document.getElementById('discovery-search');
                if (discoverySearch) discoverySearch.value = '';
            }
        });

        console.log("Firebase initialized successfully via API");
    } catch (err) {
        console.error("Failed to initialize Firebase:", err);
        setTimeout(startFirebase, 5000); // Retry
    }
}

startFirebase();

// --- Utility Functions ---
function toggleDiscoveryMode(isActive) {
    const discoveryMode = document.getElementById('discovery-mode');
    const readerContainer = document.getElementById('reader-container');
    const sidebarContainer = document.getElementById('sidebar-container');

    if (isActive) {
        // [MiniPlayer] Keep the TTS session alive while the user browses Discovery
        // with an active book — the floating widget takes over playback controls.
        // Opening another book still resets the engine (loadBook calls resetAudioEngine).
        const keepAlive = !!(STATE.currentBook && (STATE.isPlaying || STATE.chunkTimings.length > 0));
        if (!keepAlive) {
            resetAudioEngine();
        }

        if (discoveryMode) discoveryMode.classList.remove('hidden');
        if (sidebarContainer) sidebarContainer.classList.add('hidden');
        if (readerContainer) readerContainer.classList.add('hidden');
        // Homepage không được litemode
        document.body.classList.remove('lite-mode');

        if (window.MiniPlayerWidget) window.MiniPlayerWidget.onDiscoveryEnter(keepAlive);
    } else {
        if (discoveryMode) discoveryMode.classList.add('hidden');
        if (sidebarContainer) sidebarContainer.classList.remove('hidden');
        if (readerContainer) readerContainer.classList.remove('hidden');
        // Restore lite-mode if enabled in settings
        if (STATE.isLiteMode) document.body.classList.add('lite-mode');

        if (window.MiniPlayerWidget) window.MiniPlayerWidget.onDiscoveryExit();
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

const discoverySearch = document.getElementById('discovery-search');
if (discoverySearch) {
    discoverySearch.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        const grid = document.getElementById('discovery-grid');
        if (!grid) return;
        Array.from(grid.children).forEach(card => {
            if (!card.dataset.title) return; // skip placeholders
            if (card.dataset.title.includes(query)) {
                card.style.display = '';
            } else {
                card.style.display = 'none';
            }
        });
    });
}

function removeVietnameseTones(str) {
    str = str.normalize('NFD').replace(/[\u0300-\u036f]/g, "");
    str = str.replace(/[đĐ]/g, m => m === 'đ' ? 'd' : 'D');
    return str;
}

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

// --- Loading Overlay Helpers ---
function showLoading(text = "Processing Masterpiece") {
    const overlay = document.getElementById('global-loading');
    const textEl = document.getElementById('loading-text');
    if (overlay && textEl) {
        textEl.innerText = text;
        overlay.classList.remove('hidden');
        overlay.classList.add('flex');
        // Fade in effect
        setTimeout(() => overlay.classList.remove('opacity-0'), 10);
    }
}

function hideLoading() {
    const overlay = document.getElementById('global-loading');
    if (overlay) {
        overlay.classList.add('opacity-0');
        setTimeout(() => {
            overlay.classList.add('hidden');
            overlay.classList.remove('flex');
        }, 500);
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
    if (document.startViewTransition) {
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

    // 1. Explicitly stop playback and reset clock
    audio.pause();
    audio.currentTime = 0; // Immediate UI reset
    STATE.isPlaying = false;
    STATE.isStalled = false;
    STATE.isTransitioning = true; // Block stall detector during reset

    // 2. Increment Session ID to invalidate all pending WebSocket messages
    STATE.sessionId++;

    // 3. Clear RAM State (Queues & Metadata)
    STATE.appendQueue = [];
    STATE.chunkTimings = [];
    STATE.fetchingSet.clear();
    STATE.metadataQueue = [];
    STATE.downloadBuffer.clear();

    // 4. Reset Session markers
    STATE.lastAppendedIndex = -1;
    STATE.lastAppendedChapter = 0;
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
            await new Promise(resolve => {
                const check = () => {
                    if (!STATE.sourceBuffer.updating) resolve();
                    else setTimeout(check, 30);
                };
                check();
            });

            // Remove all buffered data
            if (STATE.sourceBuffer.buffered.length > 0) {
                const end = STATE.sourceBuffer.buffered.end(STATE.sourceBuffer.buffered.length - 1);
                console.log(`Clearing SourceBuffer: 0 to ${end + 10}s`);
                STATE.sourceBuffer.remove(0, end + 10);

                await new Promise(resolve => {
                    const check = () => {
                        if (!STATE.sourceBuffer.updating) resolve();
                        else setTimeout(check, 30);
                    };
                    check();
                });
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

// Initialize Managers
STATS_MANAGER.init();
OFFLINE_MANAGER.updateUsageUI();

// Constants
const WORKER_STEPS = [1, 2, 3, 5, 10, 20, 50];

// DOM Elements
const audio = document.getElementById('main-audio');
const playBtn = document.getElementById('play-btn');
const textContainer = document.getElementById('text-container');
const fileInput = document.getElementById('file-input');
const bookList = document.getElementById('book-list');

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
function initWebSocket() {
    if (STATE.ws && (STATE.ws.readyState === WebSocket.OPEN || STATE.ws.readyState === WebSocket.CONNECTING)) {
        return; // Don't create multiple connections
    }
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    STATE.ws = new WebSocket(wsUrl);
    const socket = STATE.ws;

    STATE.ws.onopen = () => {
        console.log("Connected to WebSocket");
        document.getElementById('status-indicator').innerText = "Ready";

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

                if (data.type === "PREFETCH_FAILED") {
                    console.error(`Chunk fetch failed: ${data.chapterIndex}-${data.index} - ${data.error || "Unknown"}`);
                    const failKey = `${data.chapterIndex}_${data.index}`;
                    STATE.fetchingSet.delete(failKey);

                    // --- [TASK 2] Streaming Mode Retry Logic ---
                    if (!STATE.isDownloading && STATE.currentBook) {
                        const MAX_RETRIES = 3;
                        const retries = (STATE.streamingRetryCount.get(failKey) || 0) + 1;
                        STATE.streamingRetryCount.set(failKey, retries);

                        if (retries <= MAX_RETRIES) {
                            const delay = retries * 2000;
                            console.warn(`[Streaming] Retrying chunk ${failKey} (attempt ${retries}/${MAX_RETRIES}) in ${delay}ms...`);
                            document.getElementById('status-indicator').innerText = `Retrying chunk... (${retries})`;

                            setTimeout(() => {
                                if (STATE.isDownloading || !STATE.ws || STATE.ws.readyState !== WebSocket.OPEN) return;
                                const chapter = STATE.currentBook.chapters[data.chapterIndex];
                                if (!chapter || !chapter.sentences) return;

                                const text = applySkipDictionary(chapter.sentences[data.index]);
                                const { voice, speed, pitch, volume } = STATE.settings;
                                const rate = `${Math.round((speed - 1) * 100) >= 0 ? '+' : ''}${Math.round((speed - 1) * 100)}%`;

                                STATE.fetchingSet.add(failKey);
                                STATE.ws.send(JSON.stringify({
                                    type: "PREFETCH",
                                    index: data.index,
                                    chapterIndex: data.chapterIndex,
                                    text: text,
                                    voice: voice,
                                    rate: rate,
                                    pitch: pitch,
                                    volume: volume,
                                    numWorkers: STATE.settings.numWorkers,
                                    sessionId: STATE.sessionId
                                }));
                            }, delay);
                            return; // Wait for the retry
                        }
                    }

                    // --- Download Mode Retry Logic ---
                    if (STATE.isDownloading && STATE.downloadChunkMeta.has(failKey)) {
                        const MAX_RETRIES = 3;
                        const retries = (STATE.downloadRetryCount.get(failKey) || 0) + 1;
                        STATE.downloadRetryCount.set(failKey, retries);

                        if (retries <= MAX_RETRIES) {
                            // Retry after a short delay
                            const delay = retries * 1500; // 1.5s, 3s, 4.5s
                            console.warn(`[Download] Retrying chunk ${failKey} (attempt ${retries}/${MAX_RETRIES}) in ${delay}ms...`);

                            // Update status UI
                            const statusEl = document.getElementById('toc-download-status');
                            const received = STATE.downloadBuffer.size;
                            const total = STATE.downloadExpected;
                            if (statusEl) statusEl.innerText = `Retrying failed chunk (${retries}/${MAX_RETRIES})... (${received}/${total})`;

                            setTimeout(() => {
                                if (!STATE.isDownloading) return; // cancelled
                                const meta = STATE.downloadChunkMeta.get(failKey);
                                if (!meta) return;
                                STATE.fetchingSet.add(failKey);
                                STATE.ws.send(JSON.stringify({
                                    type: "PREFETCH",
                                    index: meta.index,
                                    chapterIndex: meta.chapterIndex,
                                    text: meta.text,
                                    voice: meta.voice,
                                    rate: meta.rate,
                                    pitch: meta.pitch,
                                    volume: meta.volume,
                                    numWorkers: STATE.settings.numWorkers,
                                    sessionId: STATE.sessionId
                                }));
                            }, delay);
                        } else {
                            // Max retries exhausted → fail the whole download
                            console.error(`[Download] Chunk ${failKey} failed after ${MAX_RETRIES} retries. Aborting download.`);
                            if (STATE.downloadReject) {
                                STATE.downloadReject(new Error(`Chunk ${failKey} failed after ${MAX_RETRIES} retries. Download aborted.`));
                                STATE.downloadReject = null;
                                STATE.downloadResolve = null;
                            }
                        }
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
            const blob = new Blob([arrayBuffer], { type: 'audio/mpeg' });
            OFFLINE_MANAGER.saveBlob(STATE.currentBookId, currentMetadata.chapterIndex, currentMetadata.index, blob);

            STATE.appendQueue.push({
                index: currentMetadata.index,
                chapterIndex: currentMetadata.chapterIndex,
                sessionId: currentMetadata.sessionId,
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

function processAppendQueue() {
    if (!STATE.sourceBuffer || STATE.sourceBuffer.updating || STATE.appendQueue.length === 0 || STATE.isAppending || STATE.isTransitioning) return;

    // 1. Thay đổi logic sắp xếp: Ưu tiên Chapter trước, rồi mới tới Index
    STATE.appendQueue.sort((a, b) => {
        if (a.chapterIndex !== b.chapterIndex) return a.chapterIndex - b.chapterIndex;
        return a.index - b.index;
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

    // [HOTFIX] Discard any chunks that are older than our expected chunk to prevent queue blocking
    while (STATE.appendQueue.length > 0) {
        const check = STATE.appendQueue[0];
        if (check.chapterIndex < expectedChap || (check.chapterIndex === expectedChap && check.index < expectedIdx)) {
            console.log(`Discarding obsolete/orphaned chunk ${check.chapterIndex}-${check.index} (Expected ${expectedChap}-${expectedIdx})`);
            STATE.appendQueue.shift();
        } else {
            break;
        }
    }

    if (STATE.appendQueue.length === 0) return;

    const chunkToCheck = STATE.appendQueue[0];
    if (chunkToCheck.chapterIndex !== expectedChap || chunkToCheck.index !== expectedIdx) {
        console.log(`Waiting for chunk ${expectedChap}-${expectedIdx} (Queue has ${chunkToCheck.chapterIndex}-${chunkToCheck.index})`);
        return;
    }

    STATE.isAppending = true;
    const chunk = STATE.appendQueue.shift();

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

        STATE.chunkTimings.push({
            index: chunk.index,
            chapterIndex: chunk.chapterIndex,
            startTime: startTime,
            metadata: chunk.metadata
        });

        STATE.sourceBuffer.timestampOffset = startTime;
        STATE.sourceBuffer.appendBuffer(chunk.data);
        STATE.lastAppendedIndex = chunk.index;
        STATE.lastAppendedChapter = chunk.chapterIndex;
        console.log(`Appended chunk ${chunk.index} (bytes: ${chunk.data.byteLength}) at ${startTime.toFixed(2)}s. Current audio time: ${audio.currentTime.toFixed(2)}s`);
    } catch (e) {
        console.error("Append error:", e);
        STATE.isAppending = false;
    }
}

initWebSocket();
initMSE();

// --- Firebase Sync Helpers ---
async function uploadToStorage(file) {
    if (!STATE.user) return;
    try {
        const fileRef = ref(storage, `users/${STATE.user.uid}/files/${file.name}`);
        const snapshot = await uploadBytes(fileRef, file);
        console.log("File uploaded to Storage:", snapshot.metadata.fullPath);
        return snapshot;
    } catch (err) {
        console.error("Storage Error:", err);
    }
}

async function saveProgress(force = false) {
    if (!STATE.user || !STATE.currentBookId) return;

    const currentGlobalIndex = getGlobalIndex(STATE.currentChapterIndex, STATE.currentSentenceIndex);

    // Batching: only save if forced OR distance >= 10 OR first time registration
    const isFirstSave = STATE.lastSavedChunkIndex === -1;
    if (!force && !isFirstSave && Math.abs(currentGlobalIndex - STATE.lastSavedChunkIndex) < 10) {
        console.log(`Skipping Firestore sync (Batching): Current ${currentGlobalIndex}, Last Saved ${STATE.lastSavedChunkIndex}`);
        return;
    }

    try {
        const progressRef = doc(db, "users", STATE.user.uid, "progress", STATE.currentBookId);
        const { theme, fontSize, ...persistedSettings } = STATE.settings;
        await setDoc(progressRef, {
            title: STATE.currentBook.title,
            filename: STATE.currentFilename,
            last_read_chunk: currentGlobalIndex,
            total_chunks: getTotalChunks(),
            settings: persistedSettings, // Save current settings (excluding global theme and device font size)
            updated_at: serverTimestamp()
        }, { merge: true });

        STATE.lastSavedChunkIndex = currentGlobalIndex;
        console.log(`Progress synced to Firestore (v2) at chunk ${currentGlobalIndex}`);
    } catch (err) {
        console.error("Firestore Error:", err);
    }
}

async function loadProgress(bookId) {
    if (!STATE.user) return null;
    try {
        const progressRef = doc(db, "users", STATE.user.uid, "progress", bookId);
        const docSnap = await getDoc(progressRef);
        if (docSnap.exists()) {
            return docSnap.data();
        }
    } catch (err) {
        console.error("Load Progress Error:", err);
    }
    return null;
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
    let remaining = globalIdx;
    for (let i = 0; i < STATE.currentBook.chapters.length; i++) {
        const chap = STATE.currentBook.chapters[i];
        const len = (counts && counts[i] !== undefined)
            ? counts[i]
            : (chap ? (chap.count || (chap.sentences && chap.sentences.length) || 0) : 0);
        if (remaining < len) {
            return { chapterIndex: i, sentenceIndex: remaining };
        }
        remaining -= len;
    }
    return { chapterIndex: 0, sentenceIndex: 0 };
}

async function refreshLibrary() {
    if (!STATE.user) return;
    const bookList = document.getElementById('book-list');
    const discoveryGrid = document.getElementById('discovery-grid');

    bookList.innerHTML = '<div class="text-center p-4 text-primary animate-pulse text-xs uppercase font-bold tracking-widest">Updating Library...</div>';
    if (discoveryGrid) discoveryGrid.innerHTML = '';

    try {
        const q = query(collection(db, "users", STATE.user.uid, "progress"));
        const querySnapshot = await getDocs(q);
        bookList.innerHTML = '';

        if (querySnapshot.empty) {
            bookList.innerHTML = '<div class="text-center p-8 text-slate-500 italic text-sm">No books loaded. Upload a .txt file!</div>';
            if (discoveryGrid) {
                discoveryGrid.innerHTML = '<div class="col-span-full flex flex-col items-center justify-center p-12 text-slate-500 italic bg-surface-low rounded-2xl border border-white/5"><i class="fas fa-book-open text-4xl mb-4 opacity-50"></i><span>No recent reads found.</span></div>';
            }
            if (!STATE.currentBookId) toggleDiscoveryMode(true);
            return;
        }

        if (!STATE.currentBookId) toggleDiscoveryMode(true);

        querySnapshot.forEach((docSnap) => {
            const data = docSnap.data();
            const bookId = docSnap.id;
            const rawProgress = data.total_chunks > 0
                ? (data.last_read_chunk / data.total_chunks * 100)
                : 0;
            const progress = rawProgress.toFixed(1);
            const filename = data.filename || (bookId.replace('book_', '') + '.txt');

            // ── Sidebar Book List Card ───────────────────────────────────────
            const wrapper = document.createElement('div');
            wrapper.className = 'relative group/item';

            const div = document.createElement('div');
            const isActive = bookId === STATE.currentBookId;
            div.dataset.bookId = bookId;
            div.className = `glass p-3 pr-9 flex flex-col gap-1 cursor-pointer hover:bg-primary/5 transition-all group border-l-2 rounded-lg ${isActive ? 'book-active' : 'border-transparent hover:border-primary'}`;
            div.innerHTML = `
                <div class="flex items-center justify-between gap-2">
                    <span class="text-sm font-bold ${isActive ? 'text-primary' : 'text-white'} group-hover:text-primary transition-colors line-clamp-1 flex-1 min-w-0" title="${data.title}">
                        ${isActive ? '<i class="fas fa-headphones-alt mr-2 text-[10px] animate-pulse"></i>' : ''}${data.title}
                    </span>
                    <span class="text-[10px] text-primary font-mono shrink-0">${progress}%</span>
                </div>
                <div class="w-full bg-slate-800 h-1 rounded-full overflow-hidden">
                    <div class="bg-primary h-full transition-all duration-500" style="width: ${progress}%"></div>
                </div>
            `;
            div.onclick = () => loadBookFromStorage(bookId, data);

            // ── Hidden file input for merge ────────────────────────────────────
            const mergeInput = document.createElement('input');
            mergeInput.type = 'file';
            mergeInput.accept = '.txt';
            mergeInput.className = 'hidden';
            mergeInput.id = `merge-input-${bookId}`;
            mergeInput.onchange = (e) => mergeChapterFile(e, bookId, data);
            mergeInput.onclick = (e) => e.stopPropagation(); // Stop bubble when triggered by .click()

            // ── Kebab (⋮) button ──────────────────────────────────────────────
            const kebabBtn = document.createElement('button');
            kebabBtn.className = 'absolute top-1/2 -translate-y-1/2 right-1.5 w-7 h-7 rounded-lg flex items-center justify-center text-slate-500 hover:text-primary hover:bg-white/10 transition-all opacity-0 group-hover/item:opacity-100 z-10';
            kebabBtn.title = 'Tùy chọn';
            kebabBtn.innerHTML = '<i class="fas fa-ellipsis-v text-xs"></i>';
            kebabBtn.onclick = (e) => {
                e.stopPropagation();
                toggleKebabMenu(bookId);
            };

            // ── Dropdown menu ─────────────────────────────────────────────────
            const dropdown = document.createElement('div');
            dropdown.id = `kebab-menu-${bookId}`;
            dropdown.className = 'hidden absolute right-0 top-full mt-1 w-44 bg-surface-high/95 backdrop-blur-xl border border-white/10 rounded-xl shadow-2xl z-50 overflow-hidden py-1';
            dropdown.onclick = (e) => e.stopPropagation();

            const mergeBtn = document.createElement('button');
            mergeBtn.className = 'w-full text-left px-4 py-2.5 text-sm flex items-center gap-3 hover:bg-primary/10 hover:text-primary transition-colors text-slate-300';
            mergeBtn.innerHTML = '<i class="fas fa-file-import w-4 text-center"></i> Nối chương';
            mergeBtn.onclick = (e) => {
                e.stopPropagation();
                toggleKebabMenu(bookId);
                document.getElementById(`merge-input-${bookId}`).click();
            };

            const downloadTextBtn = document.createElement('button');
            downloadTextBtn.className = 'w-full text-left px-4 py-2.5 text-sm flex items-center gap-3 hover:bg-primary/10 hover:text-primary transition-colors text-slate-300';
            downloadTextBtn.innerHTML = '<i class="fas fa-file-download w-4 text-center"></i> Tải file TXT';
            downloadTextBtn.onclick = (e) => {
                e.stopPropagation();
                toggleKebabMenu(bookId);
                downloadTextBook(bookId, data.title);
            };

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'w-full text-left px-4 py-2.5 text-sm flex items-center gap-3 hover:bg-red-500/10 hover:text-red-400 transition-colors text-slate-300';
            deleteBtn.innerHTML = '<i class="fas fa-trash-alt w-4 text-center"></i> Xóa truyện';
            deleteBtn.onclick = (e) => {
                e.stopPropagation();
                deleteBook(bookId, filename, data.title);
            };

            dropdown.appendChild(mergeBtn);
            dropdown.appendChild(downloadTextBtn);
            dropdown.appendChild(deleteBtn);

            wrapper.appendChild(div);
            wrapper.appendChild(mergeInput);
            wrapper.appendChild(kebabBtn);
            wrapper.appendChild(dropdown);
            bookList.appendChild(wrapper);

            // ── Discovery Grid Card ───────────────────────────────────────────
            if (discoveryGrid) {
                const discCard = document.createElement('div');
                const isActive = bookId === STATE.currentBookId;
                discCard.dataset.bookId = bookId;
                discCard.className = `glass p-6 rounded-3xl flex flex-col gap-4 cursor-pointer hover:-translate-y-1 hover:shadow-lg hover:shadow-primary/10 transition-all border group relative ${isActive ? 'border-primary bg-primary/10 ring-2 ring-primary/20 shadow-2xl shadow-primary/20' : 'border-white/5 border-t-white/10'}`;
                discCard.dataset.title = removeVietnameseTones(data.title.toLowerCase()) + " " + data.title.toLowerCase();

                // ── Hidden file input for merge ────────────────────────────────────
                const mergeInput = document.createElement('input');
                mergeInput.type = 'file';
                mergeInput.accept = '.txt';
                mergeInput.className = 'hidden';
                mergeInput.id = `merge-input-discovery-${bookId}`;
                mergeInput.onchange = (e) => mergeChapterFile(e, bookId, data);
                mergeInput.onclick = (e) => e.stopPropagation(); // Stop bubble when triggered by .click()

                // ── Kebab (⋮) button ──────────────────────────────────────────────
                const kebabBtn = document.createElement('button');
                kebabBtn.className = 'absolute top-4 right-4 w-10 h-10 rounded-xl flex items-center justify-center text-slate-500 hover:text-primary hover:bg-white/10 transition-all z-20';
                kebabBtn.title = 'Tùy chọn';
                kebabBtn.innerHTML = '<i class="fas fa-ellipsis-v text-sm"></i>';
                kebabBtn.onclick = (e) => {
                    e.stopPropagation();
                    toggleKebabMenu(bookId, true);
                };

                // ── Dropdown menu ─────────────────────────────────────────────────
                const dropdown = document.createElement('div');
                dropdown.id = `discovery-kebab-menu-${bookId}`;
                dropdown.className = 'hidden absolute right-4 top-16 w-48 bg-surface-high/95 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl z-50 overflow-hidden py-1';
                dropdown.onclick = (e) => e.stopPropagation();

                const mergeBtn = document.createElement('button');
                mergeBtn.className = 'w-full text-left px-5 py-3 text-sm flex items-center gap-3 hover:bg-primary/10 hover:text-primary transition-colors text-slate-300 font-bold';
                mergeBtn.innerHTML = '<i class="fas fa-file-import w-4 text-center"></i> Nối chương';
                mergeBtn.onclick = (e) => {
                    e.stopPropagation();
                    toggleKebabMenu(bookId, true);
                    document.getElementById(`merge-input-discovery-${bookId}`).click();
                };

                const downloadTextBtn = document.createElement('button');
                downloadTextBtn.className = 'w-full text-left px-5 py-3 text-sm flex items-center gap-3 hover:bg-primary/10 hover:text-primary transition-colors text-slate-300 font-bold';
                downloadTextBtn.innerHTML = '<i class="fas fa-file-download w-4 text-center"></i> Tải file TXT';
                downloadTextBtn.onclick = (e) => {
                    e.stopPropagation();
                    toggleKebabMenu(bookId, true);
                    downloadTextBook(bookId, data.title);
                };

                const deleteBtn = document.createElement('button');
                deleteBtn.className = 'w-full text-left px-5 py-3 text-sm flex items-center gap-3 hover:bg-red-500/10 hover:text-red-400 transition-colors text-slate-300 font-bold';
                deleteBtn.innerHTML = '<i class="fas fa-trash-alt w-4 text-center"></i> Xóa truyện';
                deleteBtn.onclick = (e) => {
                    e.stopPropagation();
                    deleteBook(bookId, filename, data.title);
                };

                dropdown.appendChild(mergeBtn);
                dropdown.appendChild(downloadTextBtn);
                dropdown.appendChild(deleteBtn);

                discCard.innerHTML = `
                    <div class="absolute inset-0 bg-primary/0 group-hover:bg-primary/5 transition-colors duration-500"></div>
                    <div class="flex items-center gap-4 relative z-10">
                        <div class="w-12 h-12 rounded-xl ${isActive ? 'bg-primary text-black shadow-lg shadow-primary/30' : 'bg-white/5 border border-white/10 text-primary'} flex items-center justify-center shrink-0">
                            <i class="fas ${isActive ? 'fa-volume-up' : 'fa-book'} text-xl"></i>
                        </div>
                        <div class="flex-1 min-w-0 pr-8">
                            <h3 class="${isActive ? 'text-primary' : 'text-white'} font-bold truncate group-hover:text-primary transition-colors" title="${data.title}">${data.title}</h3>
                            <div class="text-xs ${isActive ? 'text-primary/70' : 'text-slate-400'} flex items-center gap-2 mt-1">
                                <i class="fas ${isActive ? 'fa-play' : 'fa-bookmark'} text-[10px]"></i> ${isActive ? 'Currently Reading' : 'Continue Reading'}
                            </div>
                        </div>
                    </div>
                    
                    <div class="mt-auto relative z-10">
                        <div class="flex justify-between items-center text-xs font-mono font-bold mb-2">
                            <span class="text-slate-400">PROGRESS</span>
                            <span class="text-primary">${progress}%</span>
                        </div>
                        <div class="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
                            <div class="bg-gradient-to-r from-primary/50 to-primary h-full transition-all duration-500" style="width: ${progress}%"></div>
                        </div>
                    </div>
                `;
                discCard.onclick = () => loadBookFromStorage(bookId, data);

                discCard.appendChild(mergeInput);
                discCard.appendChild(kebabBtn);
                discCard.appendChild(dropdown);

                discoveryGrid.appendChild(discCard);
            }
        });
    } catch (err) {
        console.error("Library Refresh Error:", err);
        bookList.innerHTML = '<div class="text-center p-8 text-red-400 italic text-sm">Error updating library.</div>';
        if (discoveryGrid) discoveryGrid.innerHTML = '<div class="text-center p-8 text-red-400 italic">Error loading recent reads.</div>';
    }
}

/** Download the canonical source TXT for a book. The backend handles master
 * files and segmented-book reconstruction so the browser never assembles JSON
 * segments in memory. */
async function downloadTextBook(bookId, title = 'book') {
    if (!STATE.user || !bookId) {
        alert('Please login first to download books.');
        return;
    }

    const status = document.getElementById('status-indicator');
    const previousStatus = status?.innerText || 'Ready';
    if (status) status.innerText = 'Preparing TXT...';

    try {
        const token = await STATE.user.getIdToken();
        const response = await fetch(`/api/stories/${encodeURIComponent(STATE.user.uid)}/${encodeURIComponent(bookId)}/export-text`, {
            headers: { Authorization: `Bearer ${token}` }
        });

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
    } catch (err) {
        console.error('[Export TXT]', err);
        alert(`Không thể tải file TXT: ${err.message}`);
        if (status) status.innerText = 'TXT download failed';
    } finally {
        setTimeout(() => {
            if (status && (status.innerText === 'TXT download started' || status.innerText === 'TXT download failed')) {
                status.innerText = previousStatus || 'Ready';
            }
        }, 2500);
    }
}

// ── Kebab Menu Helpers ───────────────────────────────────────────────────────

/**
 * Toggles a kebab dropdown menu. Closes all other open menus first.
 */
function toggleKebabMenu(bookId, isDiscovery = false) {
    const prefix = isDiscovery ? 'discovery-kebab-menu-' : 'kebab-menu-';
    const targetId = prefix + bookId;

    // Hide ALL open menus (sidebar and discovery)
    document.querySelectorAll('[id*="kebab-menu-"]').forEach(menu => {
        if (menu.id !== targetId) menu.classList.add('hidden');
    });

    const menu = document.getElementById(targetId);
    if (menu) menu.classList.toggle('hidden');
}

// Close all kebab menus when clicking anywhere outside
document.addEventListener('click', () => {
    document.querySelectorAll('[id*="kebab-menu-"]').forEach(menu => menu.classList.add('hidden'));
});

// ── Feature 1: Delete Book ───────────────────────────────────────────────────

/**
 * Deletes a book's Firestore document AND Storage file in parallel.
 * Gracefully handles the case where the Storage file doesn't exist.
 */
async function deleteBook(bookId, filename, title, bypassConfirm = false) {
    toggleKebabMenu(bookId); // close menu first

    if (!bypassConfirm && !confirm(`Xóa truyện "${title}"?\n\nHành động này sẽ xóa vĩnh viễn dữ liệu trên Cloud. Không thể hoàn tác!`)) return;
    if (!STATE.user) return;

    document.getElementById('status-indicator').innerText = 'Đang xóa...';

    try {
        // ── 1. Firestore delete ──────────────────────────────────────────────
        const deleteFirestore = deleteDoc(doc(db, 'users', STATE.user.uid, 'progress', bookId));

        // ── 2. Storage delete (ignore "not found" gracefully) ────────────────
        let deleteStorage = Promise.resolve();
        if (filename) {
            const fileRef = ref(storage, `users/${STATE.user.uid}/files/${filename}`);
            deleteStorage = deleteObject(fileRef).catch(err => {
                if (err.code === 'storage/object-not-found') {
                    console.warn('[Delete] Storage file not found, skipping:', filename);
                } else {
                    throw err; // re-throw unexpected errors
                }
            });
        }

        // ── 3. Run both in PARALLEL ──────────────────────────────────────────
        await Promise.all([deleteFirestore, deleteStorage]);
        console.log(`[Delete] "${title}" deleted successfully.`);

        // ── 4. If the deleted book is currently open, reset the reader ────────
        if (STATE.currentBookId === bookId) {
            await handlePlaybackStall(); // This handles WS close, RAM/ROM clear, and UI reset
            STATE.currentBook = null;
            STATE.currentBookId = null;
            STATE.currentFilename = null;
            STATE.currentChapterIndex = 0;
            STATE.currentSentenceIndex = 0;
            document.getElementById('current-title').innerText = 'Select a Masterpiece';
            document.getElementById('current-chapter').innerText = 'Standby Mode';
            document.getElementById('text-container').innerHTML = '';
            document.getElementById('edit-title-btn').classList.add('hidden');
            updateUI();
            toggleDiscoveryMode(true);
        }

        // ── 5. Refresh library sidebar ────────────────────────────────────────
        await refreshLibrary();
        document.getElementById('status-indicator').innerText = 'Đã xóa!';
        setTimeout(() => document.getElementById('status-indicator').innerText = 'Ready', 2500);

    } catch (err) {
        console.error('[Delete] Error:', err);
        alert(`Xóa thất bại: ${err.message}`);
        document.getElementById('status-indicator').innerText = 'Error';
        setTimeout(() => document.getElementById('status-indicator').innerText = 'Ready', 3000);
    }
}

// ── Feature 2: Merge Chapter File ────────────────────────────────────────────

/**
 * Appends the content of a new .txt file to the existing book file on Storage.
 * Uses TextEncoder to guarantee UTF-8 encoding and preserve Vietnamese characters.
 */
async function mergeChapterFile(event, bookId, bookData) {
    const newFile = event.target.files[0];
    event.target.value = ''; // reset so same file can be picked again later
    if (!newFile || !STATE.user) return;

    const filename = bookData.filename || (bookId.replace('book_', '') + '.txt');
    document.getElementById('status-indicator').innerText = 'Đang nối chương (Server)...';

    try {
        // ── 1. Gửi tệp mới lên server để xử lý nối và phân tách ────────────────
        const formData = new FormData();
        formData.append('userId', STATE.user.uid);
        formData.append('bookId', bookId);
        formData.append('filename', filename);
        formData.append('file', newFile);

        const response = await fetch('/api/append-chapter', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Server error (${response.status}): ${errorText}`);
        }

        const newBookData = await response.json();

        // Calculate total chunks from metadata chapters
        const newTotalChunks = newBookData.chapters.reduce((sum, ch) => sum + (ch.count || 0), 0);

        // ── 2. Cập nhật total_chunks trong Firestore ──────────────────────────
        const progressRef = doc(db, 'users', STATE.user.uid, 'progress', bookId);
        await setDoc(progressRef, { total_chunks: newTotalChunks }, { merge: true });

        console.log(`[Merge] Success! total_chunks updated to ${newTotalChunks}`);
        document.getElementById('status-indicator').innerText = 'Nối chương thành công!';
        alert(`✅ Đã nối chương thành công!\nFile: ${filename}\nTổng chunks mới: ${newTotalChunks}`);

        // ── 3. Nếu sách này đang mở, tải lại dữ liệu mới ──────────────────────
        if (STATE.currentBookId === bookId) {
            await loadBook(newBookData, bookId, filename);
        }

        // ── 4. Cập nhật lại giao diện danh sách truyện ────────────────────────
        await refreshLibrary();

        setTimeout(() => document.getElementById('status-indicator').innerText = 'Ready', 3000);

    } catch (err) {
        console.error('[Merge] Error:', err);
        alert(`Nối chương thất bại: ${err.message}`);
        document.getElementById('status-indicator').innerText = 'Error';
        setTimeout(() => document.getElementById('status-indicator').innerText = 'Ready', 3000);
    }
}

async function loadBookFromStorage(bookId, bookData) {
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
        const storySnap = await getDoc(storyRef);

        let bookInfo = null;
        if (storySnap.exists()) {
            bookInfo = storySnap.data();
            console.log("Found segmented story info:", bookInfo);
        }

        if (bookInfo && bookInfo.isSegmented) {
            // Segmented Load Flow
            await loadBook(bookInfo, bookId, bookInfo.filename);
        } else {
            // Traditional Load Flow
            const filename = bookData.filename || (bookId.replace("book_", "") + ".txt");
            const fileRef = ref(storage, `users/${STATE.user.uid}/files/${filename}`);
            const url = await getDownloadURL(fileRef);

            const response = await fetch(url);
            const blob = await response.blob();
            const file = new File([blob], filename, { type: "text/plain" });

            const formData = new FormData();
            formData.append('file', file);

            const parseRes = await fetch('/api/parse-book', { method: 'POST', body: formData });
            const data = await parseRes.json();

            STATE.currentBookId = bookId;
            updateLibraryHighlight();

            await loadBook(data, bookId, filename);
        }
        document.getElementById('status-indicator').innerText = "Ready";
        saveProgress(true);
    } catch (err) {
        console.error("Load from Storage Error:", err);
        alert("Failed to load book from storage. Make sure the file still exists.");
    } finally {
        hideLoading();
    }
}

// --- Auth state is now handled inside startFirebase() ---

// --- File Handling ---
const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith('.txt')) {
        alert('Chỉ hỗ trợ file .txt.');
        e.target.value = '';
        return;
    }
    if (file.size === 0) {
        alert('File đang trống. Vui lòng chọn file có nội dung.');
        e.target.value = '';
        return;
    }
    if (file.size > 100 * 1024 * 1024) {
        alert('File vượt quá giới hạn 100 MB. Hãy chia nhỏ nội dung trước khi tải lên.');
        e.target.value = '';
        return;
    }

    if (!STATE.user) {
        alert("Please login first to upload books.");
        return;
    }

    showLoading("Uploading & Partitioning " + file.name + "...");
    const formData = new FormData();
    formData.append('userId', STATE.user.uid);
    formData.append('file', file);

    document.getElementById('status-indicator').innerText = "Processing Story...";
    try {
        // Give the user a useful preview without reading a large file into memory:
        // inspect only the first 4 MB for chapter separators.
        const preview = await file.slice(0, 4 * 1024 * 1024).text();
        const separatorCount = (preview.match(/^\s*={3,}\s*$/gm) || []).length;
        if (separatorCount === 0 && !confirm('Không tìm thấy dòng === để phân cách chương. File sẽ được nhập thành một chương. Tiếp tục?')) {
            hideLoading();
            return;
        }
        const estimatedChapters = separatorCount + 1;
        document.getElementById('status-indicator').innerText = `Found ~${estimatedChapters} chapters. Preparing...`;
        const response = await fetch('/api/upload-story', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) throw new Error("Upload failed");
        const data = await response.json();

        // Fetch fresh metadata
        const metaRes = await fetch(`/api/stories/${STATE.user.uid}/${data.storyId}/metadata`);
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

        // --- FIX BUG 6: Await loadBook and call refreshLibrary directly ---
        await loadBook(bookInfo, data.storyId, file.name);
        await refreshLibrary();
    } catch (err) {
        console.error(err);
        alert("Error uploading story: " + err.message);
    } finally {
        hideLoading();
    }
};

fileInput.onchange = handleFileUpload;
const discoveryFileInput = document.getElementById('discovery-file-input');
if (discoveryFileInput) discoveryFileInput.onchange = handleFileUpload;

/**
 * Sets up drag and drop functionality for the upload zone.
 */
function setupDragAndDrop() {
    const dropZone = document.getElementById('discovery-drop-zone');
    if (!dropZone) return;

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
        }, false);
    });

    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => {
            dropZone.classList.add('drag-over');
        }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => {
            dropZone.classList.remove('drag-over');
        }, false);
    });

    dropZone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        if (files && files.length > 0) {
            handleFileUpload({ target: { files: files } });
        }
    }, false);
}

setupDragAndDrop();

async function loadBook(bookData, bookId, filename) {
    // 0. Robust Engine Reset
    await resetAudioEngine();

    toggleSidebar(false);
    toggleDiscoveryMode(false);

    await OFFLINE_MANAGER.clearCache();

    const currentUI = {
        fontSize: STATE.settings.fontSize,
        textColor: STATE.settings.textColor
    };

    STATE.settings = { ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), ...currentUI };

    // Segmentation Logic
    STATE.isSegmented = bookData.isSegmented || false;
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

    // Check for existing progress
    const progress = await loadProgress(STATE.currentBookId);
    if (progress && progress.last_read_chunk !== undefined) {
        if (progress.title) STATE.currentBook.title = progress.title;
        if (progress.filename) STATE.currentFilename = progress.filename;

        const totalChunks = bookData.totalChapters ? 999999 : getTotalChunks(); // Hack for segmented jump
        const indices = getLocalIndices(progress.last_read_chunk);
        STATE.currentChapterIndex = indices.chapterIndex;
        STATE.currentSentenceIndex = indices.sentenceIndex;
        STATE.lastSavedChunkIndex = progress.last_read_chunk;

        if (progress.settings) {
            const { theme, fontSize, ...bookSettings } = progress.settings;
            STATE.settings = { ...STATE.settings, ...bookSettings };
        }
    } else {
        STATE.currentChapterIndex = 0;
        STATE.currentSentenceIndex = 0;
        STATE.lastSavedChunkIndex = -1;
    }

    // If segmented, we MUST load the segment containing currentChapterIndex
    if (STATE.isSegmented) {
        const segIdx = Math.floor(STATE.currentChapterIndex / 100);
        await fetchSegment(segIdx);
    }

    applySettingsToUI();

    const currentTitleEl = document.getElementById('current-title');
    currentTitleEl.innerText = STATE.currentBook.title;
    currentTitleEl.title = STATE.currentBook.title;
    document.getElementById('edit-title-btn').classList.remove('hidden');

    await renderChapter(STATE.currentChapterIndex);
    renderTOC();
    updateUI();

    if (progress) {
        highlightSentence(STATE.currentSentenceIndex);
    }

    // --- FIX BUG 3: Await progress save to ensure Firestore is consistent before UI refresh ---
    await saveProgress(true);
    playFromSentence(STATE.currentSentenceIndex);
    updateLibraryHighlight();
}

async function fetchSegment(segmentIndex) {
    if (STATE.loadedSegments.has(segmentIndex)) return;

    console.log(`[Segmentation] Fetching segment ${segmentIndex}...`);
    try {
        const res = await fetch(`/api/stories/${STATE.user.uid}/${STATE.currentBookId}/segments/${segmentIndex}?t=${Date.now()}`);
        const data = await res.json();

        // Update chapters in currentBook
        const startOffset = segmentIndex * 100;
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
    } catch (err) {
        console.error("Failed to fetch segment:", err);
    }
}

/**
 * Updates the highlighting for books in the sidebar and discovery grid
 * based on the currently open book ID.
 */
function updateLibraryHighlight() {
    if (!STATE.currentBookId) return;

    // Update Sidebar Book List
    const bookListItems = document.querySelectorAll('#book-list [data-book-id]');
    bookListItems.forEach(item => {
        const isActive = item.dataset.bookId === STATE.currentBookId;
        const titleSpan = item.querySelector('span');

        if (isActive) {
            item.classList.add('book-active');
            item.classList.remove('border-transparent');
            if (titleSpan) {
                titleSpan.classList.add('text-primary');
                titleSpan.classList.remove('text-white');
                if (!titleSpan.querySelector('.fa-headphones-alt')) {
                    titleSpan.innerHTML = `<i class="fas fa-headphones-alt mr-2 text-[10px] animate-pulse"></i>${titleSpan.textContent}`;
                }
            }
        } else {
            item.classList.remove('book-active');
            item.classList.add('border-transparent');
            if (titleSpan) {
                titleSpan.classList.remove('text-primary');
                titleSpan.classList.add('text-white');
                const icon = titleSpan.querySelector('.fa-headphones-alt');
                if (icon) icon.remove();
            }
        }
    });

    // Update Discovery Grid
    const discoveryCards = document.querySelectorAll('#discovery-grid [data-book-id]');
    discoveryCards.forEach(card => {
        const isActive = card.dataset.bookId === STATE.currentBookId;
        const titleH3 = card.querySelector('h3');
        const iconDiv = card.querySelector('.shrink-0');
        const statusDiv = card.querySelector('.text-xs');

        if (isActive) {
            card.className = `glass p-6 rounded-3xl flex flex-col gap-4 cursor-pointer hover:-translate-y-1 hover:shadow-lg hover:shadow-primary/10 transition-all border border-primary bg-primary/10 ring-2 ring-primary/20 shadow-2xl shadow-primary/20 group relative overflow-hidden`;
            if (titleH3) {
                titleH3.classList.add('text-primary');
                titleH3.classList.remove('text-white');
            }
            if (iconDiv) {
                iconDiv.className = `w-12 h-12 rounded-xl bg-primary text-black shadow-lg shadow-primary/30 flex items-center justify-center shrink-0`;
                iconDiv.innerHTML = '<i class="fas fa-volume-up text-xl"></i>';
            }
            if (statusDiv) {
                statusDiv.className = `text-xs text-primary/70 flex items-center gap-2 mt-1`;
                statusDiv.innerHTML = '<i class="fas fa-play text-[10px]"></i> Currently Reading';
            }
        } else {
            card.className = `glass p-6 rounded-3xl flex flex-col gap-4 cursor-pointer hover:-translate-y-1 hover:shadow-lg hover:shadow-primary/10 transition-all border border-white/5 border-t-white/10 group relative overflow-hidden`;
            if (titleH3) {
                titleH3.classList.remove('text-primary');
                titleH3.classList.add('text-white');
            }
            if (iconDiv) {
                iconDiv.className = `w-12 h-12 rounded-xl bg-white/5 border border-white/10 text-primary flex items-center justify-center shrink-0`;
                iconDiv.innerHTML = '<i class="fas fa-book text-xl"></i>';
            }
            if (statusDiv) {
                statusDiv.className = `text-xs text-slate-400 flex items-center gap-2 mt-1`;
                statusDiv.innerHTML = '<i class="fas fa-bookmark text-[10px]"></i> Continue Reading';
            }
        }
    });
}

async function fetchChapterSentences(index) {
    if (!STATE.user || !STATE.currentFilename) return;

    // If segmented, we should already have sentences from fetchSegment
    if (STATE.isSegmented) {
        const segIdx = Math.floor(index / 100);
        if (!STATE.loadedSegments.has(segIdx)) {
            await fetchSegment(segIdx);
        }
        return;
    }

    const formData = new FormData();
    formData.append('userId', STATE.user.uid);
    formData.append('filename', STATE.currentFilename);
    formData.append('chapterIndex', index);

    document.getElementById('status-indicator').innerText = "Loading Chapter...";

    try {
        const response = await fetch('/api/get-chapter-sentences', {
            method: 'POST',
            body: formData
        });
        const data = await response.json();
        if (data.sentences) {
            STATE.currentBook.chapters[index].sentences = data.sentences;
            STATE.currentBook.chapters[index].count = data.sentences.length; // Ensure count is correct
            document.getElementById('status-indicator').innerText = "Ready";
        } else {
            throw new Error(data.error || "Failed to load chapter content.");
        }
    } catch (e) {
        console.error(e);
        document.getElementById('status-indicator').innerText = "Error loading chapter";
        throw e;
    }
}

async function renderChapter(index) {
    STATE.currentChapterIndex = index;

    // If segmented, ensure chapter data exists
    if (STATE.isSegmented) {
        const segIdx = Math.floor(index / 100);
        await fetchSegment(segIdx);
    }

    const chapter = STATE.currentBook.chapters[index];
    document.getElementById('current-chapter').innerText = chapter.title;
    document.getElementById('current-chapter').title = chapter.title;

    // In lite-mode: text-container is hidden, skip heavy DOM build
    // Only fetch sentences data (needed for audio engine / prefetch)
    if (STATE.isLiteMode) {
        if (!chapter.sentences) {
            document.getElementById('status-indicator').innerText = "Loading Chapter...";
            try {
                await fetchChapterSentences(index);
            } catch (e) {
                document.getElementById('status-indicator').innerText = `Error: ${e.message}`;
            }
        }
        return; // Skip all DOM rendering — no spans, no minimap
    }

    // Lazy load sentences if missing
    if (!chapter.sentences) {
        textContainer.innerHTML = '<div class="text-center p-8 text-primary/50 italic animate-pulse">Đang tải nội dung chương...</div>';
        try {
            await fetchChapterSentences(index);
        } catch (e) {
            textContainer.innerHTML = `<div class="text-center p-8 text-red-500 italic">Không thể tải nội dung: ${e.message}</div>`;
            return;
        }
    }

    await safeViewTransition(() => {
        textContainer.innerHTML = '';
        chapter.sentences.forEach((text, i) => {
            const span = document.createElement('span');
            span.id = `sentence-${i}`;
            span.className = 'chunk-text';
            span.innerText = text;
            span.onclick = () => playFromSentence(i);
            textContainer.appendChild(span);
            textContainer.appendChild(document.createElement('br'));
            textContainer.appendChild(document.createElement('br'));
        });

        textContainer.scrollTop = 0;
        renderMinimap(index);
    });
}

function renderMinimap(index) {
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

function renderTOC() {
    const tocList = document.getElementById('toc-list');
    tocList.innerHTML = '';
    const isSelectMode = document.getElementById('toc-select-mode-btn')?.classList.contains('active');

    STATE.currentBook.chapters.forEach((chap, i) => {
        const div = document.createElement('div');
        const isActive = i === STATE.currentChapterIndex;
        div.id = `toc-item-${i}`;
        div.className = `p-4 glass hover:bg-primary/10 cursor-pointer transition-colors flex items-center gap-3 ${isActive ? 'toc-active' : ''}`;

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = `toc-chapter-checkbox accent-primary w-4 h-4 rounded cursor-pointer shrink-0 ${isSelectMode ? '' : 'hidden'}`;
        checkbox.dataset.chapterIndex = i;
        checkbox.onclick = (e) => e.stopPropagation();
        checkbox.onchange = () => updateDownloadBar();

        const numSpan = document.createElement('span');
        numSpan.className = 'text-primary font-bold shrink-0';
        numSpan.innerText = i + 1;

        const titleSpan = document.createElement('span');
        titleSpan.className = 'truncate';
        titleSpan.innerText = chap.title;
        titleSpan.title = chap.title;

        const editBtn = document.createElement('button');
        editBtn.className = `ml-auto w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 hover:text-primary hover:bg-white/10 transition-all ${isSelectMode ? 'hidden' : ''}`;
        editBtn.innerHTML = '<i class="fas fa-pen text-xs"></i>';
        editBtn.title = 'Edit Chapter';
        editBtn.onclick = (e) => {
            e.stopPropagation();
            openEditChapterModal(i);
        };

        div.appendChild(checkbox);
        div.appendChild(numSpan);
        div.appendChild(titleSpan);
        div.appendChild(editBtn);

        div.onclick = () => {
            const selectMode = document.getElementById('toc-select-mode-btn')?.classList.contains('active');
            if (selectMode) {
                checkbox.checked = !checkbox.checked;
                updateDownloadBar();
                return;
            }
            renderChapter(i).then(() => {
                playFromSentence(0);
                closeTOC();
            });
        };
        tocList.appendChild(div);
    });
}

function scrollTOCCurrentChapter() {
    const activeItem = document.getElementById(`toc-item-${STATE.currentChapterIndex}`);
    const tocList = document.getElementById('toc-list');
    if (activeItem && tocList) {
        activeItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

/**
 * Closes the TOC overlay and restores the media player state if it was auto-minimized.
 */
function closeTOC() {
    // Reset select mode when closing TOC
    const selectBtn = document.getElementById('toc-select-mode-btn');
    if (selectBtn?.classList.contains('active')) {
        toggleSelectMode();
    }

    // Trả về trạng thái cũ cho trình phát nếu được thu gọn tự động bởi TOC
    if (STATE.tocAutoMinimized) {
        toggleMinimize(false);
        STATE.tocAutoMinimized = false;
    }

    document.getElementById('toc-overlay').classList.add('translate-x-full');
}

// --- Offline Download Logic ---
function toggleSelectMode() {
    const btn = document.getElementById('toc-select-mode-btn');
    const isActive = btn.classList.contains('active');
    btn.classList.toggle('active', !isActive);

    if (!isActive) {
        btn.classList.add('bg-primary/20', 'text-primary');
        btn.innerHTML = '<i class="fas fa-times text-xs"></i><span>Cancel</span>';
    } else {
        btn.classList.remove('bg-primary/20', 'text-primary');
        btn.innerHTML = '<i class="fas fa-check-double text-xs"></i><span>Select</span>';
    }

    document.querySelectorAll('.toc-chapter-checkbox').forEach(cb => {
        cb.classList.toggle('hidden', isActive);
        if (isActive) cb.checked = false;
    });

    updateDownloadBar();
}

function updateDownloadBar() {
    const checkboxes = document.querySelectorAll('.toc-chapter-checkbox:checked');
    const bar = document.getElementById('toc-download-bar');
    const countEl = document.getElementById('toc-selected-count');
    const isSelectMode = document.getElementById('toc-select-mode-btn')?.classList.contains('active');

    if (isSelectMode) {
        bar.classList.remove('hidden');
        countEl.innerText = `${checkboxes.length} chapter${checkboxes.length !== 1 ? 's' : ''} selected`;
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

async function downloadSelectedChapters() {
    const checkboxes = document.querySelectorAll('.toc-chapter-checkbox:checked');
    if (checkboxes.length === 0) {
        alert('Please select at least one chapter.');
        return;
    }

    const selectedIndices = Array.from(checkboxes).map(cb => parseInt(cb.dataset.chapterIndex));

    // UI elements
    const downloadBtn = document.getElementById('toc-download-btn');
    const statusEl = document.getElementById('toc-download-status');
    const progressContainer = document.getElementById('toc-download-progress');
    const progressBar = document.getElementById('toc-download-progress-bar');
    const chapterInfo = document.getElementById('toc-download-chapter-info');
    const percentEl = document.getElementById('toc-download-percent');

    // --- IMMEDIATE FEEDBACK ---
    STATE.isDownloading = true; // Set early to capture next click as "Stop"
    downloadBtn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i><span>Preparing...</span>';
    downloadBtn.classList.add('!bg-amber-500/20', '!text-amber-400', '!border-amber-500/30');

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
        downloadBtn.innerHTML = '<i class="fas fa-stop"></i><span>Stop Download</span>';
        downloadBtn.classList.remove('!bg-amber-500/20', '!text-amber-400', '!border-amber-500/30');
        downloadBtn.classList.add('!bg-red-500/20', '!text-red-400', '!border-red-500/30');

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

        document.getElementById('status-indicator').innerText = "Downloading Offline...";
        progressBar.style.width = '0%';
        percentEl.innerText = '0%';
        chapterInfo.innerText = `0 / ${STATE.downloadExpected} chunks`;
        statusEl.innerText = `Dispatching ${STATE.downloadExpected} chunks to ${STATE.settings.numWorkers} workers...`;

        console.log(`[Download] Starting parallel download: ${STATE.downloadExpected} chunks across ${chapters.length} chapters`);

        // 4. Ensure WebSocket is connected (workers are needed!)
        if (!(await waitForWebSocket())) {
            throw new Error("WebSocket connection timeout.");
        }

        // 5. Send ALL sentences as PREFETCH tasks — workers process in parallel!
        // Also cache chunk metadata for retry on failure
        STATE.downloadChunkMeta = new Map();
        STATE.downloadRetryCount = new Map();

        for (const chapter of chapters) {
            for (let s = 0; s < chapter.sentences.length; s++) {
                // Check if cancelled before sending each chunk
                if (!STATE.isDownloading) return;

                const key = `${chapter.chapterIndex}_${s}`;
                STATE.fetchingSet.add(key);

                // Cache metadata so failed chunks can be retried
                STATE.downloadChunkMeta.set(key, {
                    index: s,
                    chapterIndex: chapter.chapterIndex,
                    text: chapter.sentences[s],
                    voice,
                    rate,
                    pitch,
                    volume
                });

                STATE.ws.send(JSON.stringify({
                    type: "PREFETCH",
                    index: s,
                    chapterIndex: chapter.chapterIndex,
                    text: applySkipDictionary(chapter.sentences[s]),
                    voice: voice,
                    rate: rate,
                    pitch: pitch,
                    volume: volume,
                    numWorkers: STATE.settings.numWorkers,
                    sessionId: STATE.sessionId
                }));
            }
        }

        // 6. Wait for ALL chunks to be received by the WS binary handler
        await new Promise((resolve, reject) => {
            STATE.downloadResolve = resolve;
            STATE.downloadReject = reject;

            // Safety timeout: 10 minutes max
            setTimeout(() => {
                if (STATE.downloadResolve) {
                    STATE.downloadResolve = null;
                    STATE.downloadReject = null;
                    reject(new Error(`Download timed out (${STATE.downloadBuffer.size}/${STATE.downloadExpected} received)`));
                }
            }, 10 * 60 * 1000);
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
        STATE.downloadResolve = null;
        STATE.downloadReject = null;
        STATE.downloadChunkMeta = new Map();
        STATE.downloadRetryCount = new Map();
        downloadBtn.innerHTML = '<i class="fas fa-download"></i><span>Download Offline MP3</span>';
        downloadBtn.classList.remove('!bg-red-500/20', '!text-red-400', '!border-red-500/30', '!bg-amber-500/20', '!text-amber-400', '!border-amber-500/30');

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
        alert('Please select at least one chapter to delete.');
        return;
    }

    const selectedIndices = Array.from(checkboxes).map(cb => parseInt(cb.dataset.chapterIndex));
    const confirmMsg = `Are you sure you want to delete ${selectedIndices.length} chapter(s)?\nThis will permanently modify the source file.`;

    if (!confirm(confirmMsg)) return;

    const btn = document.getElementById('toc-delete-btn');
    const originalHTML = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>Deleting...</span>';
    btn.disabled = true;

    try {
        const formData = new FormData();
        formData.append('userId', STATE.user.uid);
        formData.append('bookId', STATE.currentBookId);
        formData.append('filename', STATE.currentFilename);
        formData.append('indices', JSON.stringify(selectedIndices));

        const response = await fetch('/api/delete-chapters', {
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

        alert('Chapters deleted successfully!');

        // Reset UI
        toggleSelectMode();
        renderTOC();

        // --- AUTO-DELETE STORY IF EMPTY ---
        if (data.chapters.length === 0) {
            alert('Tất cả các chương đã bị xóa. Đang gỡ bỏ truyện khỏi thư viện...');
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
        alert(`Error: ${err.message}`);
    } finally {
        btn.innerHTML = originalHTML;
        btn.disabled = false;
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

        for (let i = 0; i < count; i++) {
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
                index: currentSentIdx,
                chapterIndex: currentChapIdx,
                text: text,
                voice: voice,
                rate: rate,
                pitch: pitch,
                volume: volume,
                numWorkers: STATE.settings.numWorkers,
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

async function playFromSentence(index) {
    if (!STATE.currentBook) return;

    // 0. Robust Engine Reset - Dọn dẹp triệt để phiên cũ (dừng audio, xóa buffer, reset sessionId)
    await resetAudioEngine();

    // Dọn dẹp cache cũ khi nhảy tới vị trí mới (jump) - "Dọn dẹp sạch cho cái mới đi vào"
    await OFFLINE_MANAGER.clearCache();

    if (!(await waitForWebSocket())) {
        document.getElementById('status-indicator').innerText = "Connection failed";
        return;
    }

    const chapter = STATE.currentBook.chapters[STATE.currentChapterIndex];
    if (!chapter.sentences) {
        await fetchChapterSentences(STATE.currentChapterIndex);
    }

    STATE.currentSentenceIndex = index;
    const sentences = STATE.currentBook.chapters[STATE.currentChapterIndex].sentences;

    // Use the sessionId incremented by resetAudioEngine
    const currentSessionId = STATE.sessionId;
    STATE.lastAppendedIndex = index - 1; // Restart sequence from the target index
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
        STATE.appendQueue.push({
            index: index,
            chapterIndex: STATE.currentChapterIndex,
            sessionId: currentSessionId,
            data: arrayBuffer,
            metadata: []
        });
        processAppendQueue();
    } else {
        // Request the new starting sentence
        STATE.ws.send(JSON.stringify({
            type: "PREFETCH",
            index: index,
            chapterIndex: STATE.currentChapterIndex,
            text: applySkipDictionary(sentences[index]),
            voice: voice,
            rate: rate,
            pitch: pitch,
            volume: volume,
            numWorkers: STATE.settings.numWorkers,
            sessionId: currentSessionId
        }));
    }

    // Wait for the first chunk to be appended so we can start playback
    console.log(`Waiting for first chunk of session ${currentSessionId}...`);
    let attempts = 0;
    while (STATE.chunkTimings.length === 0 && attempts < 100) {
        if (STATE.sessionId !== currentSessionId) return; // User jumped again
        await new Promise(r => setTimeout(r, 100));
        attempts++;
    }

    if (STATE.chunkTimings.length > 0 && STATE.sessionId === currentSessionId) {
        audio.play().catch(e => console.warn("Auto-play blocked:", e));
        STATE.isPlaying = true;
        updateUI();
        highlightSentence(index);

        if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = 'playing';
            updateMediaSession();
        }

        prefetchNext(STATE.currentChapterIndex, index);
        saveProgress(false);
    }
}

function highlightSentence(index) {
    // --- OPTIMIZED: Use targeted removal instead of querySelectorAll ---
    if (STATE.lastHighlightedIndex !== -1 && STATE.lastHighlightedIndex !== index) {
        const prev = document.getElementById(`sentence-${STATE.lastHighlightedIndex}`);
        if (prev) prev.classList.remove('chunk-active');

        // Skip minimap DOM access in lite-mode (minimap is hidden/removed)
        if (!STATE.isLiteMode) {
            const prevMini = document.getElementById(`minimap-node-${STATE.lastHighlightedIndex}`);
            if (prevMini) prevMini.classList.remove('minimap-active');
        }
    }

    // In lite-mode, text-container is hidden — no need to highlight or scroll
    if (STATE.isLiteMode) {
        STATE.lastHighlightedIndex = index;
        return;
    }

    const cur = document.getElementById(`sentence-${index}`);
    if (cur) {
        cur.classList.add('chunk-active');
        STATE.lastHighlightedIndex = index;

        const container = document.getElementById('text-container');
        const containerHeight = container.offsetHeight;
        const offsetTop = cur.offsetTop;
        const currentScroll = container.scrollTop;

        // Calculate relative position within the container viewport
        const relativePos = offsetTop - currentScroll;
        const relativePercent = relativePos / containerHeight;

        // Comfort Zone Logic: Only scroll if text is too high (<15%) or too low (>60%)
        // This prevents the screen from jumping on every single sentence.
        if (relativePercent < 0.15 || relativePercent > 0.6) {
            const targetScroll = offsetTop - (containerHeight * 0.2); // Smoothly center around 20% from top
            container.scrollTo({
                top: targetScroll,
                behavior: 'smooth'
            });
        }
    }

    // Minimap sync
    const miniNode = document.getElementById(`minimap-node-${index}`);
    if (miniNode) {
        miniNode.classList.add('minimap-active');
        miniNode.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

async function togglePlayback() {
    if (!STATE.currentBook) return;

    if (document.getElementById('media-player').classList.contains('minimized-player')) {
        toggleMinimize(false);
    }

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

    // [TASK 3] Reset stall recovery counters on successful play
    STATE._stallRecoveryCount = 0;
    STATE.streamingRetryCount.clear();

    playBtn.innerHTML = '<i class="fas fa-pause"></i>';
    document.getElementById('status-indicator').innerText = "Streaming";

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
    playBtn.innerHTML = '<i class="fas fa-play ml-1"></i>';
    document.getElementById('status-indicator').innerText = "Paused";
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
    const newTitle = prompt("Enter new title for this book:", STATE.currentBook.title);
    if (newTitle && newTitle.trim() !== "" && newTitle !== STATE.currentBook.title) {
        STATE.currentBook.title = newTitle.trim();
        document.getElementById('current-title').innerText = STATE.currentBook.title;
        document.getElementById('current-title').title = STATE.currentBook.title;
        updateUI(); // Keep player and author tokens in sync

        // Force save with new title
        await saveProgress(true); // Persist title change immediately
        await refreshLibrary(); // Wait for library update to reflect new title
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

                // [FIX]: Chỉ cập nhật Mục lục nếu nó đang mở, tránh lỗi tự động trượt ra trên di động do hàm scrollIntoView
                const tocOverlay = document.getElementById('toc-overlay');
                if (tocOverlay && !tocOverlay.classList.contains('translate-x-full')) {
                    renderTOC();
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
        const chaptersInSegment = 100;
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

    // --- Progress Bar & Time Sync (skip in lite-mode: elements are hidden/unnecessary) ---
    if (!STATE.isLiteMode && STATE.currentBook) {
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
document.getElementById('voice-select').onchange = (e) => STATE.settings.voice = e.target.value;
document.getElementById('speed-range').oninput = (e) => {
    STATE.settings.speed = parseFloat(e.target.value);
    document.getElementById('speed-val').innerText = `${e.target.value}x`;
};
document.getElementById('pitch-range').oninput = (e) => {
    const val = parseInt(e.target.value);
    const pitchStr = `${val >= 0 ? '+' : ''}${val}Hz`;
    STATE.settings.pitch = pitchStr;
    document.getElementById('pitch-val').innerText = pitchStr;
};

document.getElementById('prefetch-range').oninput = (e) => {
    const stepIndex = parseInt(e.target.value);
    const count = WORKER_STEPS[stepIndex];
    STATE.settings.numWorkers = count;
    document.getElementById('prefetch-val').innerText = `${count} Workers`;
    // Trigger immediate prefetch to fill the new buffer size if needed
    prefetchNext(STATE.currentChapterIndex, STATE.currentSentenceIndex);
};

// --- Typography settings ---
const debouncedApplyTypography = debounce(() => {
    applyTypographySettings();
    saveProgress(false); // Proactive save after adjustment
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
    saveProgress(false); // Proactive save
};

document.querySelectorAll('.preset-color').forEach(btn => {
    btn.onclick = () => {
        const color = btn.dataset.color;
        STATE.settings.textColor = color;
        applyTypographySettings();
        saveProgress(false); // Proactive save
    };
});

function applyTypographySettings() {
    const s = STATE.settings;
    const root = document.documentElement;

    // Apply Font Size
    root.style.setProperty('--reader-font-size', `${s.fontSize}px`);

    // Apply Text Color
    if (s.textColor === "default") {
        root.style.setProperty('--reader-text-color', 'var(--theme-text-reading)');
        document.getElementById('font-color-picker').value = "#bac9cc"; // Default looking
    } else {
        root.style.setProperty('--reader-text-color', s.textColor);
        document.getElementById('font-color-picker').value = s.textColor;
    }
}

// --- UI Interactions ---
document.getElementById('prev-btn').onclick = () => playPrevChapter();
document.getElementById('next-btn').onclick = () => playNextChapter();

document.getElementById('toc-btn').onclick = () => {
    // Tự động thu gọn trình phát nếu đang mở
    const mediaPlayer = document.getElementById('media-player');
    if (!mediaPlayer.classList.contains('minimized-player')) {
        STATE.tocAutoMinimized = true;
        toggleMinimize(true);
    } else {
        STATE.tocAutoMinimized = false;
    }

    document.getElementById('toc-overlay').classList.remove('translate-x-full');
    renderTOC(); // Re-render to ensure active state is correct
    setTimeout(scrollTOCCurrentChapter, 300);
};
document.getElementById('close-toc').onclick = () => closeTOC();
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

document.getElementById('fullscreen-btn').onclick = toggleFullscreen;

// Performance / Lite Mode
const liteModeToggle = document.getElementById('lite-mode-toggle');

/**
 * Applies or removes lite-mode optimizations at both CSS and JS levels.
 * CSS-level: body.lite-mode class (disables animations, hides heavy elements)
 * JS-level: STATE.isLiteMode flag (skips scroll, minimap, DOM renders)
 */
function applyLiteMode(isLite) {
    STATE.isLiteMode = isLite;
    localStorage.setItem('lite-mode-enabled', isLite);

    // Only apply visual effects if reader is active (not discovery mode)
    const discoveryMode = document.getElementById('discovery-mode');
    const isDiscovery = discoveryMode && !discoveryMode.classList.contains('hidden');

    if (isLite && !isDiscovery) {
        document.body.classList.add('lite-mode');
    } else {
        document.body.classList.remove('lite-mode');
    }

    if (isLite) {
        // Freeze any pending smooth scrolls by forcing instant snap
        const textContainer = document.getElementById('text-container');
        if (textContainer) textContainer.style.scrollBehavior = 'auto';

        // Clear minimap DOM to free up memory & layout cost
        const minimap = document.getElementById('minimap-container');
        if (minimap) minimap.innerHTML = '';

        // Sync mobile toggle if it exists
        const mobileToggle = document.getElementById('lite-mode-toggle-mobile');
        if (mobileToggle) mobileToggle.checked = true;
    } else {
        // Restore smooth scrolling
        const textContainer = document.getElementById('text-container');
        if (textContainer) textContainer.style.scrollBehavior = '';

        // Sync mobile toggle
        const mobileToggle = document.getElementById('lite-mode-toggle-mobile');
        if (mobileToggle) mobileToggle.checked = false;

        // Re-render full chapter view (text spans + minimap were skipped in lite-mode)
        if (STATE.currentBook) {
            renderChapter(STATE.currentChapterIndex).then(() => {
                // Restore highlight and scroll position after rebuild
                highlightSentence(STATE.currentSentenceIndex);
                syncMinimapScroll();
            });
        }

        // Reset throttle tick to force immediate UI refresh
        STATE.lastOntimeUpdateTick = -999;
        STATE.lastProgressWidth = null;
        STATE.lastCurrentMock = null;
        STATE.lastTimeStr = null;
    }

    console.log(`[LiteMode] ${isLite ? 'ON — UI computations minimized' : 'OFF — Full UI restored'}`);
}

if (liteModeToggle) {
    // Restore saved state on page load
    const savedLiteMode = localStorage.getItem('lite-mode-enabled') === 'true';
    liteModeToggle.checked = savedLiteMode;
    applyLiteMode(savedLiteMode);

    // Desktop toggle
    liteModeToggle.addEventListener('change', (e) => {
        applyLiteMode(e.target.checked);
    });
}

// Mobile toggle: override the inline onchange with a proper listener for symmetry
const liteModeToggleMobile = document.getElementById('lite-mode-toggle-mobile');
if (liteModeToggleMobile) {
    // Remove inline onchange to prevent double-fire
    liteModeToggleMobile.removeAttribute('onchange');
    liteModeToggleMobile.addEventListener('change', (e) => {
        if (liteModeToggle) liteModeToggle.checked = e.target.checked;
        applyLiteMode(e.target.checked);
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
    if (curTimingIdx !== -1 && curTimingIdx < STATE.chunkTimings.length - 1) {
        const nextChunk = STATE.chunkTimings[curTimingIdx + 1];
        audio.currentTime = nextChunk.startTime + 0.01;
        if (audio.paused) audio.play();
    } else {
        const sentenceCount = chapters[curChap]?.sentences?.length ?? 0;
        if (sentenceCount > 0 && curSent < sentenceCount - 1) {
            await playFromSentence(curSent + 1);
        } else if (curChap < chapters.length - 1) {
            await renderChapter(curChap + 1);
            await playFromSentence(0);
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
    if (curTimingIdx > 0) {
        const prevChunk = STATE.chunkTimings[curTimingIdx - 1];
        audio.currentTime = prevChunk.startTime + 0.01;
        if (audio.paused) audio.play();
    } else {
        if (curSent > 0) {
            await playFromSentence(curSent - 1);
        } else if (curChap > 0) {
            const prevChap = curChap - 1;
            await renderChapter(prevChap);
            const prevSentCount = STATE.currentBook.chapters[prevChap]?.sentences?.length ?? 1;
            await playFromSentence(Math.max(0, prevSentCount - 1));
        }
    }
}

async function playNextChapter() {
    if (!STATE.currentBook) return;
    const curChap = STATE.currentChapterIndex;
    const chapters = STATE.currentBook.chapters;
    if (curChap < chapters.length - 1) {
        await renderChapter(curChap + 1);
        await playFromSentence(0);
    }
}

async function playPrevChapter() {
    if (!STATE.currentBook) return;
    const curChap = STATE.currentChapterIndex;
    if (curChap > 0) {
        await renderChapter(curChap - 1);
        await playFromSentence(0);
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

function updateWakeLockUI(isActive) {
    const btn = document.getElementById('wake-lock-btn');
    const icon = document.getElementById('wake-lock-icon');
    if (!btn || !icon) return;

    if (isActive) {
        btn.title = "Keep Screen Awake (On)";
        icon.className = "fas fa-sun text-lg text-yellow-400 drop-shadow-[0_0_8px_rgba(250,204,21,0.6)] transition-all duration-300 transform scale-110";
    } else {
        btn.title = "Keep Screen Awake (Off)";
        icon.className = "far fa-sun text-lg transition-all duration-300";
    }
}

// --- Sleep Timer & Manual Save Logic ---
function toggleSleepTimerDropdown() {
    const dropdown = document.getElementById('sleep-timer-dropdown');
    dropdown.classList.toggle('hidden');

    // Close dropdown when clicking outside
    if (!dropdown.classList.contains('hidden')) {
        const closeDropdown = (e) => {
            if (!dropdown.contains(e.target) && !document.getElementById('sleep-timer-btn').contains(e.target)) {
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
        alert("Please set a valid duration.");
        return;
    }
    startSleepTimer(seconds);
}

function startSleepTimer(seconds) {
    if (STATE.sleepTimer) clearInterval(STATE.sleepTimer);

    STATE.sleepTimerEnd = Date.now() + seconds * 1000;
    updateSleepTimerUI(true, seconds);
    document.getElementById('sleep-timer-dropdown').classList.add('hidden');

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
    document.getElementById('sleep-timer-dropdown').classList.add('hidden');
}

function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return [h, m, s].map(v => v < 10 ? "0" + v : v).join(":");
}

function updateSleepTimerUI(isActive, seconds = 0) {
    const btn = document.getElementById('sleep-timer-btn');
    const icon = document.getElementById('sleep-timer-icon');
    const badge = document.getElementById('sleep-timer-badge');
    const controls = document.getElementById('sleep-timer-active-controls');
    const remainingText = document.getElementById('sleep-timer-remaining');

    if (isActive) {
        icon.className = "fas fa-moon text-lg text-primary scale-110";
        badge.innerText = seconds > 60 ? Math.ceil(seconds / 60) + "m" : seconds;
        badge.classList.remove('opacity-0');
        btn.classList.add('bg-primary/10');

        if (controls) controls.classList.remove('hidden');
        if (remainingText) remainingText.innerText = formatTime(seconds);
    } else {
        icon.className = "fas fa-moon text-lg";
        badge.classList.add('opacity-0');
        btn.classList.remove('bg-primary/10');

        if (controls) controls.classList.add('hidden');
    }
}

async function triggerManualSave() {
    const btn = document.getElementById('manual-save-btn');
    const icon = document.getElementById('manual-save-icon');

    btn.classList.add('pointer-events-none');
    icon.className = "fas fa-sync-alt fa-spin text-primary";

    try {
        // Force sync both progress and statistics
        await Promise.all([
            saveProgress(true),
            STATS_MANAGER.syncToFirestore(true)
        ]);

        icon.className = "fas fa-check text-green-400";
        setTimeout(() => {
            icon.className = "fas fa-cloud-upload-alt text-lg";
            btn.classList.remove('pointer-events-none');
        }, 2000);
    } catch (e) {
        console.error("Manual save failed:", e);
        icon.className = "fas fa-times text-red-500";
        setTimeout(() => {
            icon.className = "fas fa-cloud-upload-alt text-lg";
            btn.classList.remove('pointer-events-none');
        }, 2000);
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

    // 1. Save Progress
    if (STATE.user && STATE.currentBookId) {
        document.getElementById('status-indicator').innerText = "Session Expired...";
        await saveProgress(true);
    }

    // 2. [TASK 3] Disconnect WebSocket ONLY (Preserve Buffer & Cache)
    closeWebSocketIntentionally();

    STATE.isPlaying = false;
    const playBtn = document.getElementById('play-btn');
    if (playBtn) playBtn.innerHTML = '<i class="fas fa-play ml-1"></i>';

    document.getElementById('status-indicator').innerText = "Session Expired (1m Inactivity)";
    document.getElementById('status-indicator').style.color = "#FFB347";
}

async function handlePlaybackStall() {
    STATE.stallCount = 0;
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

document.getElementById('sleep-timer-btn').onclick = () => toggleSleepTimerDropdown();
document.getElementById('manual-save-btn').onclick = () => triggerManualSave();

document.getElementById('wake-lock-btn').onclick = () => toggleWakeLock();

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

async function openEditChapterModal(index) {
    if (!STATE.user || !STATE.currentFilename) return;

    editingChapterIndex = index;
    const modal = document.getElementById('edit-chapter-modal');
    const textarea = document.getElementById('edit-chapter-textarea');
    const statusIndicator = document.getElementById('status-indicator');

    statusIndicator.innerText = "Fetching raw content...";

    try {
        const formData = new FormData();
        formData.append('userId', STATE.user.uid);
        formData.append('bookId', STATE.currentBookId);
        formData.append('filename', STATE.currentFilename);
        formData.append('chapterIndex', index);

        const response = await fetch('/api/get-chapter-content', {
            method: 'POST',
            body: formData
        });

        const data = await response.json();
        if (data.content) {
            textarea.value = data.content;
            modal.classList.remove('hidden');
            statusIndicator.innerText = "Ready";
        } else {
            throw new Error(data.error || "Failed to fetch content");
        }
    } catch (err) {
        console.error("Edit fetch error:", err);
        alert(`Error: ${err.message}`);
        statusIndicator.innerText = "Error";
    }
}

function closeEditModal() {
    document.getElementById('edit-chapter-modal').classList.add('hidden');
    editingChapterIndex = -1;
}

async function saveChapterEdit() {
    if (editingChapterIndex === -1 || !STATE.user || !STATE.currentFilename) return;

    const textarea = document.getElementById('edit-chapter-textarea');
    const newContent = textarea.value;
    const saveBtn = document.getElementById('save-edit-btn');
    const statusIndicator = document.getElementById('status-indicator');

    const originalText = saveBtn.innerText;
    saveBtn.innerText = "Saving...";
    saveBtn.disabled = true;
    statusIndicator.innerText = "Saving changes...";

    try {
        const formData = new FormData();
        formData.append('userId', STATE.user.uid);
        formData.append('bookId', STATE.currentBookId);
        formData.append('filename', STATE.currentFilename);
        formData.append('chapterIndex', editingChapterIndex);
        formData.append('newContent', newContent);

        const response = await fetch('/api/update-chapter', {
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
                const segIdx = Math.floor(editingChapterIndex / 100);
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
            statusIndicator.innerText = "Changes saved!";
            setTimeout(() => statusIndicator.innerText = "Ready", 3000);
        } else {
            throw new Error(data.error || "Failed to save changes");
        }
    } catch (err) {
        console.error("Save edit error:", err);
        alert(`Error: ${err.message}`);
        statusIndicator.innerText = "Error saving";
    } finally {
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
        alert('Cache cleared successfully!');
    }
});

// --- Theme Management ---
function applyTheme(themeId) {
    // Optimization: Skip transition if theme is already active
    if (document.documentElement.getAttribute('data-theme') === themeId) {
        // Still update swatches just in case
        document.querySelectorAll('.theme-swatch').forEach(sw => {
            const isActive = sw.dataset.theme === themeId;
            sw.classList.toggle('active', isActive);
            if (isActive) {
                const nameEl = document.getElementById('current-theme-name');
                if (nameEl) nameEl.innerText = sw.getAttribute('title');
            }
        });
        return;
    }

    safeViewTransition(() => {
        document.documentElement.setAttribute('data-theme', themeId);
        STATE.theme = themeId;
        localStorage.setItem('reader-theme', themeId);

        // Update UI swatches
        document.querySelectorAll('.theme-swatch').forEach(sw => {
            const isActive = sw.dataset.theme === themeId;
            sw.classList.toggle('active', isActive);
            if (isActive) {
                document.getElementById('current-theme-name').innerText = sw.getAttribute('title');
            }
        });
    });
}

document.getElementById('theme-toggle-btn')?.addEventListener('click', () => {
    const panel = document.getElementById('theme-picker-panel');
    const chevron = document.getElementById('theme-chevron');
    if (panel) {
        panel.classList.toggle('active');
        chevron?.classList.toggle('rotate-180');
    }
});

document.querySelectorAll('.theme-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
        const theme = sw.dataset.theme;
        applyTheme(theme);
        saveProgress(true); // Persist theme change immediately
    });
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
// [MiniPlayer] Bridge for static/js/mini-player-widget.js
// The widget lives outside this module, so expose the few
// pieces of state/behavior it mirrors. It owns no audio logic.
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
};
// Apply initial settings to UI on startup
applySettingsToUI();

document.dispatchEvent(new CustomEvent('mpw-bridge-ready'));
