# Kế hoạch: Mini Player Widget (kiểu YouTube) cho Cloud TTS Reader

> **Mục đích của file này**: đây là tài liệu ngữ cảnh (context) đầy đủ để bàn giao cho một AI/dev khác triển khai tính năng "widget thu nhỏ giống YouTube" cho web app Cloud TTS Reader, mà không cần phải hỏi lại quá nhiều. File này mô tả hiện trạng codebase thực tế (đã đọc trực tiếp source), vấn đề cần giải quyết, đề xuất kiến trúc, và checklist thực thi theo từng giai đoạn.
>
> **Ngày viết**: 2026-07-06
> **Trạng thái**: Đề xuất (chưa code) — cần review/chốt các mục "Câu hỏi mở" ở cuối file trước khi bắt tay code.

---

## 1. Bối cảnh dự án (đã xác minh trong code)

Cloud TTS Reader là web app đọc sách bằng giọng đọc AI (Microsoft Edge TTS), kiến trúc:

| Layer | Công nghệ | File chính |
|---|---|---|
| Backend | FastAPI (Python), WebSocket streaming TTS | [main.py](Cloud_TTS_Reader/main.py) |
| Frontend | Vanilla JS (ES Modules, chưa modular hóa xong), Tailwind CSS v4 | [static/index.html](Cloud_TTS_Reader/static/index.html), [static/app.js](Cloud_TTS_Reader/static/app.js) |
| Audio | Media Source Extensions (MSE), WebSocket + prefetch queue | `app.js` (audio engine nằm chung file, chưa tách riêng `audio-engine.js` như README mô tả) |
| Auth/DB | Firebase Auth + Firestore (đồng bộ tiến trình đọc) | `firebase-config.js` |
| PWA | Service Worker + manifest | `sw.js`, `manifest.json` |

Ghi chú quan trọng: [FRONTEND_REFACTOR_PLAN.md](Cloud_TTS_Reader/static/FRONTEND_REFACTOR_PLAN.md) đã đề ra việc tách `app.js`/`index.html` thành module nhỏ (`static/js/modules/...`, `static/css/...`) nhưng **chưa được thực thi** — các thư mục `static/js/modules/` và `static/css/` hiện đang rỗng, toàn bộ logic vẫn nằm trong 1 file `app.js` (~169KB) và 1 file `index.html` (~102KB, nhiều CSS/JS inline). Kế hoạch mini-player này **không phụ thuộc** vào việc refactor đó, nhưng nên viết code mới theo dạng tách file độc lập (xem mục 6.1) để không làm phình thêm file monolith và để dễ dời sang cấu trúc module sau này.

### 1.1. Trình phát (player) hiện tại hoạt động thế nào

- Player là `<footer id="media-player">` nằm **bên trong** `<section id="reader-container">` (index.html:1062, footer ở dòng 1270), được bọc bởi 1 div `absolute bottom-6 ... z-[50]` — nghĩa là nó **không phải `position: fixed` toàn viewport**, mà chỉ "nổi" bên trong khu vực đọc sách. Comment trong code ghi rõ: `"Bottom Media Player Controls: Floating Glass Artifact (Now Local to Reader)"`.
- Đã có sẵn cơ chế **"minimize" hiện tại** (`toggleMinimize()` trong app.js:3145): khi bật, player co lại thành 1 nút play tròn nổi ở giữa, ẩn thanh tiến trình/tên sách (CSS `.minimized-player` trong index.html:522-572). Đây **chỉ là thu gọn chiều cao trong cùng vị trí**, không phải kéo-thả tự do, không di chuyển góc màn hình, và **biến mất hoàn toàn** khi rời khỏi Reader view.
- Đã có tích hợp **Media Session API** (`navigator.mediaSession`, app.js:3320-3366): metadata, play/pause/prev/next/seek/stop handlers đã hoạt động — đây là API cho phép hệ điều hành/trình duyệt hiện nút điều khiển trên lock screen, thanh media của Windows/Android, tai nghe bluetooth, v.v. **Tận dụng lại phần này**, không viết lại.
- Đã có Wake Lock API (giữ màn hình sáng khi phát) và xử lý `visibilitychange` (app.js:3757) để audio tiếp tục khi tab ở background.

