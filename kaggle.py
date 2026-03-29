import gradio as gr
import asyncio
import edge_tts
import os
import re
import base64
import json
import time
import urllib.parse

all_voices = [
    "vi-VN-HoaiMyNeural - Female",
    "vi-VN-NamMinhNeural - Male",
    "en-US-AriaNeural - Female",
    "en-US-GuyNeural - Male"
]

def load_text_from_file(files):
    if not files: return "", ""
    combined_text = []
    def get_filename(f): return os.path.basename(getattr(f, 'orig_name', getattr(f, 'name', str(f))))
    sorted_files = sorted(files, key=get_filename)
    book_name = "Chưa đặt tên"
    try:
        for f in sorted_files:
            path = f.name if hasattr(f, 'name') else f
            book_name = get_filename(f).replace(".txt", "")
            with open(path, "r", encoding="utf-8") as file:
                combined_text.append(file.read().strip())
        return "\n\n".join(combined_text), book_name
    except Exception as e:
        return f"Lỗi khi đọc file: {str(e)}", ""

def parse_chapters(text):
    raw_chapters = re.split(r'={3,}', text)
    chapters = []
    for raw in raw_chapters:
        raw = raw.strip()
        if not raw: continue
        lines = raw.split('\n')
        title = "Chương không tên"
        for line in lines:
            if line.strip():
                title = line.strip()
                break
        chapters.append({'title': title, 'content': raw})
    if not chapters and text.strip():
        chapters.append({'title': "Mở đầu", 'content': text.strip()})
    return chapters

def split_text_into_chunks(text, max_chars=1200):
    chunks = []
    lines = text.replace('\r\n', '\n').split('\n')
    for line in lines:
        line = line.strip()
        if not line: continue
        if len(line) <= max_chars:
            chunks.append(line)
        else:
            sentences = re.split(r'(?<=[.!?])\s+', line)
            temp_chunk = ""
            for sentence in sentences:
                if len(temp_chunk) + len(sentence) > max_chars:
                    if temp_chunk: chunks.append(temp_chunk.strip())
                    temp_chunk = sentence
                else:
                    temp_chunk += " " + sentence if temp_chunk else sentence
            if temp_chunk: chunks.append(temp_chunk.strip())

    valid_chunks = [c for c in chunks if any(char.isalnum() for char in c)]
    return valid_chunks

async def generate_single_audio(chunk_text, voice, rate_str, pitch_str, vol_str):
    communicate = edge_tts.Communicate(text=chunk_text, voice=voice, rate=rate_str, pitch=pitch_str, volume=vol_str)
    audio_data = b""
    duration_100ns = 0
    try:
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_data += chunk["data"]
            elif chunk["type"] == "WordBoundary":
                end_time = chunk["offset"] + chunk["duration"]
                if end_time > duration_100ns:
                    duration_100ns = end_time

        if duration_100ns > 0:
            duration_sec = (duration_100ns / 10_000_000) + 0.15
        else:
            duration_sec = (len(audio_data) / 6000.0) if audio_data else 0.0

        return base64.b64encode(audio_data).decode("utf-8"), duration_sec
    except Exception as e:
        return "", 0.0

