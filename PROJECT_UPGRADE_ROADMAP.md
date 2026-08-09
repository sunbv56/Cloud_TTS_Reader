# Cloud TTS Reader — Đề xuất nâng cấp

Tài liệu này ghi lại các ý tưởng nâng cấp được rút ra từ việc rà soát mã nguồn hiện tại. Phạm vi gồm backend FastAPI/Firebase và frontend PWA/WebSocket reader.

> Trạng thái: tài liệu nội bộ; các guardrail xác thực và giới hạn tài nguyên cốt lõi đã triển khai. Các mục vận hành, tích hợp và hiệu năng vẫn đang thực hiện theo quy trình deploy/test Fly.io ở mục 10.
>
> Lưu ý: file này được tạo local theo yêu cầu. Không commit và không push lên GitHub.

### Trạng thái triển khai P0 — 08/08/2026

- [x] Đã thêm xác thực Firebase ID token cho API truy cập dữ liệu người dùng và WebSocket TTS.
- [x] Đã thêm giới hạn upload, append, text TTS, số worker, queue, số chương và số câu khi xuất MP3.
- [x] Giữ nguyên đường dẫn Storage/Firestore, story ID, segment format và metadata cũ để dữ liệu hiện hữu tiếp tục sử dụng được.
- [x] Đã thêm test hồi quy P0 tại `tests/p0-security.test.js`.
- [x] Đã deploy trực tiếp từ local lên Fly.io để kiểm thử: `https://cloud-tts-reader.fly.dev/`.
- [x] Smoke test `/api/ping` trả HTTP 200; request không có token tới API dữ liệu và `/stream/audio` bị từ chối HTTP 401.
- [x] Không commit và không push GitHub.

### Trạng thái tính năng ảnh minh họa — 08/08/2026

- [x] Chọn nhiều ảnh minh họa khi import sách; giữ nguyên luồng sách TXT cũ nếu không có ảnh.
- [x] Chuyển JPG/PNG/WebP/GIF/BMP/AVIF sang WebP bằng canvas, giới hạn kích thước tối đa 150 KB/ảnh và mục tiêu khoảng 125 KB.
- [x] Lưu ảnh theo `users/{uid}/images/{bookId}` trên Firebase Storage, không tạo collection DB mới.
- [x] Lưu manifest JSON trong Storage để hỗ trợ cover và gắn ảnh theo chương về sau.
- [x] Hiển thị ảnh ở thẻ thư viện và chương đọc đầu tiên; ảnh cũ không có manifest vẫn mở bình thường.
- [x] Xóa ảnh/manifest cùng lúc khi xóa sách; cập nhật Storage Rules kiểm tra MIME và dung lượng.
- [x] Quản lý ảnh cho truyện đang mở: thêm, thay, đặt cover và xóa ảnh.
- [x] Hỗ trợ kéo-thả, dán ảnh từ clipboard và nhận file `.image` có nội dung ảnh hợp lệ.
- [x] Thêm test tĩnh cho bộ nén, đường dẫn Storage và Storage Rules.

## 1. Quy ước ưu tiên

- **P0 — Khẩn cấp:** liên quan đến bảo mật, mất dữ liệu hoặc nguy cơ làm dịch vụ bị lạm dụng.
- **P1 — Rất quan trọng:** ảnh hưởng rõ đến độ ổn định, hiệu năng hoặc trải nghiệm chính.
- **P2 — Hữu ích:** cải thiện đáng kể khả năng sử dụng hoặc bảo trì.
- **P3 — Mở rộng:** nên làm sau khi các hạng mục nền tảng đã ổn định.

Độ khó:

- **Dễ:** khoảng 0,5–2 ngày, ít phụ thuộc vào kiến trúc hiện tại.
- **Trung bình:** khoảng 2–7 ngày, cần sửa nhiều lớp hoặc thêm test.
- **Khó:** trên 1 tuần, ảnh hưởng dữ liệu, kiến trúc hoặc cần cơ chế vận hành mới.

## 2. Hiện trạng dự án

### Điểm mạnh đã có

