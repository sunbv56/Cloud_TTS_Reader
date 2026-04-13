// Firebase Modules
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc, deleteDoc, serverTimestamp, collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { getStorage, ref, uploadBytes, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";

// Firebase placeholders (Initialized via API)
let app, auth, db, storage, provider;

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
                document.getElementById('book-list').innerHTML = '<div class="text-center p-8 text-slate-500 italic text-sm">Login to see your library.</div>';
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
function removeVietnameseTones(str) {
    str = str.normalize('NFD').replace(/[\u0300-\u036f]/g, "");
    str = str.replace(/[đĐ]/g, m => m === 'đ' ? 'd' : 'D');
    return str;
}

// App State
let STATE = {
    user: null,
    currentBook: null,
    currentBookId: null,
    currentFilename: null,
    currentChapterIndex: 0,
    currentSentenceIndex: 0,
    lastSavedChunkIndex: -1,
    isPlaying: false,
    metadata: [],
    fetchingSet: new Set(), // indices being fetched
    ws: null,
    metadataQueue: [], // Temporary store for metadata before binary arrive
    settings: {
        voice: "vi-VN-HoaiMyNeural",
        speed: 1.0,
        pitch: "+0Hz",
        volume: "+0%",
        numWorkers: 5
    },
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
    // Offline Download
    isDownloading: false,
    downloadBuffer: new Map(),
    downloadExpected: 0,
    downloadResolve: null,
    downloadReject: null,
    tocAutoMinimized: false
};

// Constants
const WORKER_STEPS = [1, 2, 3, 5, 10, 20, 50];

// DOM Elements
const audio = document.getElementById('main-audio');
const playBtn = document.getElementById('play-btn');
const textContainer = document.getElementById('text-container');
const fileInput = document.getElementById('file-input');
const bookList = document.getElementById('book-list');

// --- Initialization ---
function initWebSocket() {
    if (STATE.ws && (STATE.ws.readyState === WebSocket.OPEN || STATE.ws.readyState === WebSocket.CONNECTING)) {
        return; // Don't create multiple connections
    }
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    STATE.ws = new WebSocket(wsUrl);

    STATE.ws.onopen = () => {
        console.log("Connected to WebSocket");
        document.getElementById('status-indicator').innerText = "Ready";
        // Start Heartbeat
        setInterval(() => {
            if (STATE.ws.readyState === WebSocket.OPEN) {
                STATE.ws.send(JSON.stringify({ type: "PING" }));
            }
        }, 30000);
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
            } else if (data.type === "PREFETCH_DONE") {
                if (data.sessionId && data.sessionId !== STATE.sessionId) return;
                STATE.fetchingSet.delete(`${data.chapterIndex}_${data.index}`);
                document.getElementById('status-indicator').innerText = "Ready";

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

    STATE.ws.onclose = () => {
        console.log("WebSocket Disconnected.");
        if (STATE.isPlaying && !STATE.isStalled) {
            console.log("Unexpected disconnect, reconnecting in 3s...");
            setTimeout(initWebSocket, 3000);
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
    if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) return;

    if (!STATE.ws || STATE.ws.readyState === WebSocket.CLOSED || STATE.ws.readyState === WebSocket.CLOSING) {
        console.warn("WebSocket not connected. Connecting...");
        document.getElementById('status-indicator').innerText = "Connecting...";
        initWebSocket();
    }

    return new Promise((resolve) => {
        const startTime = Date.now();
        const check = () => {
            if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
                resolve();
            } else if (Date.now() - startTime > 10000) {
                // Timeout after 10s
                console.error("WebSocket connection timeout.");
                resolve(); // Resolve anyway to avoid hanging, or handle error
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
    if (!STATE.sourceBuffer || STATE.sourceBuffer.updating || STATE.appendQueue.length === 0 || STATE.isAppending) return;

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

    const chunkToCheck = STATE.appendQueue[0];
    if (chunkToCheck.chapterIndex !== expectedChap || chunkToCheck.index !== expectedIdx) {
        console.log(`Waiting for chunk ${expectedChap}-${expectedIdx} (Queue has ${chunkToCheck.chapterIndex}-${chunkToCheck.index})`);
        return;
    }

    STATE.isAppending = true;
    const chunk = STATE.appendQueue.shift();

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

    // Batching: only save if forced OR distance >= 10
    if (!force && Math.abs(currentGlobalIndex - STATE.lastSavedChunkIndex) < 10) {
        console.log(`Skipping Firestore sync (Batching): Current ${currentGlobalIndex}, Last Saved ${STATE.lastSavedChunkIndex}`);
        return;
    }

    try {
        const progressRef = doc(db, "users", STATE.user.uid, "progress", STATE.currentBookId);
        await setDoc(progressRef, {
            title: STATE.currentBook.title,
            filename: STATE.currentFilename,
            last_read_chunk: currentGlobalIndex,
            total_chunks: getTotalChunks(),
            settings: STATE.settings, // Save current settings
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
    return STATE.currentBook.chapters.reduce((acc, chap) => acc + chap.sentences.length, 0);
}

function getGlobalIndex(chapIdx, sentIdx) {
    if (!STATE.currentBook) return 0;
    let total = 0;
    for (let i = 0; i < chapIdx; i++) {
        total += STATE.currentBook.chapters[i].sentences.length;
    }
    return total + sentIdx;
}

function getLocalIndices(globalIdx) {
    if (!STATE.currentBook) return { chapterIndex: 0, sentenceIndex: 0 };
    let remaining = globalIdx;
    for (let i = 0; i < STATE.currentBook.chapters.length; i++) {
        const len = STATE.currentBook.chapters[i].sentences.length;
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
    bookList.innerHTML = '<div class="text-center p-4 text-primary animate-pulse text-xs uppercase font-bold tracking-widest">Updating Library...</div>';

    try {
        const q = query(collection(db, "users", STATE.user.uid, "progress"));
        const querySnapshot = await getDocs(q);
        bookList.innerHTML = '';

        if (querySnapshot.empty) {
            bookList.innerHTML = '<div class="text-center p-8 text-slate-500 italic text-sm">No books loaded. Upload a .txt file!</div>';
            return;
        }

        querySnapshot.forEach((docSnap) => {
            const data = docSnap.data();
            const bookId = docSnap.id;
            const rawProgress = data.total_chunks > 0
                ? (data.last_read_chunk / data.total_chunks * 100)
                : 0;
            const progress = rawProgress.toFixed(1);
            const filename = data.filename || (bookId.replace('book_', '') + '.txt');

            // ── Outer wrapper (enables named-group hover) ──────────────────────
            const wrapper = document.createElement('div');
            wrapper.className = 'relative group/item';

            // ── Book card ─────────────────────────────────────────────────────
            const div = document.createElement('div');
            div.className = 'glass p-3 pr-9 flex flex-col gap-1 cursor-pointer hover:bg-primary/5 transition-all group border-l-2 border-transparent hover:border-primary rounded-lg';
            div.innerHTML = `
                <div class="flex items-center justify-between gap-2">
                    <span class="text-sm font-bold text-white group-hover:text-primary transition-colors line-clamp-1 flex-1 min-w-0">${data.title}</span>
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
            mergeBtn.onclick = () => {
                toggleKebabMenu(bookId);
                document.getElementById(`merge-input-${bookId}`).click();
            };

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'w-full text-left px-4 py-2.5 text-sm flex items-center gap-3 hover:bg-red-500/10 hover:text-red-400 transition-colors text-slate-300';
            deleteBtn.innerHTML = '<i class="fas fa-trash-alt w-4 text-center"></i> Xóa truyện';
            deleteBtn.onclick = () => deleteBook(bookId, filename, data.title);

            dropdown.appendChild(mergeBtn);
            dropdown.appendChild(deleteBtn);

            wrapper.appendChild(div);
            wrapper.appendChild(mergeInput);
            wrapper.appendChild(kebabBtn);
            wrapper.appendChild(dropdown);
            bookList.appendChild(wrapper);
        });
    } catch (err) {
        console.error("Library Refresh Error:", err);
        bookList.innerHTML = '<div class="text-center p-8 text-red-400 italic text-sm">Error updating library.</div>';
    }
}

// ── Kebab Menu Helpers ───────────────────────────────────────────────────────

/**
 * Toggles a kebab dropdown menu. Closes all other open menus first.
 */
function toggleKebabMenu(bookId) {
    const targetId = `kebab-menu-${bookId}`;
    document.querySelectorAll('[id^="kebab-menu-"]').forEach(menu => {
        if (menu.id !== targetId) menu.classList.add('hidden');
    });
    const menu = document.getElementById(targetId);
    if (menu) menu.classList.toggle('hidden');
}

// Close all kebab menus when clicking anywhere outside
document.addEventListener('click', () => {
    document.querySelectorAll('[id^="kebab-menu-"]').forEach(menu => menu.classList.add('hidden'));
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
        const newTotalChunks = newBookData.total_chunks;

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

        setTimeout(() => document.getElementById('status-indicator').innerText = 'Ready', 3000);

    } catch (err) {
        console.error('[Merge] Error:', err);
        alert(`Nối chương thất bại: ${err.message}`);
        document.getElementById('status-indicator').innerText = 'Error';
        setTimeout(() => document.getElementById('status-indicator').innerText = 'Ready', 3000);
    }
}

async function loadBookFromStorage(bookId, bookData) {
    // Close sidebar immediately on selection (don't wait for loading to finish)
    toggleSidebar(false);

    document.getElementById('status-indicator').innerText = "Loading from Storage...";
    document.getElementById('current-title').innerText = "Fetching " + bookData.title + "...";

    try {
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

        await loadBook(data, bookId, filename);
        document.getElementById('status-indicator').innerText = "Ready";
        saveProgress(true); // Force save to sync local state
    } catch (err) {
        console.error("Load from Storage Error:", err);
        alert("Failed to load book from storage. Make sure the file still exists.");
    }
}

// --- Auth state is now handled inside startFirebase() ---

// --- File Handling ---
fileInput.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    document.getElementById('status-indicator').innerText = "Uploading & Parsing...";
    try {
        // Parallel: Upload to Firebase Storage and Parse via FastAPI
        const [uploadRes, parseRes] = await Promise.all([
            uploadToStorage(file),
            fetch('/api/parse-book', { method: 'POST', body: formData })
        ]);

        const data = await parseRes.json();
        // Use book_ prefix and numeric-like ID to match screenshot
        const bookId = "book_" + file.name.replace(/\.[^/.]+$/, "").replace(/[^a-zA-Z0-9]/g, "_");
        loadBook(data, bookId, file.name);

        // Refresh library sidebar
        refreshLibrary();
    } catch (err) {
        console.error(err);
        alert("Error parsing book.");
    }
};

async function loadBook(bookData, bookId, filename) {
    // Auto-close sidebar on mobile after selection
    toggleSidebar(false);

    // Save progress of the current book before switching to the new one
    if (STATE.currentBookId) {
        console.log(`Saving progress for ${STATE.currentBookId} before switching...`);
        await saveProgress(true);
    }

    STATE.currentBook = bookData;
    STATE.currentBookId = bookId || ("book_" + bookData.title.replace(/[^a-zA-Z0-9]/g, "_"));
    STATE.currentFilename = filename || (STATE.currentBook.title + ".txt");

    // Check for existing progress
    const progress = await loadProgress(STATE.currentBookId);
    if (progress && progress.last_read_chunk !== undefined) {
        // Restore user-edited title and correct filename
        if (progress.title) STATE.currentBook.title = progress.title;
        if (progress.filename) STATE.currentFilename = progress.filename;

        const indices = getLocalIndices(progress.last_read_chunk);
        STATE.currentChapterIndex = indices.chapterIndex;
        STATE.currentSentenceIndex = indices.sentenceIndex;
        STATE.lastSavedChunkIndex = progress.last_read_chunk;

        // Restore book-specific voice settings
        if (progress.settings) {
            STATE.settings = { ...STATE.settings, ...progress.settings };
            applySettingsToUI();
            console.log("Restored saved voice settings from Firestore.");
        }

        console.log(`Resuming from global chunk ${progress.last_read_chunk}`);
    } else {
        STATE.currentChapterIndex = 0;
        STATE.currentSentenceIndex = 0;
        STATE.lastSavedChunkIndex = -1;
    }

    document.getElementById('current-title').innerText = bookData.title;
    document.getElementById('edit-title-btn').classList.remove('hidden');
    renderChapter(STATE.currentChapterIndex);
    renderTOC();
    updateUI();

    if (progress) {
        // If resuming, highlight the sentence
        highlightSentence(STATE.currentSentenceIndex);
    }

    // Immediately sync to register the book and filename in the library (Forced)
    saveProgress(true);

    // Auto-play from current position
    playFromSentence(STATE.currentSentenceIndex);

}

function renderChapter(index) {
    STATE.currentChapterIndex = index;
    const chapter = STATE.currentBook.chapters[index];
    document.getElementById('current-chapter').innerText = chapter.title;

    textContainer.innerHTML = '';
    chapter.sentences.forEach((text, i) => {
        const span = document.createElement('span');
        span.id = `sentence-${i}`;
        span.className = 'chunk-text p-1 inline-block';
        span.innerText = text;
        span.onclick = () => playFromSentence(i);
        textContainer.appendChild(span);
        textContainer.appendChild(document.createElement('br'));
        textContainer.appendChild(document.createElement('br'));
    });

    textContainer.scrollTop = 0;
    renderMinimap(index);
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

// Add scroll listener for minimap
document.getElementById('text-container').addEventListener('scroll', syncMinimapScroll);

function renderTOC() {
    const tocList = document.getElementById('toc-list');
    tocList.innerHTML = '';
    const isSelectMode = document.getElementById('toc-select-mode-btn')?.classList.contains('active');

    STATE.currentBook.chapters.forEach((chap, i) => {
        const div = document.createElement('div');
        const isActive = i === STATE.currentChapterIndex;
        div.id = `toc-item-${i}`;
        div.className = `p-4 glass hover:bg-primary/10 cursor-pointer transition-colors flex items-center gap-3 ${isActive ? 'border-l-4 border-primary bg-primary/10 font-bold text-white' : ''}`;

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

        div.appendChild(checkbox);
        div.appendChild(numSpan);
        div.appendChild(titleSpan);

        div.onclick = () => {
            const selectMode = document.getElementById('toc-select-mode-btn')?.classList.contains('active');
            if (selectMode) {
                checkbox.checked = !checkbox.checked;
                updateDownloadBar();
                return;
            }
            renderChapter(i);
            playFromSentence(0);
            document.getElementById('toc-overlay').classList.add('translate-x-full');
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

    const chapters = selectedIndices.map(idx => ({
        chapterIndex: idx,
        title: STATE.currentBook.chapters[idx].title,
        sentences: STATE.currentBook.chapters[idx].sentences
    }));

    const { voice, speed, pitch, volume } = STATE.settings;
    const rate = `${Math.round((speed - 1) * 100) >= 0 ? '+' : ''}${Math.round((speed - 1) * 100)}%`;

    // UI elements
    const downloadBtn = document.getElementById('toc-download-btn');
    const statusEl = document.getElementById('toc-download-status');
    const progressContainer = document.getElementById('toc-download-progress');
    const progressBar = document.getElementById('toc-download-progress-bar');
    const chapterInfo = document.getElementById('toc-download-chapter-info');
    const percentEl = document.getElementById('toc-download-percent');

    downloadBtn.innerHTML = '<i class="fas fa-stop"></i><span>Stop Download</span>';
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
    STATE.isDownloading = true;
    STATE.downloadBuffer = new Map();
    STATE.downloadExpected = chapters.reduce((sum, ch) => sum + ch.sentences.length, 0);

    document.getElementById('status-indicator').innerText = "Downloading Offline...";
    statusEl.classList.remove('hidden');
    progressContainer.classList.remove('hidden');
    progressBar.style.width = '0%';
    percentEl.innerText = '0%';
    chapterInfo.innerText = `0 / ${STATE.downloadExpected} chunks`;
    statusEl.innerText = `Dispatching ${STATE.downloadExpected} chunks to ${STATE.settings.numWorkers} workers...`;

    console.log(`[Download] Starting parallel download: ${STATE.downloadExpected} chunks across ${chapters.length} chapters`);

    try {
        // 4. Ensure WebSocket is connected (workers are needed!)
        await waitForWebSocket();

        // 5. Send ALL sentences as PREFETCH tasks — workers process in parallel!
        for (const chapter of chapters) {
            for (let s = 0; s < chapter.sentences.length; s++) {
                const key = `${chapter.chapterIndex}_${s}`;
                STATE.fetchingSet.add(key);

                STATE.ws.send(JSON.stringify({
                    type: "PREFETCH",
                    index: s,
                    chapterIndex: chapter.chapterIndex,
                    text: chapter.sentences[s],
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
        downloadBtn.innerHTML = '<i class="fas fa-download"></i><span>Download Offline MP3</span>';
        downloadBtn.classList.remove('!bg-red-500/20', '!text-red-400', '!border-red-500/30');

        // Close WebSocket after download (free backend resources)
        if (STATE.ws) {
            STATE.ws.close();
            STATE.ws = null;
        }
        document.getElementById('status-indicator').innerText = "Disconnected";
        const playBtn = document.getElementById('play-btn');
        if (playBtn) playBtn.innerHTML = '<i class="fas fa-play ml-1"></i>';
    }
}

function stopDownload() {
    console.log('[Download] User stopped download.');

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

        // Update local state
        STATE.currentBook.chapters = data.chapters;

        // Update Firestore total_chunks (to keep library in sync)
        const bookRef = doc(db, "users", STATE.user.uid, "progress", STATE.currentBookId);
        await setDoc(bookRef, { total_chunks: data.total_chunks }, { merge: true });

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
        renderChapter(STATE.currentChapterIndex);

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
    if (!STATE.currentBook) return;

    // Target buffer size: keep at least 100 chunks ahead, or 10x the workers
    const target = Math.max(100, STATE.settings.numWorkers * 10);
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
        if (count === null) count = Math.max(200, STATE.settings.numWorkers * 20);
        if (!STATE.ws || STATE.ws.readyState !== WebSocket.OPEN) {
            await waitForWebSocket();
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
            if (currentSentIdx >= STATE.currentBook.chapters[currentChapIdx].sentences.length) {
                currentChapIdx++;
                currentSentIdx = 0;
                if (currentChapIdx >= STATE.currentBook.chapters.length) break;
            }

            const key = `${currentChapIdx}_${currentSentIdx}`;
            if (busyIndices.has(key)) {
                currentSentIdx++;
                continue;
            }

            STATE.fetchingSet.add(key);
            const text = STATE.currentBook.chapters[currentChapIdx].sentences[currentSentIdx];
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
    await waitForWebSocket();
    STATE.currentSentenceIndex = index;
    const sentences = STATE.currentBook.chapters[STATE.currentChapterIndex].sentences;

    // Increment session ID to invalidate pending requests
    STATE.sessionId++;
    const currentSessionId = STATE.sessionId;
    STATE.lastAppendedIndex = index - 1; // Restart sequence from the target index
    STATE.lastAppendedChapter = STATE.currentChapterIndex;
    console.log(`Starting new audio session: ${currentSessionId} (Jump to chunk ${index})`);

    // --- MSE Seek/Reset Logic ---
    // If we are jumping (not sequential append), we need to clear everything
    audio.pause();
    STATE.isTransitioning = true;
    STATE.appendQueue = [];
    STATE.chunkTimings = [];
    STATE.fetchingSet.clear();
    STATE.metadataQueue = [];
    updatePrefetchUI();

    if (STATE.sourceBuffer) {
        try {
            if (STATE.sourceBuffer.updating) {
                console.log("SourceBuffer updating, aborting...");
                STATE.sourceBuffer.abort();
            }

            // Clear all buffered data
            if (STATE.sourceBuffer.buffered.length > 0) {
                const start = STATE.sourceBuffer.buffered.start(0);
                const end = STATE.sourceBuffer.buffered.end(STATE.sourceBuffer.buffered.length - 1);
                console.log(`Removing buffer from ${start} to ${end}`);
                STATE.sourceBuffer.remove(0, end + 10); // Plus buffer

                // Wait for remove to complete
                await new Promise(r => {
                    const check = () => {
                        if (!STATE.sourceBuffer.updating) r();
                        else setTimeout(check, 50);
                    };
                    check();
                });
            }

            // Reset offset so new data starts at 0
            STATE.sourceBuffer.timestampOffset = 0;
            // Mark for first chunk handling
            STATE.isFirstChunkOfSession = true;
            console.log("MSE ready for new session (buffer cleared)");
        } catch (e) {
            console.error("MSE Reset Error:", e);
        }
    }

    document.getElementById('status-indicator').innerText = "Buffering...";
    const { voice, speed, pitch, volume } = STATE.settings;
    const rate = `${Math.round((speed - 1) * 100) >= 0 ? '+' : ''}${Math.round((speed - 1) * 100)}%`;

    // Request the new starting sentence
    STATE.ws.send(JSON.stringify({
        type: "PREFETCH",
        index: index,
        chapterIndex: STATE.currentChapterIndex,
        text: sentences[index],
        voice: voice,
        rate: rate,
        pitch: pitch,
        volume: volume,
        numWorkers: STATE.settings.numWorkers,
        sessionId: currentSessionId
    }));

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
    document.querySelectorAll('.chunk-text').forEach(el => el.classList.remove('chunk-active'));
    const cur = document.getElementById(`sentence-${index}`);
    if (cur) {
        cur.classList.add('chunk-active');

        // Calculate offset to position sentence approx 10% from top instead of 25% (scrolling further down)
        const container = document.getElementById('text-container');
        const offsetTop = cur.offsetTop;
        const containerHeight = container.offsetHeight;
        const targetScroll = offsetTop - (containerHeight * 0.1);

        container.scrollTo({
            top: targetScroll,
            behavior: 'smooth'
        });
    }

    // Minimap sync
    document.querySelectorAll('.minimap-node').forEach(el => el.classList.remove('minimap-active'));
    const miniNode = document.getElementById(`minimap-node-${index}`);
    if (miniNode) {
        miniNode.classList.add('minimap-active');
        miniNode.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

playBtn.onclick = async () => {
    if (document.getElementById('media-player').classList.contains('minimized-player')) {
        toggleMinimize(false);
        return;
    }
    if (audio.paused) {
        await waitForWebSocket();
        if (STATE.chunkTimings.length === 0) {
            await playFromSentence(STATE.currentSentenceIndex);
        } else {
            audio.play();
        }
    } else {
        audio.pause();
    }
};

audio.onplay = () => {
    STATE.isTransitioning = false;
    STATE.isPlaying = true;
    playBtn.innerHTML = '<i class="fas fa-pause"></i>';
    document.getElementById('status-indicator').innerText = "Streaming";
    if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'playing';
    }
};

audio.onpause = () => {
    STATE.isPlaying = false;
    playBtn.innerHTML = '<i class="fas fa-play ml-1"></i>';
    document.getElementById('status-indicator').innerText = "Paused";
    if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'paused';
    }
    if (!STATE.isTransitioning && !audio.ended) {
        saveProgress(true);
    }
};

async function editTitle() {
    if (!STATE.currentBook || !STATE.user) return;
    const newTitle = prompt("Enter new title for this book:", STATE.currentBook.title);
    if (newTitle && newTitle.trim() !== "" && newTitle !== STATE.currentBook.title) {
        STATE.currentBook.title = newTitle.trim();
        document.getElementById('current-title').innerText = STATE.currentBook.title;
        updateUI(); // Keep player and author tokens in sync

        // Force save with new title
        await saveProgress(true);
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

audio.ontimeupdate = () => {
    const curTime = audio.currentTime || 0;

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
                renderChapter(currentChunk.chapterIndex);

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
                // We need to shift timing offsets as well if we were using timestampOffset, 
                // but standard MSE removal doesn't change current time.
            }
        } catch (e) {
            console.error("Buffer cleanup error:", e);
        }
    }

    // --- Progress Bar Sync ---
    if (STATE.currentBook) {
        const sentences = STATE.currentBook.chapters[STATE.currentChapterIndex].sentences;
        const total = sentences.length;
        const current = STATE.currentSentenceIndex + 1;

        const chunkProgress = (current / total) * 100;
        document.getElementById('progress-bar').style.width = `${chunkProgress}%`;
        document.getElementById('current-time-mock').innerText = `${current} / ${total}`;

        const fmt = (s) => new Date(s * 1000).toISOString().substr(14, 5);
        document.getElementById('time-display').innerText = fmt(curTime);
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

// --- UI Interactions ---
document.getElementById('prev-btn').onclick = () => {
    if (STATE.currentChapterIndex > 0) {
        const prevChap = STATE.currentChapterIndex - 1;
        renderChapter(prevChap);
        playFromSentence(0);
    }
};

document.getElementById('next-btn').onclick = () => {
    if (STATE.currentBook && STATE.currentChapterIndex < STATE.currentBook.chapters.length - 1) {
        const nextChap = STATE.currentChapterIndex + 1;
        renderChapter(nextChap);
        playFromSentence(0);
    }
};

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
document.getElementById('close-toc').onclick = () => {
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
};
document.getElementById('sync-btn').onclick = () => refreshLibrary();
document.getElementById('edit-title-btn').onclick = () => editTitle();

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
if (document.getElementById('fullscreen-btn-desktop')) {
    document.getElementById('fullscreen-btn-desktop').onclick = toggleFullscreen;
}

function updateUI() {
    if (STATE.currentBook) {
        document.getElementById('player-title').innerText = STATE.currentBook.chapters[STATE.currentChapterIndex].title;
        document.getElementById('player-author').innerText = STATE.currentBook.title;
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
        navigator.mediaSession.setActionHandler('play', () => audio.play());
        navigator.mediaSession.setActionHandler('pause', () => audio.pause());
        navigator.mediaSession.setActionHandler('previoustrack', () => {
            const prevIdx = STATE.currentSentenceIndex - 1;
            if (prevIdx >= 0) playFromSentence(prevIdx);
        });
        navigator.mediaSession.setActionHandler('nexttrack', () => {
            const nextIdx = STATE.currentSentenceIndex + 1;
            if (nextIdx < chapter.sentences.length) playFromSentence(nextIdx);
        });

        // Android/Chrome support for jumping chapters
        try {
            navigator.mediaSession.setActionHandler('stop', () => {
                audio.pause();
                STATE.isPlaying = false;
            });
        } catch (e) { }
    }
}

window.addEventListener('pagehide', () => {
    if (STATE.currentBookId) {
        saveProgress(true);
    }
});

// --- Screen Wake Lock API ---
async function requestWakeLock() {
    if ('wakeLock' in navigator) {
        try {
            STATE.wakeLockSentinel = await navigator.wakeLock.request('screen');
            STATE.wakeLockSentinel.addEventListener('release', () => {
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
            if (STATE.ws) {
                STATE.ws.close();
            }

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
        await saveProgress(true);
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
        if (!STATE.isPlaying && STATE.currentBook && !STATE.isTransitioning && !STATE.isDownloading) {
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

    // 1. Save Progress
    if (STATE.user && STATE.currentBookId) {
        document.getElementById('status-indicator').innerText = "Auto-Saving...";
        await saveProgress(true);
    }

    // 2. Cleanup (Disconnect & Clear RAM/ROM)
    await handlePlaybackStall();

    document.getElementById('status-indicator').innerText = "Session Expired (1m Inactivity)";
    document.getElementById('status-indicator').style.color = "#FFB347";
}

async function handlePlaybackStall() {
    console.error("Playback Stalled/Inactivity triggered Emergency Cleanup...");
    STATE.isStalled = true;
    STATE.isPlaying = false;
    audio.pause();

    // 1. Disconnect WebSocket
    if (STATE.ws) {
        STATE.ws.close();
    }

    // 2. Clear RAM (Queues)
    STATE.appendQueue = [];
    STATE.chunkTimings = [];
    STATE.fetchingSet.clear();
    STATE.metadataQueue = [];

    // 3. Clear ROM (MSE Buffer)
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
        document.getElementById('status-indicator').innerText = "Stalled - Clear RAM/ROM";
        document.getElementById('status-indicator').style.color = "#FF5252";
    }

    // reset counters
    STATE.stallCount = 0;
    STATE.pauseCount = 0;

    // Inform user via UI
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