def prepare_book_ui(text, book_name, voice_str, rate, pitch, volume, buffer_size_str, custom_book_id="", custom_last_read=0):
    if not text.strip(): return "Văn bản trống", "", {}

    is_cloud_load = bool(custom_book_id)
    book_id = custom_book_id if is_cloud_load else f"book_{int(time.time())}"

    voice = voice_str.split(" - ")[0]
    rate_str = f"{'+' if rate >= 1 else ''}{int((rate - 1) * 100)}%"
    pitch_str = f"{'+' if pitch >= 0 else ''}{pitch}Hz"
    vol_str = f"{'+' if volume >= 0 else ''}{volume}%"

    settings = {"voice": voice, "rate": rate_str, "pitch": pitch_str, "volume": vol_str}
    chapters = parse_chapters(text)

    global_chunks = []
    chunk_id = 0
    content_parts = []

    toc_html = '<div id="toc-container" style="position: relative; max-height: 250px; overflow-y: auto; margin-bottom: 15px; padding-right: 10px; border-radius: 8px; background: rgba(0,0,0,0.2); padding: 10px;">'

    for chap_id, chapter in enumerate(chapters):
        title = chapter['title']
        toc_html += f'''
        <div id="toc-btn-{chap_id}" class="chapter-nav-btn {'active-chap' if chap_id==0 else ''}" onclick="window.playChap({chap_id})">
            <span class="time-badge">Ch {chap_id+1}</span>
            <span>{title}</span>
        </div>
        '''

        content_parts.append(f'<div id="chap-content-{chap_id}" data-start-chunk="{chunk_id}" class="chapter-content {"active-content" if chap_id==0 else ""}">')
        content_parts.append(f'<h3 style="color: #00f2ff; margin-bottom: 20px; border-bottom: 1px dashed rgba(0,242,255,0.3); padding-bottom: 10px;">📖 {title}</h3>')

        chunks = split_text_into_chunks(chapter['content'])
        for chunk_text in chunks:
            global_chunks.append({'id': chunk_id, 'chap_id': chap_id, 'text': chunk_text})
            content_parts.append(f'<span id="chunk-{chunk_id}" class="chunk-text" onclick="window.playChunk({chunk_id})">{chunk_text}</span><br><br>')
            chunk_id += 1

        content_parts.append('</div>')
    toc_html += '</div>'

    css = """
    <style>
        .chunk-text { cursor: pointer; padding: 3px 6px; border-radius: 6px; transition: 0.2s; display: inline; line-height: 1.8; color: #b9cacb; font-size: 16px; position: relative; }
        .chunk-text:hover { background: rgba(0, 150, 255, 0.2); color: #fff; }
        .chunk-active { background: rgba(0, 242, 255, 0.2) !important; color: #fff !important; font-weight: 600; border-left: 3px solid #00f2ff; padding-left: 8px; }
        .chunk-cached { border-bottom: 1px dashed rgba(0, 242, 255, 0.4); }
        .chapter-nav-btn { display: flex; align-items: center; gap: 12px; background: rgba(0, 150, 255, 0.05); border: 1px solid rgba(0, 150, 255, 0.2); padding: 10px 15px; border-radius: 8px; cursor: pointer; color: #e2e8f0; margin-bottom: 8px; transition: 0.2s; font-size: 15px; }
        .chapter-nav-btn:hover { background: rgba(0, 150, 255, 0.2); }
        .chapter-nav-btn.active-chap { background: rgba(0, 242, 255, 0.15); border-color: #00f2ff; font-weight: bold; color: #fff; }
        .time-badge { background: #007bff; color: white; padding: 4px 10px; border-radius: 6px; font-size: 13px; font-weight: bold; font-family: monospace; display: flex; align-items: center; gap: 5px; }
        .chapter-content { display: none; margin-top: 20px; padding: 15px; background: rgba(0,0,0,0.1); border-radius: 10px; }
        .chapter-content.active-content { display: block; animation: fadeIn 0.3s ease-in; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
        #toc-container::-webkit-scrollbar, #text-container::-webkit-scrollbar { width: 6px; }
        #toc-container::-webkit-scrollbar-thumb, #text-container::-webkit-scrollbar-thumb { background: rgba(0, 242, 255, 0.3); border-radius: 3px; }
    </style>
    """

    custom_player_html = f"""
    <div style="background: rgba(10, 25, 47, 0.95); padding: 15px 25px; border-radius: 12px; border: 1px solid rgba(0, 242, 255, 0.3); display: flex; align-items: center; gap: 20px; margin-bottom: 20px; position: sticky; top: 0; z-index: 100; backdrop-filter: blur(10px); box-shadow: 0 5px 20px rgba(0,0,0,0.5);">
        <button id="custom-play-btn" onclick="window.togglePlay()" style="background: linear-gradient(135deg, #00f2ff, #8a2be2); color: #fff; border: none; width: 55px; height: 55px; border-radius: 50%; font-size: 24px; cursor: pointer; display: flex; align-items: center; justify-content: center; box-shadow: 0 0 15px rgba(0, 242, 255, 0.4); transition: 0.2s; flex-shrink: 0;">▶</button>
        <div style="display: flex; flex-direction: column; flex-grow: 1; gap: 5px;">
            <div style="display: flex; justify-content: space-between; font-family: monospace; font-size: 14px;">
                <span id="custom-time-cur" style="color: #00f2ff; font-weight: bold;">Đang khởi tạo Queue...</span>
                <span id="custom-time-tot" style="color: #b9cacb;">Tổng số {chunk_id} Chunks</span>
            </div>
            <input type="range" id="custom-seek-bar" min="0" max="{chunk_id-1}" value="0" step="1" style="width: 100%; height: 8px; border-radius: 4px; cursor: pointer; accent-color: #00f2ff; background: rgba(255,255,255,0.1);" disabled>
        </div>
    </div>
    """

    global_chunks_js = [{'id': c['id'], 'chap_id': c['chap_id']} for c in global_chunks]
    json_data_str = json.dumps(global_chunks_js).replace("'", "&#39;")

    html_parts = [css, custom_player_html, toc_html, '<div id="text-container" style="position: relative; max-height: 500px; overflow-y: auto; padding-right: 10px; scroll-behavior: smooth;">'] + content_parts + ['</div>']
    html_parts.append('<audio id="main-audio" style="display:none;"></audio>')
    html_parts.append(f"<div id='book-data-json' style='display:none;'>{json_data_str}</div>")

    if not is_cloud_load:
        b64_full_text = base64.b64encode(text.encode('utf-8')).decode('utf-8')
        html_parts.append(f"<div id='hidden-full-text' style='display:none;'>{b64_full_text}</div>")

    js_code = f"""
    window.AUDIO_STATE = {{
        chunks: JSON.parse(document.getElementById('book-data-json').textContent),
        cache: {{}},
        bufferSize: '{buffer_size_str}' === 'Toàn bộ' ? 999999 : parseInt('{buffer_size_str}'),
        playingId: -1,
        isPlaying: false,
        fetchQueue: [],

        isFetching: false,
        lastFetchTime: 0,
        currentFetchId: -1,

        book_id: '{book_id}',
        bookTitle: '{book_name}',
        last_read: parseInt('{custom_last_read}'),
        isUploaded: {str(is_cloud_load).lower()},
        lastSyncedId: parseInt('{custom_last_read}')
    }};

    window.uploadBookDataInitial = async function() {{
        if (!window.FS || !window.USER_UID || window.AUDIO_STATE.isUploaded) return;
        try {{
            const fullTextEl = document.getElementById('hidden-full-text');
            if (fullTextEl && fullTextEl.textContent) {{
                const storageRef = window.FS.ref(window.FS.storage, 'users/' + window.USER_UID + '/files/' + window.AUDIO_STATE.book_id + '.txt');
                await window.FS.uploadString(storageRef, fullTextEl.textContent, 'base64');
                fullTextEl.remove();
            }}

            const docRef = window.FS.doc(window.FS.db, "users", window.USER_UID, "progress", window.AUDIO_STATE.book_id);
            await window.FS.setDoc(docRef, {{
                title: window.AUDIO_STATE.bookTitle,
                total_chunks: window.AUDIO_STATE.chunks.length,
                last_read_chunk: 0,
                updated_at: window.FS.serverTimestamp()
            }}, {{ merge: true }});

            window.AUDIO_STATE.isUploaded = true;
            window.loadLibrary();
        }} catch (e) {{ console.error("Lỗi Upload Data:", e); }}
    }};

    window.syncProgressToFirebase = function(id) {{
        if (!window.FS || !window.USER_UID) return;
        if (id === 0 || Math.abs(id - window.AUDIO_STATE.lastSyncedId) >= 10) {{
            const docRef = window.FS.doc(window.FS.db, "users", window.USER_UID, "progress", window.AUDIO_STATE.book_id);
            window.FS.setDoc(docRef, {{
                last_read_chunk: id,
                updated_at: window.FS.serverTimestamp()
            }}, {{ merge: true }}).then(() => {{
                window.AUDIO_STATE.lastSyncedId = id;
            }}).catch(e => console.error("Lỗi đồng bộ:", e));
        }}
    }};

    window.cleanupCache = function(currentId) {{
        for (let key in window.AUDIO_STATE.cache) {{
            let cId = parseInt(key);
            if (cId < currentId - 2 || cId > currentId + window.AUDIO_STATE.bufferSize + 5) {{
                delete window.AUDIO_STATE.cache[cId];
                let el = document.getElementById('chunk-' + cId);
                if(el) el.classList.remove('chunk-cached');
            }}
        }}
    }};

    window.updateQueue = function(targetId) {{
        let needed = [];
        let maxBuffer = Math.min(window.AUDIO_STATE.chunks.length, targetId + window.AUDIO_STATE.bufferSize);
        for(let i = targetId; i < maxBuffer; i++) {{
            if(!window.AUDIO_STATE.cache[i]) needed.push(i);
        }}
        window.AUDIO_STATE.fetchQueue = needed;
        window.processNextInQueue();
    }};

    // ĐÃ TỐI ƯU HOÀN TOÀN: Bỏ truyền ID qua DOM, truyền trực tiếp lên API
    window.processNextInQueue = function() {{
        if(window.AUDIO_STATE.isFetching || window.AUDIO_STATE.fetchQueue.length === 0) {{
            if(window.AUDIO_STATE.fetchQueue.length === 0) document.getElementById('custom-time-cur').innerText = 'Đã tải xong Buffer hiện tại';
            return;
        }}

        window.AUDIO_STATE.isFetching = true;
        let nextId = window.AUDIO_STATE.fetchQueue.shift();

        window.AUDIO_STATE.currentFetchId = nextId;
        window.AUDIO_STATE.lastFetchTime = Date.now();

        document.getElementById('custom-time-cur').innerText = 'Đang tải chunk ' + nextId + '...';

        let reqBtn = document.querySelector('#hidden_req_btn');
        if(reqBtn) {{
            reqBtn.removeAttribute('disabled');
            reqBtn.click();
        }}
    }};

    window.handleChunkResponse = function(jsonStr) {{
        window.AUDIO_STATE.isFetching = false;
        try {{
            let data = JSON.parse(jsonStr);
            if(data.id !== undefined && data.audio) {{
                window.AUDIO_STATE.cache[data.id] = {{ url: "data:audio/mp3;base64," + data.audio, duration: data.duration }};
                let el = document.getElementById('chunk-' + data.id);
                if(el) el.classList.add('chunk-cached');
                if(data.id === window.AUDIO_STATE.playingId && window.AUDIO_STATE.isPlaying) {{
                    let aud = document.getElementById('main-audio');
                    if(aud.paused) window.playChunk(data.id, false);
                }}
            }}
        }} catch(e) {{ console.log("Lỗi parse", e); }}
        window.processNextInQueue();
    }};

    window.playChunk = function(id, userClicked=true) {{
        window.AUDIO_STATE.playingId = id;
        window.AUDIO_STATE.isPlaying = true;
        document.getElementById('custom-play-btn').innerHTML = '⏸';
        document.getElementById('custom-seek-bar').value = id;

        window.highlightUI(id);
        window.cleanupCache(id);

        if(userClicked) window.updateQueue(id);

        window.syncProgressToFirebase(id);

        let aud = document.getElementById('main-audio');
        if(userClicked) {{ aud.play().catch(e => {{}}); }}

        if(window.AUDIO_STATE.cache[id]) {{
            aud.src = window.AUDIO_STATE.cache[id].url;
            aud.play().catch(e=>console.log(e));
        }} else {{
            aud.pause();
            document.getElementById('custom-play-btn').innerHTML = '⏳';
        }}
    }};

    window.playChap = function(chapId) {{
        let contentEl = document.getElementById('chap-content-' + chapId);
        if(contentEl) {{
            let startChunk = parseInt(contentEl.getAttribute('data-start-chunk'));
            if(!isNaN(startChunk)) window.playChunk(startChunk);
        }}
    }};

    window.togglePlay = function() {{
        let aud = document.getElementById('main-audio');
        let btn = document.getElementById('custom-play-btn');
        if(window.AUDIO_STATE.isPlaying && !aud.paused) {{
            aud.pause(); window.AUDIO_STATE.isPlaying = false; btn.innerHTML = '▶';
        }} else {{
            if(window.AUDIO_STATE.playingId < 0) window.AUDIO_STATE.playingId = 0;
            window.playChunk(window.AUDIO_STATE.playingId, false);
        }}
    }};

    window.highlightUI = function(id) {{
        document.querySelectorAll('.chunk-text').forEach(el => el.classList.remove('chunk-active'));
        let cur = document.getElementById('chunk-' + id);
        if(cur) {{
            cur.classList.add('chunk-active');
            let textContainer = document.getElementById('text-container');
            if(textContainer) {{
                textContainer.scrollTo({{top: cur.offsetTop - 50, behavior: 'smooth'}});
            }}

            let chapId = window.AUDIO_STATE.chunks[id].chap_id;
            document.querySelectorAll('.chapter-content').forEach(el => el.classList.remove('active-content'));
            document.querySelectorAll('.chapter-nav-btn').forEach(el => el.classList.remove('active-chap'));

            let chapCont = document.getElementById('chap-content-' + chapId);
            if(chapCont) chapCont.classList.add('active-content');

            let btnEl = document.getElementById('toc-btn-' + chapId);
            if(btnEl) {{
                btnEl.classList.add('active-chap');
                let tocContainer = document.getElementById('toc-container');
                if (tocContainer) {{
                    tocContainer.scrollTo({{top: btnEl.offsetTop - 20, behavior: 'smooth'}});
                }}
            }}
        }}
    }};

    // ĐÃ TỐI ƯU CƠ CHẾ CHỐNG NGỦ ĐÔNG BẰNG AUDIO HEARTBEAT
    document.getElementById('main-audio').ontimeupdate = function() {{
        let now = Date.now();
        if (window.AUDIO_STATE.isFetching && (now - window.AUDIO_STATE.lastFetchTime > 12000)) {{
            console.log("Tab ngủ đông gây kẹt. Đang reset...");
            window.AUDIO_STATE.isFetching = false;
            if(!window.AUDIO_STATE.cache[window.AUDIO_STATE.currentFetchId]) {{
                window.AUDIO_STATE.fetchQueue.unshift(window.AUDIO_STATE.currentFetchId);
            }}
        }}

        if (!window.AUDIO_STATE.isFetching && window.AUDIO_STATE.fetchQueue.length > 0) {{
            window.processNextInQueue();
        }}
    }};

    document.getElementById('main-audio').onended = () => {{
        let nextId = window.AUDIO_STATE.playingId + 1;
        if(nextId < window.AUDIO_STATE.chunks.length) {{
            window.playChunk(nextId, false);
            window.updateQueue(nextId);
        }} else {{
            document.getElementById('custom-play-btn').innerHTML = '▶';
            window.AUDIO_STATE.isPlaying = false;
        }}
    }};

    if (!window.AUDIO_STATE.isUploaded) {{
        setTimeout(window.uploadBookDataInitial, 1500);
    }}

    function autoStartPlayer() {{
        let reqBtn = document.querySelector('#hidden_req_btn');
        if (reqBtn && !reqBtn.disabled) {{
            let targetId = window.AUDIO_STATE.last_read > 0 ? window.AUDIO_STATE.last_read : 0;

            window.playChunk(targetId, false);
            window.updateQueue(targetId);

            setTimeout(() => {{
                window.highlightUI(targetId);
                if (window.AUDIO_STATE.isUploaded) {{
                    document.getElementById('custom-play-btn').scrollIntoView({{behavior: 'smooth', block: 'center'}});
                }}
            }}, 600);

        }} else {{
            setTimeout(autoStartPlayer, 500);
        }}
    }}

    setTimeout(autoStartPlayer, 500);
    """

    js_encoded = urllib.parse.quote(js_code)
    img_hack = f'<img src="invalid_url" style="display:none;" onerror="eval(decodeURIComponent(\'{js_encoded}\')); this.remove();">'
    html_parts.append(img_hack)

    state_data = {"chunks": global_chunks, "settings": settings, "book_id": book_id}
    msg = f"🚀 Khởi tạo Sách thành công! Có {len(global_chunks)} chunks."
    return msg, "\n".join(html_parts), state_data

