// Firebase Modules
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc, serverTimestamp, collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { getStorage, ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";

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
    wakeLockSentinel: null
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
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    STATE.ws = new WebSocket(wsUrl);

    STATE.ws.onopen = () => {
        console.log("Connected to WebSocket");
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
            // Lấy Metadata tương ứng (cũ nhất trong Queue) ra để ghép cặp
            const currentMetadata = STATE.metadataQueue.shift();

            if (!currentMetadata || (currentMetadata.sessionId && currentMetadata.sessionId !== STATE.sessionId)) {
                console.log("Ignoring old/orphaned binary data (mismatched Session ID)");
                return;
            }

            const arrayBuffer = await event.data.arrayBuffer();

            // Đẩy vào hàng đợi nối audio (Append Queue)
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
        console.log("WebSocket Disconnected. Reconnecting...");
        setTimeout(initWebSocket, 3000);
    };
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

        querySnapshot.forEach((doc) => {
            const data = doc.data();
            const bookId = doc.id;
            const progress = (data.last_read_chunk / data.total_chunks * 100).toFixed(1);

            const div = document.createElement('div');
            div.className = 'glass p-3 flex flex-col gap-1 cursor-pointer hover:bg-primary/5 transition-all group border-l-2 border-transparent hover:border-primary';
            div.innerHTML = `
                <div class="flex items-center justify-between">
                    <span class="text-sm font-bold text-white group-hover:text-primary transition-colors line-clamp-1">${data.title}</span>
                    <span class="text-[10px] text-primary font-mono">${progress}%</span>
                </div>
                <div class="w-full bg-slate-800 h-1 rounded-full overflow-hidden">
                    <div class="bg-primary h-full transition-all duration-500" style="width: ${progress}%"></div>
                </div>
            `;
            div.onclick = () => loadBookFromStorage(bookId, data);
            bookList.appendChild(div);
        });
    } catch (err) {
        console.error("Library Refresh Error:", err);
        bookList.innerHTML = '<div class="text-center p-8 text-red-400 italic text-sm">Error updating library.</div>';
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
    STATE.currentBook.chapters.forEach((chap, i) => {
        const div = document.createElement('div');
        const isActive = i === STATE.currentChapterIndex;
        div.id = `toc-item-${i}`;
        div.className = `p-4 glass hover:bg-primary/10 cursor-pointer transition-colors ${isActive ? 'border-l-4 border-primary bg-primary/10 font-bold text-white' : ''}`;
        div.innerHTML = `<span class="text-primary font-bold mr-4">${i + 1}</span> ${chap.title}`;
        div.onclick = () => {
            renderChapter(i);
            // Properly revoke all old blobs before clearing
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
            console.warn("WebSocket is dead. Reconnecting...");
            initWebSocket();
            setTimeout(() => prefetchNext(startChapter, startSentence, count), 1000);
            return;
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
    if (!STATE.currentBook || !STATE.ws) return;
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

playBtn.onclick = () => {
    if (document.getElementById('media-player').classList.contains('minimized-player')) {
        toggleMinimize(false);
        return;
    }
    if (audio.paused) {
        if (STATE.chunkTimings.length === 0) playFromSentence(STATE.currentSentenceIndex);
        else audio.play();
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
    document.getElementById('toc-overlay').classList.remove('translate-x-full');
    renderTOC(); // Re-render to ensure active state is correct
    setTimeout(scrollTOCCurrentChapter, 300);
};
document.getElementById('close-toc').onclick = () => document.getElementById('toc-overlay').classList.add('translate-x-full');
document.getElementById('sync-btn').onclick = () => refreshLibrary();
document.getElementById('edit-title-btn').onclick = () => editTitle();

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