### 1.2. Vấn đề cốt lõi cần giải quyết (đã xác minh, đây là gốc rễ của yêu cầu)

Khi người dùng mở "Discovery/Library" (khu vực duyệt sách toàn màn hình, `<section id="discovery-mode">`), hàm `toggleDiscoveryMode(true)` (app.js:334-355) làm **2 việc**:

1. Ẩn hoàn toàn `#reader-container` → **player biến mất khỏi màn hình**, người dùng không còn thấy nút play/pause/tên sách nào cả.
2. Gọi `resetAudioEngine()` (app.js:551) → **chủ động dừng phát nhạc, hủy WebSocket session, xóa buffer MSE, tăng `sessionId` để loại bỏ mọi message WebSocket đang bay tới**. Đây không phải bug — là hành vi **được thiết kế có chủ đích** (có thể vì lý do tài nguyên: mỗi phiên đọc chiếm 1 WebSocket + nhiều worker TTS phía server).

→ Kết quả: hiện tại, Cloud TTS Reader **không hề có khái niệm "vừa phát vừa điều hướng sang view khác"**. Đây chính là khoảng cách với YouTube: trên YouTube, khi bạn rời trang video để lướt trang chủ, video vẫn tiếp tục phát trong 1 khung nhỏ nổi ở góc màn hình, kéo-thả được, và bạn vẫn điều khiển được play/pause/next từ đó.

Đây là lý do cần tách kế hoạch thành **nhiều tier (giai đoạn)** theo mức độ thay đổi kiến trúc audio-engine, không chỉ là thêm 1 component UI.

---

## 2. Tầm nhìn sản phẩm (UX mục tiêu)

Mô tả hành vi mong muốn, tham chiếu trực tiếp UX của YouTube (mobile app / web mini-player):

1. Người dùng đang nghe sách ở Reader view, bấm nút thu nhỏ (hoặc tự động khi điều hướng sang Discovery/Library, hoặc cuộn ra khỏi khu vực đọc).
2. Player chính co lại thành **1 widget nhỏ hình chữ nhật/viên thuốc (pill)**, nổi đè lên mọi nội dung khác (`position: fixed`, z-index cao), mặc định neo ở góc dưới-phải (desktop) hoặc full-width sát trên thanh điều hướng dưới (mobile — giống YouTube app).
3. Widget hiển thị tối thiểu: ảnh bìa/icon sách, tên chương/câu hiện tại (rút gọn), nút play/pause, nút đóng (X), thanh tiến trình mỏng ở viền dưới.
4. **Kéo-thả tự do** (drag) bằng chuột/ngón tay để đổi vị trí; khi thả tay, tự "hít" (snap) vào góc màn hình gần nhất.
5. Bấm vào thân widget (trừ nút play/close) → mở lại Reader view + player full-size, tại đúng vị trí đang đọc.
6. Bấm nút X → dừng phát hẳn (stop), đóng widget, giải phóng tài nguyên audio (gọi `resetAudioEngine()`).
7. Audio **tiếp tục phát liên tục**, không bị ngắt/giật, trong suốt quá trình chuyển từ Reader → Discovery → Reader (đây là thay đổi kiến trúc lớn nhất, xem Tier 2).
8. (Nâng cao – tuỳ chọn) Nút "Picture-in-Picture" thật của trình duyệt, để widget nổi ra **ngoài cả tab/cửa sổ trình duyệt** — giống nút PiP (2 hình chữ nhật lồng nhau) mà YouTube có trên web.

---

## 3. Đề xuất chia giai đoạn (Tiers) — quan trọng, đọc kỹ trước khi code