- Streaming TTS qua WebSocket.
- Prefetch song song, retry chunk và phát liên tục.
- Đồng bộ tiến trình đọc qua Firestore.
- Thư viện sách cá nhân.
- Thêm, sửa và xóa chương.
- Xuất TXT và tải nhiều chương thành MP3.
- Sleep timer, wake lock, Media Session.
- Offline audio qua IndexedDB.
- PWA/service worker.
- Mini player và Picture-in-Picture.
- Tùy chỉnh giọng, tốc độ, pitch, volume, font và theme.
- Từ điển thay thế/phát âm riêng phía client.

### Các điểm cần ưu tiên xử lý

- [x] Xác thực Firebase ID token cho API dữ liệu người dùng.
- [x] Giới hạn upload, text TTS, worker WebSocket và queue.
- [ ] Một số lệnh Firebase Storage/Firestore đồng bộ đang chạy trong `async endpoint`.
- [ ] Cập nhật master TXT, segment và metadata chưa có cơ chế transaction/version rõ ràng.
- [ ] `main.py` và `static/app.js` rất lớn, làm tăng chi phí bảo trì.
- [x] Đã có test hồi quy P0; vẫn còn thiếu test backend tích hợp và phân quyền thực tế.
- [ ] README mô tả kiến trúc module nhưng phần lớn mã thực tế vẫn nằm trong file nguyên khối.

## 3. Nâng cấp backend

| Trạng thái | Ưu tiên | Ý tưởng | Độ khó | Giá trị/chủ đích |
|---|---|---|---:|---|
| ✅ Đã làm | P0 | Xác thực Firebase token cho toàn bộ API dữ liệu người dùng | Trung bình | Ngăn đọc, sửa hoặc xóa dữ liệu của tài khoản khác |
| ✅ Đã làm | P0 | Giới hạn upload, text, worker, queue và tốc độ gọi TTS | Trung bình | Ngăn cạn RAM/CPU và lạm dụng dịch vụ |
| ☐ Chưa làm | P0 | Rà soát và xoay vòng service-account key | Dễ | Giảm rủi ro lộ credential |
| ☐ Chưa làm | P1 | Đưa lệnh Firebase blocking ra thread pool | Trung bình | Tránh upload lớn chặn event loop |
| ☐ Chưa làm | P1 | Cache audio TTS theo nội dung và setting | Trung bình–Khó | Giảm latency và số lần gọi Edge TTS |
| ☐ Chưa làm | P1 | Parser encoding và nhận diện chương tốt hơn | Trung bình | Import TXT từ nhiều nguồn ổn định hơn |
| ☐ Chưa làm | P1 | Test backend và kiểm thử phân quyền | Trung bình | Bảo vệ các luồng dữ liệu quan trọng |
| ☐ Chưa làm | P2 | Logging, metrics và health check thật | Trung bình | Dễ theo dõi lỗi production |
| ☐ Chưa làm | P2 | Chia `main.py` theo router/service | Trung bình | Dễ bảo trì mà không cần kiến trúc quá phức tạp |

### 3.1. Xác thực quyền sở hữu — P0, Trung bình

Endpoint xuất TXT đã có helper xác minh token tại `main.py`, nhưng nhiều endpoint khác dùng `userId` do client gửi rồi thao tác bằng Firebase Admin. Các nhóm cần rà soát gồm upload, metadata, segment, lấy nội dung, thêm chương, sửa chương và xóa chương.

Hướng thực hiện:

- [x] Tạo helper xác minh token dùng `auth.verify_id_token()`.
- [x] Lấy UID từ token, không dùng `userId` trong form/query làm nguồn xác thực.
- [x] Kiểm tra quyền sở hữu trước mọi thao tác Storage/Firestore.
- [x] Áp dụng cùng cơ chế cho WebSocket khi mở kết nối.
- [x] Trả `401` cho token thiếu/sai và `403` cho tài nguyên không thuộc người dùng.

Đây là hạng mục nên làm trước mọi tính năng mới.

### 3.2. Giới hạn tài nguyên — P0, Trung bình

WebSocket cho client gửi `numWorkers`; backend tạo số worker được yêu cầu. Queue và kích thước text cũng chưa có giới hạn chặt chẽ.

Nên bổ sung:

- [x] Giới hạn kích thước upload, hiện mặc định 25 MB.
- [x] Chỉ nhận `.txt` và kiểm tra MIME/nội dung cơ bản một cách chặt chẽ.
- [x] Giới hạn số ký tự mỗi request/chunk.
- [x] Clamp `numWorkers`, hiện tối đa 5.
- [x] Dùng queue có `maxsize`.
- [x] Giới hạn số chương/câu khi xuất MP3.
- [ ] Rate limit theo UID và IP.
- [x] Timeout riêng cho Edge TTS theo từng lần đọc chunk.
- [x] Giới hạn số WebSocket đồng thời trên mỗi tài khoản trong mỗi process.

### 3.3. Credential và secret — P0, Dễ

Workspace có file service-account JSON ở thư mục cấp dự án. `.gitignore` đã loại JSON, nhưng private key thật không nên được giữ trong source tree hoặc bản backup.

Checklist:

- [ ] Kiểm tra Git history và nơi từng chia sẻ workspace.
- [ ] Nếu là credential thật, revoke/rotate key.
- [x] Credential production được đọc qua biến môi trường/Fly secrets.
- [ ] Thêm secret scanning vào CI.

### 3.4. Không chặn event loop — P1, Trung bình

Các lệnh như `blob.download_to_filename()`, `blob.upload_from_filename()`, `document.get()` và `document.set()` là blocking nhưng được gọi trong `async def`.

Giải pháp ngắn hạn:

```python
await asyncio.to_thread(blob.upload_from_filename, tmp_path)
```

Áp dụng tương tự cho các thao tác Storage/Firestore khác. Các tác vụ rất dài như tái tạo toàn bộ segment hoặc xuất audio có thể chuyển sang background job ở giai đoạn sau.

### 3.5. Cache TTS — P1, Trung bình–Khó

Tạo cache key từ:

```text
hash(text + voice + rate + pitch + volume)
```

Cache có thể đặt ở Storage hoặc local disk với TTL/LRU. Nên triển khai sau authentication và resource limit để tránh cache bị lạm dụng.

### 3.6. Parser và encoding — P1, Trung bình

Parser hiện dùng delimiter dòng có ít nhất ba dấu `=`. Có thể cải thiện bằng:

- Nhận diện `Chương 1`, `Chapter 1`, `Phần I`, tiêu đề Markdown.
- Hỗ trợ UTF-8 BOM, UTF-16 và Windows-1258.
- Preview cấu trúc chương trước khi import.
- Cho người dùng chọn quy tắc phân chương.
- Cảnh báo file không có delimiter hoặc chương quá dài.
- Cân nhắc EPUB sau khi TXT ổn định; PDF nên là hạng mục riêng.

### 3.7. Logging và health check — P2, Trung bình

Nên thêm:

- Request ID.
- Structured logging thay cho `print`.
- Thời gian tạo audio và độ dài queue.
- Số retry/lỗi theo voice.
- `/health/live` và `/health/ready`.
- Timeout khi kiểm tra Firebase/Edge TTS.
- Không trả thẳng `str(e)` cho client trong response 500.

### 3.8. Chia backend — P2, Trung bình

Mục tiêu là chia vừa đủ, không dựng framework mới:

```text
app/
  main.py
  auth.py
  routers/
    books.py
    tts.py
    websocket.py
  services/
    book_parser.py
    book_storage.py
    tts_service.py
```

Nên bắt đầu bằng các hàm thuần túy như parser và tính cache key để việc test dễ hơn.

## 4. Nâng cấp frontend

| Trạng thái | Ưu tiên | Ý tưởng | Độ khó | Giá trị cho người dùng |
|---|---|---|---:|---|
| ☐ Chưa làm | P1 | Tìm kiếm toàn sách và nhảy đến kết quả | Trung bình | Rất tiện với sách dài |
| ☐ Chưa làm | P1 | Preview giọng đọc và preset theo sách | Dễ–Trung bình | Chọn giọng nhanh hơn |
| ☐ Chưa làm | P1 | Preview import và chỉnh quy tắc chia chương | Trung bình | Phát hiện lỗi trước khi upload |
| ☐ Chưa làm | P1 | Offline manager theo sách/chương | Trung bình | Chủ động tải trước và quản lý dung lượng |
| ☐ Chưa làm | P1 | Trạng thái mạng/lỗi thống nhất | Dễ | Người dùng biết đang retry, offline hay thất bại |
| ☐ Chưa làm | P1 | Rà soát accessibility và keyboard shortcut | Dễ–Trung bình | Tốt hơn trên desktop, mobile và với người dùng cần trợ năng |
| ☐ Chưa làm | P2 | Tách `app.js` theo module | Trung bình | Giảm rủi ro khi thêm tính năng |
| ☐ Chưa làm | P3 | Import EPUB/PDF | Khó | Mở rộng nguồn tài liệu |
| ✅ Đã làm | P2 | Ảnh minh họa WebP 100–150 KB, cover sẵn sàng qua manifest Storage | Trung bình | Tăng tính trực quan mà không thêm dữ liệu vào DB |

