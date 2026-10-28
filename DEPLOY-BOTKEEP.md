# Deploy lên Botkeep (Pterodactyl)

Botkeep không dùng `Dockerfile`/`fly.toml`; nó chạy `python /home/container/main.py`.

1. **Files**: nội dung repo phải nằm thẳng trong `/home/container` (có `main.py`, `app/`, `static/`),
   không nằm trong thư mục con. Nếu egg hỗ trợ Git: repo `https://github.com/sunbv56/Cloud_TTS_Reader.git`, branch `deploy/botkeep`.
2. **Startup**: file chạy `main.py`, requirements file `requirements.txt`.
3. **Cổng**: app tự nghe cổng `SERVER_PORT` do Pterodactyl cấp (xem tab **Network**).
4. **Biến môi trường**: tạo `/home/container/.env` theo `.env.example`
   (`FIREBASE_SERVICE_ACCOUNT`, `STORAGE_BACKEND=b2`, `B2_*`, ...). `.env` không có trong git.
5. **Truy cập**: `http://<IP>:<cổng>` ở tab Network. Muốn domain + HTTPS (cần cho Firebase Auth/WebSocket
   trên trình duyệt) thì trỏ domain qua Cloudflare/reverse proxy về IP:cổng đó, và thêm domain vào
   Firebase Auth → Authorized domains.