### Tier 1 — Floating widget nội bộ, KHÔNG đổi audio-engine (an toàn, làm trước)

- Phạm vi: widget chỉ xuất hiện khi **vẫn đang ở Reader view** (thay thế/nâng cấp cơ chế `toggleMinimize()` hiện tại): thay vì co player thành nút tròn giữa màn hình, cho phép **kéo-thả** nó thành 1 widget nổi ở góc, và giữ nguyên hành vi "biến mất khi vào Discovery" như hiện tại (không đổi `toggleDiscoveryMode`/`resetAudioEngine`).
- Cũng áp dụng cho trường hợp mở TOC overlay (`STATE.tocAutoMinimized`, app.js:3114-3120) — đã có logic auto-minimize khi mở TOC, giờ chỉ cần đổi UI từ "nút tròn giữa" thành "widget góc màn hình kéo-thả được".
- **Không đụng vào WebSocket/MSE/resetAudioEngine** → rủi ro kỹ thuật thấp, làm nhanh, có thể ship riêng.
- Hạn chế: chưa giải quyết được vấn đề cốt lõi ở mục 1.2 (mất player khi vào Discovery/Library).

### Tier 2 — Player "sống sót" qua điều hướng SPA (Discovery/Library), giống YouTube thật sự

- Đây là phần khó và là trọng tâm thực sự của yêu cầu "giống YouTube".
- Thay đổi bắt buộc:
  - Sửa `toggleDiscoveryMode(true)` (app.js:334-355): **không** gọi `resetAudioEngine()` nếu người dùng chỉ đang "ghé qua" Discovery trong khi vẫn nghe sách hiện tại. Chỉ `resetAudioEngine()` khi người dùng thực sự mở 1 cuốn sách khác hoặc bấm nút đóng widget.
  - Widget mini-player phải được render **ngoài** `#reader-container` (ví dụ gắn thẳng vào `<body>`), để không bị ẩn theo khi `readerContainer.classList.add('hidden')`.
  - `audio` element, WebSocket, MSE `SourceBuffer` phải là **singleton toàn cục** (đã là vậy — `audio`, `STATE` hiện là biến module-level trong app.js) và không được cleanup khi chuyển view — chỉ UI ẩn/hiện, không đụng tới audio engine.
  - Cần audit các đoạn code khác đang giả định "rời Reader = dừng phát" (ví dụ code đóng sidebar, đóng modal sách...) để đảm bảo không có chỗ nào khác âm thầm gọi `resetAudioEngine()` ngoài ý muốn.
- Lợi ích: đúng với kỳ vọng UX "giống YouTube" — nghe sách trong khi duyệt thư viện tìm sách tiếp theo.
- Rủi ro: cần đánh giá lại lý do ban đầu team thiết kế `resetAudioEngine()` khi vào Discovery (khả năng là để tiết kiệm tài nguyên WebSocket/worker phía server — xem [main.py](Cloud_TTS_Reader/main.py) phần quản lý session/worker trước khi đổi). Nên trao đổi/xác nhận với người hiểu backend trước khi bỏ dòng này.

### Tier 3 — Document Picture-in-Picture API thật (BẮT BUỘC — đã chốt 2026-07-06)

- Dùng `window.documentPictureInPicture` (Chrome/Edge ≥ 116) để mở 1 cửa sổ PiP thật sự chứa DOM tuỳ ý (không chỉ `<video>`), nổi ra ngoài cả tab/trình duyệt, y hệt nút PiP của YouTube.
- Làm sau khi Tier 1 + Tier 2 ổn định, vì đây là lớp UI thêm vào, dùng chung state với widget nội bộ.
- Bắt buộc có fallback: kiểm tra `'documentPictureInPicture' in window` — Firefox/Safari chưa hỗ trợ → ẩn nút này, chỉ dùng widget nội bộ (Tier 1/2).