def prepare_book_ui_cloud(text, title, voice, speed, pitch, volume, buffer_str, book_id, last_read_str):
    try: last_r = int(last_read_str)
    except: last_r = 0
    return prepare_book_ui(text, title, voice, speed, pitch, volume, buffer_str, book_id, last_r)

async def process_chunk_request(req_id_str, state_data):
    if not req_id_str or not state_data or not state_data.get("chunks"): return json.dumps({"error": "invalid"})
    try:
        cid = int(req_id_str)
        chunk = state_data["chunks"][cid]
        settings = state_data["settings"]
        audio_b64, duration = await generate_single_audio(chunk["text"], settings["voice"], settings["rate"], settings["pitch"], settings["volume"])
        res = {"id": cid, "audio": audio_b64, "duration": duration, "_t": time.time()}
        return json.dumps(res)
    except Exception as e:
        return json.dumps({"error": str(e), "_t": time.time()})

custom_css = ".hidden-gradio-element { display: none !important; }"

global_firebase_js = """
if (!window.FIREBASE_GLOBAL_INITED) {
    window.FIREBASE_GLOBAL_INITED = true;

    (async () => {
        const firebaseConfig = {
            apiKey: '{{FIREBASE_API_KEY}}',
            authDomain: '{{FIREBASE_AUTH_DOMAIN}}',
            projectId: '{{FIREBASE_PROJECT_ID}}',
            storageBucket: '{{FIREBASE_STORAGE_BUCKET}}',
            messagingSenderId: '{{FIREBASE_MESSAGING_SENDER_ID}}',
            appId: '{{FIREBASE_APP_ID}}',
            measurementId: '{{FIREBASE_MEASUREMENT_ID}}'
        };

        try {
            const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js');
            const { getFirestore, collection, getDocs, doc, setDoc, serverTimestamp } = await import('https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js');
            const { getStorage, ref, uploadString, getDownloadURL } = await import('https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js');
            const { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut } = await import('https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js');

            const app = initializeApp(firebaseConfig);
            window.FS = {
                db: getFirestore(app), storage: getStorage(app), auth: getAuth(app),
                provider: new GoogleAuthProvider(), collection, getDocs, doc, setDoc, serverTimestamp, ref, uploadString, getDownloadURL, signInWithPopup, signOut
            };

            onAuthStateChanged(window.FS.auth, (user) => {
                const info = document.getElementById('global-auth-info');
                const btnIn = document.getElementById('global-btn-login');
                const btnOut = document.getElementById('global-btn-logout');
                if (user) {
                    window.USER_UID = user.uid;
                    if(info) info.innerText = '👤 Xin chào, ' + user.displayName;
                    if(btnIn) btnIn.style.display = 'none';
                    if(btnOut) btnOut.style.display = 'inline-block';
                    window.loadLibrary();
                } else {
                    window.USER_UID = null;
                    if(info) info.innerText = 'Vui lòng đăng nhập';
                    if(btnIn) btnIn.style.display = 'inline-block';
                    if(btnOut) btnOut.style.display = 'none';
                    const libView = document.getElementById('my-library-view');
                    if (libView) libView.innerHTML = 'Vui lòng đăng nhập Google ở góc trên để xem thư viện cá nhân của bạn.';
                }
            });
        } catch(e) {
            console.error('Lỗi Firebase Init:', e);
            document.getElementById('global-auth-info').innerText = '❌ Lỗi kết nối Firebase (Nhấn F12 xem chi tiết)';
        }
    })();

    window.signInGoogle = function() {
        if (!window.FS) return alert("Firebase chưa tải xong, vui lòng đợi vài giây!");
        window.FS.signInWithPopup(window.FS.auth, window.FS.provider).catch(e => {
            console.error(e);
            alert("Lỗi đăng nhập: " + e.message + "\\n\\n(Có thể do bạn chưa thêm miền gradio.live vào Authorized domains trên Firebase)");
        });
    };

    window.signOutGoogle = function() { window.FS.signOut(window.FS.auth); window.location.reload(); };

    window.loadLibrary = async function() {
        if (!window.FS || !window.USER_UID) return;
        const libView = document.getElementById('my-library-view');
        libView.innerHTML = '<i>Đang tải thư viện đám mây...</i>';
        try {
            const snap = await window.FS.getDocs(window.FS.collection(window.FS.db, 'users', window.USER_UID, 'progress'));
            if (snap.empty) {
                libView.innerHTML = '<b>Thư viện của bạn đang trống! Hãy tải file .txt lên ở Tab bên cạnh.</b>';
                return;
            }
            let html = `<div style='display:flex; gap:15px; flex-wrap:wrap;'>`;
            snap.forEach(doc => {
                let d = doc.data();

                let safeTitle = d.title || "Sách không tên";
                let safeLastRead = d.last_read_chunk || 0;
                let safeTotal = d.total_chunks || 0;

                html += `
                <div style='background:rgba(0,150,255,0.05); padding:15px; border-radius:10px; border:1px solid rgba(0,242,255,0.3); width: 220px;'>
                    <h3 style='margin-top:0; color:#fff; font-size:16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;' title='${safeTitle}'>${safeTitle}</h3>
                    <p style='color:#b9cacb; font-size:13px; margin-bottom:15px;'>Đọc tới: chunk ${safeLastRead} / ${safeTotal}</p>
                    <button onclick="window.loadCloudBook('${doc.id}', '${safeTitle.replace(/'/g, "\\'")}', ${safeLastRead})" style='background:#00f2ff; color:#000; border:none; padding:8px 15px; border-radius:6px; cursor:pointer; font-weight:bold; width:100%;'>Đọc tiếp 🚀</button>
                </div>`;
            });
            html += `</div>`;
            libView.innerHTML = html;
        } catch(e) { libView.innerHTML = 'Lỗi: ' + e.message; }
    };

    window.loadCloudBook = async function(bookId, title, lastRead) {
        if (!window.FS || !window.USER_UID) return;
        const btn = event.target;
        const oldText = btn.innerText;
        btn.innerText = 'Đang tải mây... ☁️';
        btn.disabled = true;

        try {
            const sRef = window.FS.ref(window.FS.storage, 'users/' + window.USER_UID + '/files/' + bookId + '.txt');
            const url = await window.FS.getDownloadURL(sRef);
            const response = await fetch(url);
            const text = await response.text();

            let txtEl = document.querySelector('#hidden_cloud_text textarea') || document.querySelector('#hidden_cloud_text input');
            let titleEl = document.querySelector('#hidden_cloud_title input') || document.querySelector('#hidden_cloud_title textarea');
            let idEl = document.querySelector('#hidden_cloud_id input') || document.querySelector('#hidden_cloud_id textarea');
            let lastEl = document.querySelector('#hidden_cloud_last input') || document.querySelector('#hidden_cloud_last textarea');
            let triggerBtn = document.querySelector('#hidden_cloud_btn');

            let setVal = (el, v) => {
                if (!el) return;
                let p = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
                let s = Object.getOwnPropertyDescriptor(p, 'value')?.set;
                if(s) {
                    s.call(el, v);
                } else {
                    el.value = v;
                }
                el.dispatchEvent(new Event('input', {bubbles:true}));
            };

            setVal(txtEl, text);
            setVal(titleEl, title);
            setVal(idEl, bookId);
            setVal(lastEl, lastRead.toString());

            if (triggerBtn) {
                setTimeout(() => triggerBtn.click(), 100);
            }

        } catch (e) { alert('Lỗi tải sách từ đám mây: ' + e.message); }

        btn.innerText = oldText;
        btn.disabled = false;
    };

    window.addEventListener('beforeunload', function() {
        if (window.FS && window.USER_UID && window.AUDIO_STATE && window.AUDIO_STATE.playingId > 0) {
            if (window.AUDIO_STATE.playingId !== window.AUDIO_STATE.lastSyncedId) {
                const dRef = window.FS.doc(window.FS.db, 'users', window.USER_UID, 'progress', window.AUDIO_STATE.book_id);
                window.FS.setDoc(dRef, { last_read_chunk: window.AUDIO_STATE.playingId, updated_at: window.FS.serverTimestamp() }, { merge: true });
            }
        }
    });
}
"""
firebase_vars = {
    "FIREBASE_API_KEY": os.getenv("FIREBASE_API_KEY", ""),
    "FIREBASE_AUTH_DOMAIN": os.getenv("FIREBASE_AUTH_DOMAIN", ""),
    "FIREBASE_PROJECT_ID": os.getenv("FIREBASE_PROJECT_ID", ""),
    "FIREBASE_STORAGE_BUCKET": os.getenv("FIREBASE_STORAGE_BUCKET", ""),
    "FIREBASE_MESSAGING_SENDER_ID": os.getenv("FIREBASE_MESSAGING_SENDER_ID", ""),
    "FIREBASE_APP_ID": os.getenv("FIREBASE_APP_ID", ""),
    "FIREBASE_MEASUREMENT_ID": os.getenv("FIREBASE_MEASUREMENT_ID", "")
}