### 4.1. Tìm kiếm toàn sách — P1, Trung bình

Nên hỗ trợ:

- Tìm không phân biệt dấu tiếng Việt.
- Đoạn trích và tên chương.
- Nhảy thẳng đến câu.
- `Ctrl/Cmd + F`.
- Tìm trong chương hiện tại hoặc toàn sách.
- Lịch sử từ khóa gần đây.

Phiên bản đầu có thể tìm trên các segment đã tải. Phiên bản đầy đủ nên tạo index khi upload hoặc tải segment nền.

### 4.2. Preview giọng và preset — P1, Dễ–Trung bình

Có thể thêm:

- Nút nghe thử 5–8 giây.
- Hiển thị ngôn ngữ/giới tính.
- Giọng yêu thích.
- Preset “Nghe truyện”, “Học ngoại ngữ”, “Nghe nhanh”.
- Lưu voice/rate/pitch riêng cho từng sách.
- Nút reset setting của sách.

### 4.3. Preview import — P1, Trung bình

Trước khi upload, hiển thị:

- Tên sách dự kiến.
- Số chương nhận diện.
- Một số tiêu đề chương đầu.
- Encoding và kích thước file.
- Quy tắc phân chương.
- Cho phép sửa tiêu đề hoặc delimiter.

### 4.4. Offline manager — P1, Trung bình

Ứng dụng đã có IndexedDB, nên có thể mở rộng với:

- Tải chương hiện tại để nghe offline.
- Chọn nhiều chương.
- Trạng thái đã tải/chưa tải.
- Ước tính dung lượng.
- Xóa cache theo từng sách.
- Tự động giữ vài chương kế tiếp.
- Cảnh báo quota trình duyệt.
- Chỉ tải tự động khi dùng Wi-Fi nếu cần.

### 4.5. Accessibility và lỗi — P1, Dễ–Trung bình

Nên rà soát:

- `aria-label` cho nút chỉ có icon.
- Focus ring và điều hướng bàn phím.
- `Space` play/pause, mũi tên câu trước/sau, `B` bookmark, `S` search.
- Không kích hoạt shortcut khi đang nhập.
- `prefers-reduced-motion`.
- Vùng chạm đủ lớn trên mobile.
- Chuẩn hóa ngôn ngữ UI Việt/Anh.
- Toast/banner thống nhất thay cho nhiều `alert()`.
- Nút “Thử lại” cho lỗi mạng, TTS, upload và đồng bộ tiến trình.

## 5. Cấu trúc frontend nên cải thiện

`static/app.js` hiện rất lớn. Nên tách từng phần theo phụ thuộc:

```text
static/js/
  state.js
  firebase-service.js
  book-service.js
  audio-engine.js
  offline-manager.js
  progress-manager.js
  library-view.js
  reader-view.js
  settings-view.js
  app.js
```

Thứ tự an toàn:

1. Offline manager.
2. Firebase/auth service.
3. Progress service.
4. Book API service.
5. Audio engine.

README nên được cập nhật để phản ánh đúng trạng thái module hiện tại.

## 6. Test cần bổ sung

Các test hiện có đã kiểm tra một số hành vi về prefetch, WebSocket close, mini player/PiP và service worker. Nên bổ sung:

- [ ] User A không thể đọc/sửa dữ liệu của user B bằng test tích hợp thật.
- [x] API từ chối token thiếu; smoke test production đã xác nhận HTTP 401.
- [ ] API từ chối token hết hạn bằng test tích hợp.
- [x] Upload quá lớn có giới hạn trong backend.
- [x] Worker count bị clamp.
- [ ] Parser xử lý BOM, UTF-16 và file không delimiter.
- [ ] Sửa/xóa chương cập nhật đúng master, metadata và segment.
- [ ] Segment dư được dọn sau khi sách giảm số chương.
- [x] WebSocket yêu cầu bước AUTH trước khi xử lý task.
- [ ] Global index ↔ chapter index chính xác.
- [ ] Offline cache được xóa theo từng sách.
- [ ] E2E: đăng nhập → upload → phát → lưu tiến trình → mở lại.

## 7. Roadmap triển khai đề xuất

### Giai đoạn 1 — An toàn và ổn định

Độ khó tổng: Trung bình. Ưu tiên: P0.

- [x] Xác thực token trên mọi API và WebSocket.
- [x] Bỏ tin cậy vào `userId` từ request.
- [x] Clamp worker, giới hạn upload/text/queue.
- [ ] Rà soát và rotate service-account nếu cần.
- [ ] Thêm error handler và logging cơ bản.
- [x] Viết test hồi quy P0 ở mức source/config; còn thiếu test phân quyền tích hợp.

### Giai đoạn 2 — Hiệu năng và độ tin cậy

Độ khó tổng: Trung bình–Khó. Ưu tiên: P1.

- [ ] Chuyển Firebase blocking sang thread pool.
- [ ] Timeout/retry có giới hạn cho Edge TTS.
- [ ] Cache audio theo hash.
- [ ] Cải thiện parser và encoding.
- [ ] Bổ sung test backend/CI.

### Giai đoạn 3 — UX tác động cao

Độ khó tổng: Trung bình. Ưu tiên: P1.

- [ ] Search toàn sách.
- [ ] Voice preview/preset.
- [ ] Import preview.
- [ ] Offline manager theo chương.
- [ ] Trạng thái mạng/lỗi thống nhất.

### Giai đoạn 4 — Mở rộng

Độ khó tổng: Trung bình–Khó. Ưu tiên: P2/P3.

- [ ] Tách `main.py` và `app.js`.
- [ ] EPUB/PDF sau khi luồng TXT ổn định.

## 8. Năm việc nên làm trước

Nếu chỉ chọn năm hạng mục đầu tiên:

1. [x] Xác thực toàn bộ backend.
2. [x] Giới hạn tài nguyên upload/WebSocket/TTS.
3. [ ] Rà soát và xoay vòng credential.
4. [ ] Đưa Firebase blocking ra khỏi event loop.
5. [ ] Xây tìm kiếm toàn sách.

Đây là thứ tự cân bằng giữa bảo mật, độ ổn định và giá trị trực tiếp cho người dùng.

## 9. Tiêu chí hoàn thành tổng quát

- [x] Mọi API dữ liệu người dùng đều từ chối request không có token hợp lệ.
- [x] Backend không dùng `userId` client làm nguồn xác thực.
- [x] Upload và TTS có giới hạn được kiểm thử ở mức source/config.
- [ ] Có test backend tích hợp cho auth, parser và update flow.
- [ ] Người dùng có thể tìm câu trong sách dài và nhảy đến kết quả.
- [ ] Người dùng có thể tiếp tục đọc và quản lý offline rõ ràng.
- [ ] Tài liệu README phản ánh đúng cấu trúc mã nguồn thực tế.

## 10. Quy trình bắt buộc: sửa → deploy Fly.io kiểm thử → push và merge

Mọi thay đổi, đặc biệt các thay đổi backend, xác thực, Storage/Firestore, WebSocket
và PWA, phải đi theo đúng thứ tự dưới đây. Không push GitHub hoặc merge khi chưa
qua bước kiểm thử trên Fly.io.

1. **Sửa code và kiểm tra cục bộ**
   - Xem lại diff, bảo đảm không đưa credential, file tạm hay dữ liệu người dùng vào commit.
   - Chạy toàn bộ test phù hợp; tối thiểu hiện tại là `node --test tests/*.test.js`.
   - Với thay đổi backend, bổ sung/chạy test cho luồng thành công, lỗi và phân quyền liên quan.

2. **Deploy bản kiểm thử lên Fly.io từ local**
   - Deploy đúng commit/diff đang kiểm tra lên môi trường Fly.io.
   - Ghi lại thời điểm deploy, revision và URL môi trường để có thể truy vết.
   - Không coi deploy thành công là đã nghiệm thu.