**Quyết định đã chốt (2026-07-06)**: cả 3 Tier đều BẮT BUỘC. Thứ tự thực thi: Tier 1 → Tier 2 → Tier 3, trên branch riêng `feature/mini-player-widget` để không đụng `main`.

---

## 4. Kiến trúc kỹ thuật chi tiết

### 4.1. Cấu trúc file mới (không viết thêm vào app.js monolith)

```
static/
├── js/
│   └── mini-player-widget.js   (MỚI — toàn bộ logic widget: render, drag, snap, sync state)
├── css/
│   └── mini-player.css         (MỚI — style widget, animation, responsive)
└── index.html                  (sửa: thêm <link> css mới, <script type="module" src="js/mini-player-widget.js" defer>,
                                  và 1 block HTML mới cho #mini-player-widget, đặt làm con trực tiếp của <body>,
                                  KHÔNG lồng trong #reader-container)
```

Lý do tách file riêng thay vì nhét vào `app.js`: (a) `app.js` đã 169KB, thêm code mới vào sẽ càng khó bảo trì; (b) đúng tinh thần của `FRONTEND_REFACTOR_PLAN.md` đã có sẵn trong repo (dù chưa thực thi, nhưng định hướng là tách module); (c) dễ rollback/tắt tính năng nếu cần — chỉ cần bỏ 2 dòng include trong `index.html`.

`mini-player-widget.js` sẽ **import/tái sử dụng** các hàm và biến toàn cục hiện có trong `app.js` (`STATE`, `audio`, `toggleMinimize`, hàm cập nhật tiến trình/tên sách hiện có) — cần rà lại xem các biến này có được `export` hay là biến global gắn trên `window` (hiện tại app.js không dùng ES module export/import rõ ràng, nhiều khả năng là script thường với biến ở top-level scope). Nếu vậy, `mini-player-widget.js` có thể cần load như **script thường** (không `type="module"`) và đọc trực tiếp `window.STATE`, hoặc cần refactor nhỏ để expose 1 vài hàm cần thiết (`STATE`, `getPlayerSnapshot()`, `togglePlayPause()`) qua `window`.

> Việc đầu tiên khi bắt tay code: xác nhận `app.js` được load kiểu gì (`<script src="app.js">` thường hay `type="module"`) để quyết định cách chia sẻ state với file mới. (Xem `index.html`, thẻ `<script>` load app.js, cuối file.)

### 4.2. HTML khung sườn cho widget (đề xuất)

```html
<div id="mini-player-widget"
     class="fixed z-[999] hidden select-none touch-none"
     style="left: var(--mpw-x, auto); top: var(--mpw-y, auto); right: var(--mpw-x, 1.5rem); bottom: var(--mpw-y, 5.5rem);">
  <div class="glass rounded-2xl shadow-2xl flex items-center gap-3 p-2 pr-3 w-72 relative overflow-hidden"
       data-drag-handle>
    <div class="w-10 h-10 rounded-xl bg-white/5 shrink-0 overflow-hidden flex items-center justify-center">
      <i class="fas fa-music text-primary/50"></i>
    </div>
    <div class="flex flex-col min-w-0 flex-1">
      <span id="mpw-title" class="text-xs font-bold text-white truncate">—</span>
      <span id="mpw-subtitle" class="text-[10px] text-slate-500 truncate">—</span>
    </div>
    <button id="mpw-play-btn" class="w-8 h-8 rounded-full bg-white text-black flex items-center justify-center shrink-0">
      <i class="fas fa-play text-xs"></i>
    </button>
    <button id="mpw-close-btn" class="w-6 h-6 rounded-full flex items-center justify-center text-slate-400 hover:text-white shrink-0">
      <i class="fas fa-times text-xs"></i>
    </button>
    <div class="absolute left-0 bottom-0 h-0.5 bg-primary transition-all" id="mpw-progress" style="width:0%"></div>
  </div>
</div>
```