for k, v in firebase_vars.items():
    global_firebase_js = global_firebase_js.replace(f"{{{{{k}}}}}", v)

global_js_encoded = urllib.parse.quote(global_firebase_js)

global_firebase_init_html = f"""
<div id="global-auth-bar" style="background: rgba(10,25,47,0.95); padding: 15px 25px; border-radius: 12px; border: 1px solid rgba(0,242,255,0.3); display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
    <div>
        <span style="font-size:18px; font-weight:bold; color:#fff;">📚 Kho Sách Nói Cá Nhân Đám Mây</span>
    </div>
    <div>
        <span id="global-auth-info" style="color:#b9cacb; margin-right: 15px;">⏳ Đang tải module kết nối...</span>
        <button id="global-btn-login" onclick="window.signInGoogle()" style="background:#4285F4; color:#fff; border:none; padding:8px 15px; border-radius:6px; cursor:pointer; font-weight:bold; display:none;">Đăng nhập Google</button>
        <button id="global-btn-logout" onclick="window.signOutGoogle()" style="background:rgba(255,255,255,0.1); color:#fff; border:none; padding:8px 15px; border-radius:6px; cursor:pointer; display:none;">Đăng xuất</button>
    </div>
</div>

<img src="x" style="display:none;" onerror="
    try {{
        let script = document.createElement('script');
        script.type = 'module';
        script.innerHTML = decodeURIComponent('{global_js_encoded}');
        document.body.appendChild(script);
        this.remove();
    }} catch(e) {{
        console.error(e);
    }}
">
"""

