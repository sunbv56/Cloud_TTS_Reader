# Chuyển tài khoản nhanh (multi-account)

Chốt ngày 2026-10-31. Áp dụng cho cả Fly (`main`) và Botkeep (`deploy/botkeep`).

## Quyết định

1. **Cơ chế**: mỗi tài khoản là một Firebase app riêng. App cũ `[DEFAULT]` giữ nguyên làm tài khoản đầu tiên, các tài khoản thêm sau tên là `acc-<id>`. Phiên của từng app do Firebase tự lưu trong IndexedDB.
   Mỗi lúc chỉ **một** app/Auth/Firestore được khởi tạo. Các tài khoản khác chỉ là hồ sơ trong localStorage (`tts.accounts.v1`: uid, tên, email, ảnh). Khi chuyển: lưu dữ liệu → `waitForPendingWrites` → `deleteApp` app cũ → khởi tạo app mới, phiên khôi phục từ IndexedDB, không hiện popup.
2. **UI**: bấm avatar trên header để mở menu: danh sách tài khoản (✓ ở tài khoản đang dùng), "Thêm tài khoản" (Google `prompt=select_account`), "Đăng xuất tài khoản này". Tối đa 5 tài khoản.
3. **Khi chuyển**: lưu tiến độ + thống kê của tài khoản cũ, dừng phát, đóng truyện, xoá cache ảnh/manifest, đóng WebSocket, huỷ hàng đợi retry, rồi tải thư viện tài khoản mới. Không phát tiếp truyện cũ.
4. **Bảo mật**: không tự lưu token, chỉ dùng persistence của Firebase. Đăng xuất = `signOut` trên đúng app đó (xoá refresh token khỏi máy) rồi gỡ hồ sơ. Tên/email/ảnh render bằng DOM API (`textContent`), không qua `innerHTML`. Ảnh chỉ nhận URL `https:`. Backend giữ nguyên, vẫn verify ID token theo từng request.
5. **Firebase Console**: không cần đổi gì. App phụ dùng chung config và authorized domain.
6. **Triển khai**: nhánh `feat/tts-1-quick-account-switch` → MR vào `main` (Fly tự deploy) → merge `main` vào `deploy/botkeep` cho Botkeep.