Đặt `#mini-player-widget` làm **con trực tiếp của `<body>`**, sau thẻ đóng của `#reader-container`/`#discovery-mode`, để nó không bao giờ bị ẩn theo view nào.

### 4.3. State machine hiển thị player

Đề xuất 1 biến trạng thái duy nhất, ví dụ `STATE.playerDisplayMode`, nhận 1 trong 3 giá trị:

- `'full'` — player đầy đủ trong Reader view (mặc định khi mở sách).
- `'compact'` — hành vi minimize hiện tại (nút tròn giữa, vẫn trong Reader view) — **giữ nguyên**, không đổi.
- `'floating'` — widget nổi góc màn hình, kéo-thả được, hiển thị bất kể đang ở Reader hay Discovery (Tier 2).

Chuyển trạng thái:

```
full ⇄ compact        : nút minimize-btn hiện có (không đổi logic)
full/compact → floating : tự động khi vào Discovery mode trong khi đang phát (Tier 2).
                          (Ghi chú 2026-07-06: nút "pop-out" thủ công đã bị loại bỏ theo
                          yêu cầu — từ player chính, người dùng bấm thẳng nút PiP (1 click)
                          để mở cửa sổ Document PiP, không đi qua widget nội bộ nữa.)
floating → full        : bấm vào thân widget (trừ nút play/close)
floating → (đóng hẳn)  : bấm nút X trên widget → resetAudioEngine() + ẩn widget
```

### 4.4. Kéo-thả (drag) + snap góc

- Dùng Pointer Events (`pointerdown`, `pointermove`, `pointerup`) trên phần tử có `data-drag-handle` — hoạt động thống nhất cho cả chuột và cảm ứng (không cần xử lý touch/mouse riêng).
- Trong lúc kéo: cập nhật `transform: translate(x, y)` (dùng transform thay vì `left/top` để mượt hơn, tránh reflow).
- Khi thả tay (`pointerup`): tính góc gần nhất trong 4 góc viewport (trừ margin an toàn, tránh đè lên bottom-nav trên mobile hoặc notch), animate `transition` về góc đó.
- Lưu vị trí đã chọn (góc nào: `tl|tr|bl|br`) vào `localStorage` key `mpw-corner`, khôi phục lại lần mở app sau — theo đúng pattern hiện có của app (`localStorage.setItem('player-minimized', ...)` ở app.js:3158, `localStorage.setItem('lite-mode-enabled', ...)` ở app.js:3188).
- Giới hạn kéo trong bounds viewport (`clamp` toạ độ theo `window.innerWidth/innerHeight` trừ kích thước widget).
- Phân biệt "click" và "drag" bằng ngưỡng khoảng cách di chuyển (ví dụ > 5px mới coi là kéo) để nút play/close/click-to-expand không bị nuốt bởi trình xử lý drag.

### 4.5. Đồng bộ dữ liệu (không viết lại logic audio)

Widget **không tự quản lý audio** — nó chỉ là 1 "view" khác hiển thị cùng 1 nguồn sự thật (`STATE`, `audio` element hiện có). Cách đồng bộ:

- Tái sử dụng đúng các điểm mà `app.js` hiện đang cập nhật UI player chính (tên biến cụ thể cần rà lại khi code, nhưng theo cấu trúc đã thấy: các đoạn cập nhật `#player-title`, `#progress-bar`, `#time-display`, và các đoạn set `STATE.isPlaying` ở app.js:2709, 2800, 2831 v.v.) — thêm 1 lệnh gọi `syncMiniPlayerWidget()` ngay tại các điểm đó, hoặc đơn giản hơn: dùng `MutationObserver`/`requestAnimationFrame` polling nhẹ để mirror nội dung từ `#player-title`, `#progress-bar` gốc sang widget (ít xâm lấn code cũ hơn, đánh đổi hiệu năng nhỏ — chấp nhận được vì tần suất cập nhật thấp, vài trăm ms/lần).
- Nút play/pause trên widget gọi lại **đúng hàm** mà nút `#play-btn` gốc đang gọi (không viết logic play/pause mới) — tránh 2 nguồn sự thật cho cùng 1 hành động.
- Đã có Media Session API (mục 1.1) — **không cần làm gì thêm** để lock-screen/notification controls hoạt động, chúng độc lập với UI widget.