with gr.Blocks(theme=gr.themes.Soft(), css=custom_css) as demo:

    gr.HTML(global_firebase_init_html)

    with gr.Tabs():
        with gr.Tab("☁️ Thư viện của tôi"):
            gr.HTML("<div id='my-library-view'>Vui lòng đăng nhập để xem thư viện...</div>")
            btn_refresh = gr.Button("🔄 Cập nhật thư viện", size="sm")
            btn_refresh.click(None, None, None, js="() => { window.loadLibrary(); return []; }")

        with gr.Tab("📁 Tải sách mới từ máy"):
            with gr.Row():
                with gr.Column(scale=2):
                    file_upload = gr.File(label="Kéo thả tệp .txt vào đây", file_types=[".txt"], file_count="multiple")
                    input_title = gr.Textbox(label="Tên Sách (Lấy tự động)", interactive=False)
                    input_text = gr.Textbox(label="Nội dung văn bản", placeholder="Cắt chương bằng ======...", lines=5)

                with gr.Column(scale=1):
                    voice_dropdown = gr.Dropdown(choices=all_voices, label="Chọn giọng", value="vi-VN-HoaiMyNeural - Female")
                    buffer_dropdown = gr.Dropdown(choices=["5", "10", "25", "50"], value="5", label="Mốc tải (Buffer)")
                    speed_slider = gr.Slider(0.5, 2.0, value=1.0, step=0.1, label="Tốc độ")
                    pitch_slider = gr.Slider(-50, 50, value=0, step=1, label="Cao độ (Pitch)")
                    volume_slider = gr.Slider(-100, 100, value=0, step=1, label="Âm lượng (%)")
                    btn_generate = gr.Button("⚡ Bắt đầu Đọc E-book mới", variant="primary")
                    status_text = gr.Textbox(label="Trạng thái", interactive=False, elem_id="status-box")

    gr.Markdown("---")
    timestamp_html = gr.HTML(label="Trình Phát Audio")

    state_data = gr.State({})
    hidden_req_id = gr.Textbox(elem_id="hidden_req_id", elem_classes="hidden-gradio-element")
    hidden_req_btn = gr.Button("Trigger", elem_id="hidden_req_btn", elem_classes="hidden-gradio-element")
    hidden_res_data = gr.Textbox(elem_id="hidden_res_data", elem_classes="hidden-gradio-element")

    hidden_cloud_text = gr.Textbox(elem_id="hidden_cloud_text", elem_classes="hidden-gradio-element")
    hidden_cloud_title = gr.Textbox(elem_id="hidden_cloud_title", elem_classes="hidden-gradio-element")
    hidden_cloud_id = gr.Textbox(elem_id="hidden_cloud_id", elem_classes="hidden-gradio-element")
    hidden_cloud_last = gr.Textbox(elem_id="hidden_cloud_last", elem_classes="hidden-gradio-element")
    hidden_cloud_btn = gr.Button("LoadCloud", elem_id="hidden_cloud_btn", elem_classes="hidden-gradio-element")

    file_upload.change(fn=load_text_from_file, inputs=[file_upload], outputs=[input_text, input_title])

    btn_generate.click(
        fn=prepare_book_ui,
        inputs=[input_text, input_title, voice_dropdown, speed_slider, pitch_slider, volume_slider, buffer_dropdown],
        outputs=[status_text, timestamp_html, state_data]
    )

    hidden_cloud_btn.click(
        fn=prepare_book_ui_cloud,
        inputs=[hidden_cloud_text, hidden_cloud_title, voice_dropdown, speed_slider, pitch_slider, volume_slider, buffer_dropdown, hidden_cloud_id, hidden_cloud_last],
        outputs=[status_text, timestamp_html, state_data]
    )

    # ĐÃ SỬA CẤU TRÚC GỌI API ĐỂ TRÁNH HOÀN TOÀN BỊ ĐÓNG BĂNG KHI TAB ẨN
    hidden_req_btn.click(
        fn=process_chunk_request,
        inputs=[hidden_req_id, state_data],
        outputs=[hidden_res_data],
        js="(dummy_id, state) => { return [window.AUDIO_STATE.currentFetchId.toString(), state]; }"
    ).then(
        fn=None,
        inputs=[hidden_res_data],
        outputs=[],
        js="(val) => { if(val) window.handleChunkResponse(val); return []; }"
    )

demo.launch(share=True)