# Bộ file test backend thủ công

Các file trong thư mục này dùng để kiểm tra parser TXT trên Fly.io.

## Cách test

1. Mở `https://cloud-tts-reader.fly.dev/` và đăng nhập.
2. Chọn luồng import sách TXT.
3. Upload lần lượt từng file `.txt` trong thư mục này.
4. Kiểm tra preview hoặc kết quả import.

## Kết quả mong đợi

- Ba file Unicode hiển thị đúng tiếng Việt: `Đường về quê`, `Tôi yêu tiếng Việt`.
- File Windows-1258 là fixture **không hợp lệ**, dùng để kiểm tra backend từ chối encoding cũ.
- Mỗi file được nhận diện thành 3 chương.
- Ba file Unicode có tiêu đề chương đúng là `Chương 1: Khởi đầu`, `Chương 2: Thử nghiệm`, `Chương 3: Kết quả`.
- File Windows-1258 phải bị từ chối với HTTP 415 và thông báo yêu cầu UTF-8 hoặc UTF-16.
- Không xuất hiện ký tự lỗi như `�`.

## File kiểm tra

- `backend-fixture-utf8.txt`: UTF-8 thông thường.
- `backend-fixture-utf8-bom.txt`: UTF-8 có BOM.
- `backend-fixture-utf16.txt`: UTF-16 little-endian.
- `backend-fixture-windows-1258.txt`: Windows-1258.

Nếu muốn kiểm tra validation upload, thử đổi tạm một file bất kỳ thành `.pdf` hoặc `.docx` rồi upload; backend phải từ chối với HTTP 415 và thông báo chỉ nhận `.txt`.

## Kiểm tra WebSocket

Mở cùng tài khoản ở 3 tab, bắt đầu phát audio ở cả 3 tab. Mặc định backend cho tối đa 2 WebSocket TTS đồng thời trên mỗi UID; kết nối thứ 3 phải bị đóng hoặc báo lỗi.