### 4.6. CSS / animation

- Tái sử dụng class `glass` (glassmorphism) đã có sẵn trong theme hiện tại để đồng bộ phong cách.
- `transition: transform 0.3s cubic-bezier(...)` khi snap góc; tắt transition trong lúc đang kéo (`pointermove`) để không bị "trễ" theo tay.
- Đảm bảo z-index cao hơn mọi modal khác **trừ** các dialog thật sự chặn tương tác (kiểm tra z-index của `edit-chapter-modal`, `stats-modal`, TOC overlay hiện có, đặt `#mini-player-widget` thấp hơn modal nhưng cao hơn `discovery-mode` (`z-[80]`) và `media-player` gốc (`z-[50]`) — ví dụ `z-[90]`, để không đè lên modal xác nhận/nhập liệu.

### 4.7. Responsive

- Desktop (`lg:` trở lên): widget dạng "pill" ngang ~280px, mặc định góc dưới-phải.
- Mobile: widget full-width trừ margin 2 bên, đặt ngay phía trên bottom navigation/tab bar (nếu app có), giống layout mini-player của YouTube app — kéo-thả có thể **tắt trên mobile** (chỉ snap 2 vị trí: trên cùng hoặc dưới cùng) để tránh vướng ngón tay khi cuộn trang, hoặc cho phép **vuốt sang ngang để đóng** (swipe-to-dismiss) thay vì kéo tự do.

### 4.8. Tier 3 chi tiết — Document Picture-in-Picture (tuỳ chọn)

```js
if ('documentPictureInPicture' in window) {
  pipBtn.hidden = false;
  pipBtn.onclick = async () => {
    const pipWindow = await window.documentPictureInPicture.requestWindow({
      width: 300, height: 100,
    });
    // Copy CSS cần thiết sang pipWindow.document
    // Di chuyển (không phải clone) #mini-player-widget's nội dung điều khiển vào pipWindow.document.body
    // Lắng nghe pipWindow "pagehide" để trả nội dung về lại trang chính khi đóng cửa sổ PiP
  };
} else {
  pipBtn.hidden = true; // Firefox/Safari — ẩn nút, dùng widget nội bộ như bình thường
}
```

Lưu ý: `documentPictureInPicture` giữ cửa sổ PiP tồn tại độc lập kể cả khi đổi tab — nhưng **audio vẫn phát từ tab gốc** (không di chuyển audio context), nên chỉ cần đảm bảo các nút trong cửa sổ PiP gọi lại được hàm play/pause của tab gốc qua reference `pipWindow.opener`/closure JS bình thường (cùng 1 JS runtime, không phải iframe).

---

## 5. Việc cần làm với backend? 

Về nguyên tắc, tính năng này là **thuần frontend** (Tier 1 và Tier 3). Riêng **Tier 2** cần xác minh với backend:

- `main.py` quản lý WebSocket + worker TTS thế nào khi client "ở lại" kết nối lâu hơn (trước đây giả định là đóng sớm khi rời Reader)? Có timeout/idle-disconnect nào phía server không? Cần đọc phần quản lý session trong [main.py](Cloud_TTS_Reader/main.py) trước khi quyết định bỏ `resetAudioEngine()` trong `toggleDiscoveryMode`.
- Có giới hạn số WebSocket đồng thời/user (do host trên Fly.io free tier, RAM 256MB) không? Nếu người dùng mở Discovery lâu trong khi vẫn giữ session TTS sống, có tốn tài nguyên hơn dự kiến không?

---

## 6. Checklist thực thi theo giai đoạn

### Phase 0 — Chuẩn bị
- [ ] Xác nhận cách `app.js` được load (`<script>` thường hay module) để quyết định cách share state với file mới.
- [ ] Xác nhận với người phụ trách backend về lý do `resetAudioEngine()` được gọi khi vào Discovery (trước khi làm Tier 2).
- [ ] Backup `index.html`, `app.js` hiện tại (theo đúng thói quen đã có trong `FRONTEND_REFACTOR_PLAN.md` của repo — tạo bản `*_before_miniplayer_backup.*`).

### Phase 1 — Tier 1 (widget nổi trong phạm vi Reader view)
- [ ] Tạo `static/css/mini-player.css`, `static/js/mini-player-widget.js`.
- [ ] Thêm HTML `#mini-player-widget` vào `index.html` (con trực tiếp `<body>`).
- [ ] Cài đặt state machine `full/compact/floating` (mục 4.3), giữ nguyên hành vi `compact` hiện tại.
- [ ] Cài đặt kéo-thả + snap góc + lưu vị trí `localStorage` (mục 4.4).
- [ ] Đồng bộ nội dung (title/progress/play-state) giữa player gốc và widget (mục 4.5).
- [ ] Nút đóng (X) → gọi đúng luồng dừng phát hiện có.
- [ ] Test: mở TOC overlay (đã có `tocAutoMinimized`) → xác nhận vẫn hoạt động đúng, không xung đột với widget mới.
- [ ] Test responsive mobile/desktop.

### Phase 2 — Tier 2 (sống sót qua Discovery/Library)
- [ ] Sửa `toggleDiscoveryMode()` (app.js:334-355): bỏ/điều kiện hoá lệnh gọi `resetAudioEngine()`.
- [ ] Đảm bảo `#mini-player-widget` tự động chuyển sang `'floating'` khi `toggleDiscoveryMode(true)` được gọi trong lúc `STATE.isPlaying === true`.
- [ ] Rà soát toàn bộ codebase tìm các nơi khác gọi `resetAudioEngine()` hoặc ẩn `reader-container` để đảm bảo không có luồng nào khác vô tình cắt audio ngoài ý muốn.
- [ ] Test: phát sách → mở Discovery/tìm sách khác → xác nhận audio không giật/ngắt, widget hiển thị đúng, bấm play/pause từ widget hoạt động → quay lại Reader → player full-size khôi phục đúng vị trí đang đọc.
- [ ] Test tải WebSocket/RAM khi giữ session sống lâu trong Discovery (đo trên môi trường staging trước khi lên Fly.io production).

### Phase 3 — Tier 3 (BẮT BUỘC — Document PiP)
- [ ] Thêm nút "pop-out" kiểm tra `'documentPictureInPicture' in window`.
- [ ] Cài đặt `requestWindow()`, di chuyển nội dung điều khiển sang cửa sổ PiP.
- [ ] Xử lý sự kiện đóng cửa sổ PiP → trả nội dung về widget trong trang chính.
- [ ] Test trên Chrome/Edge (hỗ trợ) và xác nhận ẩn nút đúng cách trên Firefox/Safari (không hỗ trợ).

---

## 7. Rủi ro & lưu ý kỹ thuật

- **Xung đột 2 cơ chế "minimize"**: hiện đã có `.minimized-player` (compact mode). Cần rõ ràng: widget mới (`floating`) là 1 trạng thái **khác**, không phải thay thế 1-1 — tránh trường hợp cả 2 lớp CSS cùng áp dụng gây lỗi layout chồng chéo.
- **z-index layering**: đã liệt kê ở mục 4.6, cần kiểm tra thực tế toàn bộ z-index đang dùng trong `index.html` (tìm tất cả `z-[...]`) trước khi chọn giá trị cho widget, tránh đè/bị đè sai ý.
- **iOS Safari**: MSE có hỗ trợ hạn chế trên iOS Safari (nhiều bug lịch sử với `MediaSource` trên WebKit) — nếu audio engine hiện tại đã né được vấn đề này bằng cách nào đó, đảm bảo Tier 2 (giữ session sống lâu hơn) không phơi bày lại bug cũ trên iOS. Cần test riêng trên Safari/iOS.
- **PWA đã cài đặt (standalone mode)**: kiểm tra widget hiển thị đúng khi app chạy dưới dạng PWA cài trên máy (không có thanh địa chỉ trình duyệt, vùng an toàn/safe-area khác).
- **Đa tab**: nếu người dùng mở 2 tab cùng lúc, mỗi tab có `audio`/`STATE` riêng — không cần đồng bộ giữa các tab (ngoài phạm vi), nhưng nên đảm bảo widget không giả định nhầm là "chỉ có 1 nơi phát" toàn cục qua `localStorage` (chỉ dùng `localStorage` cho vị trí/kích thước UI, không dùng cho trạng thái phát).
- **Không có silent fallback**: nếu trình duyệt không hỗ trợ Pointer Events (rất hiếm ở 2026) hoặc Document PiP, phải ẩn hẳn tính năng tương ứng thay vì để nút bấm không phản ứng.

---

## 8. Tiêu chí nghiệm thu (Acceptance Criteria)

1. Khi đang phát sách và bấm nút thu nhỏ/kéo player ra góc, widget xuất hiện đúng vị trí, kéo-thả mượt (không giật, không lệch tay), snap đúng góc gần nhất.
2. Vị trí widget được nhớ lại sau khi tải lại trang (`localStorage`).
3. (Tier 2) Audio không bị ngắt/giật khi chuyển từ Reader sang Discovery/Library và quay lại; widget vẫn hiển thị và điều khiển được trong suốt quá trình đó.
4. Bấm vào thân widget mở lại đúng player full-size, đúng vị trí sách đang đọc (không mất tiến trình).
5. Bấm nút X dừng phát hẳn, giải phóng tài nguyên (không còn kết nối WebSocket TTS treo lại).
6. Hoạt động đúng trên: Chrome desktop, Chrome Android, Safari iOS (ít nhất Tier 1 + Tier 2 UI, Tier 3 có thể bỏ qua trên Safari), ở cả chế độ light/dark theme hiện có của app.
7. Không phá vỡ tính năng hiện có: TOC auto-minimize, Media Session lock-screen controls, Wake Lock, Lite Mode.

---

## 9. Câu hỏi mở — cần chốt trước/trong khi code

1. **Phạm vi ưu tiên**: chỉ cần Tier 1 (UI kéo-thả, không đổi audio-engine) hay bắt buộc phải có Tier 2 (phát tiếp qua Discovery — đây mới là điểm khác biệt cốt lõi so với hành vi hiện tại)? Tier 2 là phần tốn công và rủi ro nhất.
2. **Trigger tự động**: widget có nên tự động bật khi vào Discovery trong lúc đang phát (Tier 2), hay chỉ bật khi người dùng chủ động bấm nút/kéo? (Đề xuất mặc định: tự động, giống YouTube — nhưng cần xác nhận vì đây là thay đổi hành vi mặc định của app.)
3. **Đóng ứng dụng/tab khi đang có widget floating**: có cần cảnh báo "đang phát, chắc chắn muốn thoát?" hay để mặc định trình duyệt xử lý?
4. ~~**Tier 3 (Document PiP)**: có thực sự cần thiết?~~ → **ĐÃ CHỐT (2026-07-06): BẮT BUỘC.**
5. **Giới hạn tài nguyên backend**: xác nhận với backend/hosting (Fly.io 256MB RAM) mức chấp nhận được cho việc giữ WebSocket TTS sống lâu hơn khi người dùng ở Discovery/Library (Tier 2).
