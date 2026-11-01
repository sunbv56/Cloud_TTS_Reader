# Làm lại UI theo hướng "Mục Lục & Console"

Chốt ngày 2026-10-31. Mẫu gốc: `ui-proposals/muc-luc-console.html` (ngoài repo, đã publish làm Artifact riêng tư).

## Quyết định

1. **Cách làm**: làm lại markup + CSS của app thật, giữ toàn bộ logic `app.js` (TTS, WebSocket, Firestore, upload, ảnh), nối lại id/handler. Nghiệm thu bằng `docs/UI-FEATURE-CHECKLIST.md`: mục nào cũng phải dùng được trên mobile và desktop.
2. **Bố cục**:
   - **Mobile**:
     - 3 màn chính: Thư viện (dạng mục lục), Reader, Discovery.
     - Console dính đáy. Vuốt lên hoặc bấm ⌃ mở panel đầy đủ: tua, ↺▶↻ theo câu, ‹chương›, giọng, cao độ, hẹn giờ, tắt màn hình, nâng cao.
     - Mục lục chương là sheet riêng: tìm, ghim chương đang nghe, chọn nhiều để xoá / tải MP3.
   - **Desktop**:
     - Cột trái 360px (tab Truyện | Chương), reader 66ch, console 64px dưới đáy đủ nút.
     - Có phím tắt.
3. **Discovery + ảnh truyện**:
   - Desktop mặc định lưới bìa, mobile mặc định danh sách có bìa 40×56, có nút đổi Lưới ⇄ Danh sách.
   - Thẻ "Nghe tiếp", tìm kiếm, lọc Đang nghe / Tất cả / Đã xong, sắp xếp.
   - Bìa lấy từ image manifest (`coverId`). Truyện chưa có bìa thì tạo bìa chữ.
   - Bìa tải lazy, cache object URL và giải phóng khi rời trang.
4. **Theme**: 4 theme Slate (mặc định) / Slate sâu / Sương / Sepia. ID theme cũ trong localStorage tự map sang theme mới. Font JetBrains Mono + Be Vietnam Pro + Source Serif 4; font đọc khác tải khi người dùng chọn.
5. **Test**: localhost, cộng deploy tay (`flyctl deploy`) nhánh redesign lên app Fly sẵn có `cloud-tts-reader` (giờ chỉ là dự phòng; prod chính là Botkeep). Không cần đổi gì trong Firebase. Lần merge main tiếp theo, GitHub Actions sẽ deploy đè lại bản main.
6. **Nhánh**: `feat/tts-2-ui-console-redesign` tạo từ `feat/tts-1-quick-account-switch`. Rebase khi nhánh đó merge. Chỉ lên prod sau khi duyệt trên staging.