3. **Smoke test và integration test trên Fly.io**
   - Kiểm tra `/api/ping` và health check (khi đã có) trả kết quả mong đợi.
   - Kiểm tra luồng thay đổi trực tiếp trên môi trường deploy; với thay đổi bảo mật phải thử cả request không token, token sai/hết hạn và truy cập chéo UID.
   - Với WebSocket/TTS: kiểm tra kết nối, phát audio, retry/timeout và đóng kết nối giải phóng tài nguyên.
   - Với Storage/Firestore: kiểm tra upload, đọc, sửa/xóa và dữ liệu cũ vẫn tương thích.
   - Ghi kết quả PASS/FAIL cùng lỗi phát hiện. Nếu FAIL: quay lại bước 1; không push/merge.

4. **Push GitHub và tạo/hoàn tất PR**
   - Chỉ sau khi tất cả kiểm tra Fly.io PASS mới commit và push lên GitHub.
   - PR phải nêu: phạm vi thay đổi, lệnh test local, revision/URL Fly.io đã kiểm thử, checklist smoke/integration và rủi ro còn lại.

5. **Review và merge**
   - Merge chỉ khi review hoàn tất, CI GitHub PASS và không còn lỗi từ Fly.io.
   - Sau merge, xác nhận workflow deploy của nhánh `main` thành công và smoke test lại production nếu deployment workflow có thể tạo revision khác bản đã thử.

### Điều kiện dừng

- Không có ngoại lệ cho việc bỏ qua Fly.io với thay đổi có thể ảnh hưởng runtime, API, auth, dữ liệu hoặc UI production.
- Với thay đổi chỉ tài liệu, comment hoặc test không ảnh hưởng runtime, có thể bỏ qua deploy Fly.io nhưng vẫn phải chạy kiểm tra cục bộ phù hợp.

## 11. Nhật ký thực thi backend

### Đợt 1 — Guardrail upload, TTS và WebSocket — 09/08/2026

- [x] Xóa kế hoạch mini-player đã hoàn tất; không còn theo dõi hạng mục frontend này trong roadmap backend.
- [x] Chỉ nhận file `.txt` ở các endpoint parse/upload và kiểm tra content type cho phép.
- [x] Chỉ chấp nhận encoding UTF-8, UTF-8 BOM và UTF-16 có BOM; Windows-1258/byte không hợp lệ trả HTTP 415.
- [x] Bổ sung timeout cho từng lần đọc chunk từ Edge TTS để tránh worker chờ vô hạn.
- [x] Giới hạn số WebSocket TTS đồng thời theo UID trong mỗi process; giới hạn cấu hình qua `MAX_WS_PER_USER`.
- [x] Bổ sung test hồi quy tĩnh cho các guardrail mới.
- [x] Kiểm tra cục bộ: `node --test tests/*.test.js` — 18/18 PASS.
- [x] Deploy Fly.io bản `deployment-01KZJC3E404HQ98DZ7RS5S1DRT` thành công.
- [x] Smoke test Fly.io: `/api/ping` trả HTTP 200; API dữ liệu không có token bị từ chối HTTP 401.
- [x] Deploy bản từ chối encoding cũ: `deployment-01KZJEM6ZB9845DWFZ4M36X950`.
- [x] Kiểm thử trên Fly.io: UTF-8 trả preview 3 chương; Windows-1258 bị từ chối HTTP 415.

### Việc còn lại của backend sau đợt 1

- [x] Deploy bản thay đổi lên Fly.io và chạy smoke test cơ bản; integration test có Firebase thật vẫn cần bổ sung.
- [ ] Rotate/revoke service-account key và kiểm tra Git history (cần thao tác vận hành/credential ngoài code).
- [ ] Đưa toàn bộ lệnh Storage/Firestore blocking ra thread pool; phải kèm test tích hợp.
- [ ] Thêm rate limit HTTP theo UID/IP, observability và health/readiness check.
- [ ] Viết test tích hợp Firebase cho auth hết hạn, ownership và update/delete flow.
- [ ] Hoàn thiện parser nhận diện nhiều quy tắc chương và preview import.
