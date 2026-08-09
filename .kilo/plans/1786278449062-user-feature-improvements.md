# Ý tưởng MỚI cải thiện tính năng — Cloud TTS Reader

> Tập trung vào các ý tưởng **không** có trong `PROJECT_UPGRADE_ROADMAP.md`. Mỗi ý tưởng tận dụng sẵn kiến trúc hiện có (WebSocket, WordBoundary, Media Session, IndexedDB, ảnh minh họa) để chi phí thấp mà giá trị cao. Không thực hiện code.

## Ý tưởng "tận dụng sẵn có" (chi phí thấp)

1. **Karaoke tô sáng từng từ** — Dùng metadata `WordBoundary` (đã trả về ở `/stream/metadata` và WS `METADATA`) để highlight từng từ theo nhịp nói, thay vì chỉ cả câu. Rất hiệu quả cho người học, tận dụng dữ liệu có sẵn.

2. **Nút "nghe từ này"** — Chọn bất kỳ từ nào → phát riêng từ đó qua API `/stream/audio`. Học phát âm, tra từ.

3. **Phát lại đoạn vừa nghe (Recap khi resume)** — Khi tiếp tục đọc, tự động phát lại 1–2 câu cuối trước khi tiếp. Giải quyết "quên đang ở đâu" sau khi tạm dừng lâu.

4. **Handoff đa thiết bị 1 chạm** — Dựa trên progress Firestore có sẵn: thiết bị khác hiện thông báo "Tiếp tục chương X" và mở đúng câu. Khác "sync" thụ động, là chủ động chuyển giao.

5. **Xuất toàn bộ sách thành 1 file audiobook (M4B có chương)** — Hiện roadmap chỉ xuất MP3 từng chương; gộp thành 1 file M4B có metadata chương để nghe trên trình phát thường.

## Ý tưởng "mở rộng nguồn & luồng" (giá trị cao)

6. **Nhập từ URL / bài báo web** — Dán link → fetch + tách nội dung (readability) → thành sách nghe ngay. Mở rộng ngoài file cục bộ.

7. **Nút "đọc ngay" từ clipboard** — Copy bất kỳ text nào → nút nổi hiện ra → nghe ngay không cần lưu sách. Kiểu "reader mode" tức thì.

8. **Playlist / hàng đợi nghe** — Xếp nhiều sách/chương liên tiếp thành hàng đợi (như nghe playlist). Khác "thư viện" (quản lý), đây là phát nối tiếp.

9. **Đọc song ngữ / bản dịch cạnh nhau** — Hiển thị bản dịch (API dịch) cạnh bản gốc, có thể nghe luân phiên câu gốc – câu dịch. Học ngoại ngữ.

## Ý tưởng "thông minh / AI" (định hướng mới)

10. **Tóm tắt chương bằng AI** — Nút "Tóm tắt chương này" → sinh đoạn tóm tắt ngắn để lướt nhanh.

11. **Trình độ hóa văn bản (simplify)** — AI viết lại đoạn khó thành bản dễ đọc hơn (học sinh/người mới).

12. **Bộ từ vựng & lặp có khoảng cách (SRS)** — Từ bạn tap/gạch chân → tự động tạo thẻ ôn tập spaced-repetition kèm audio từng từ.

13. **"Giải thích câu này"** — Chọn câu → AI giải thích nghĩa/bối cảnh. Học thuật/ngoại ngữ.

## Ý tưởng "trải nghiệm thư giãn / cá nhân hóa" (đổi mới)

14. **Trộn âm nền (ambient)** — Thêm tiếng mưa/lò sưởi nhẹ dưới giọng đọc (Web Audio API). Nghe êm hơn khi thư giãn.

15. **Sleep timer thông minh** — Dừng ở cuối câu/chương thay vì cắt ngang; fade-out âm lượng dần. Khác timer đếm phút đơn giản.

16. **Giao diện thân thiện người khó đọc (OpenDyslexic)** — Font, giãn dòng, độ rộng cột tùy chỉnh trong chế độ đọc. Accessibility sâu hơn roadmap.

17. **Tự sinh bìa nếu thiếu** — Nếu sách không có ảnh, sinh bìa gradient/từ tiêu đề thay placeholder xám.

18. **Thẻ trích dẫn chia sẻ** — Chọn câu → sinh ảnh trích dẫn đẹp kèm QR phát audio đoạn đó. Viral/Social nhẹ.

19. **Tự động tạm dừng khi có cuộc gọi / DND** — Dùng PhoneState/Do-Not-Disturb để pause lịch sự.

## Gợi ý ưu tiên (mới, không trùng roadmap)
1. #1 Karaoke từng từ (tận dụng WordBoundary, P1, rẻ)
2. #2 Nút nghe từ (P1)
3. #6 Nhập URL/web (P1, giá trị cao)
4. #8 Playlist nghe (P2)
5. #3 Recap resume (P1)
6. #15 Sleep timer thông minh (P2)
7. #9 Đọc song ngữ (P2, học ngoại ngữ)
8. #12 Bộ từ vựng SRS (P2–P3)
9. #14 Ambient mixer (P3)
10. #5 Xuất M4B (P2)

## Ghi chú
- Các ý tưởng #1–#5, #14, #16, #17 tận dụng trực tiếp dữ liệu/tính năng đã có → rủi ro thấp.
- Các ý tưởng AI (#10–#13) cần nguồn LLM/translate (có thể dùng API miễn phí hoặc khóa người dùng).
- Mọi thay đổi backend/WebSocket/PWA vẫn phải qua quy trình deploy Fly.io test → push/merge (mục 10 roadmap).
- Chưa thực hiện code; tài liệu chỉ để chọn hướng triển khai.
