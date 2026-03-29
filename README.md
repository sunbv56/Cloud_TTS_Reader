# Cloud TTS | Pro Reader Edition

A high-performance modern web application for an immersive reading experience using Microsoft Edge TTS (via `edge-tts`).

## Project Structure

### Backend (`/fly_server`)
- **[main.py](file:///f:/APPS_PJ/Cloud_TTS__Reader/fly_server/main.py)**: The FastAPI server hosting the application. It handles:
    - Text-to-Speech (TTS) streaming via WebSocket and REST.
    - Book parsing logic (extracting chapters and sentences from `.txt`).
    - Serving static frontend files.
- **[kaggle.py](file:///f:/APPS_PJ/Cloud_TTS__Reader/fly_server/kaggle.py)**: Sample code for reference (excluded from main logic).

### Frontend (`/fly_server/static`)
- **[index.html](file:///f:/APPS_PJ/Cloud_TTS__Reader/fly_server/static/index.html)**: The main entry point for the UI. Uses Tailwind CSS v4 and ES Modules.
- **[app.js](file:///f:/APPS_PJ/Cloud_TTS__Reader/fly_server/static/app.js)**: Orchestrates all frontend modules, sets up main application event listeners, and handles Firebase Auth state changes.
- **[firebase-config.js](file:///f:/APPS_PJ/Cloud_TTS__Reader/fly_server/static/firebase-config.js)**: Contains Firebase initialization and exports for Auth, Firestore, and Storage.
- **[state.js](file:///f:/APPS_PJ/Cloud_TTS__Reader/fly_server/static/state.js)**: Maintains the global application `STATE` object and provide helper functions for index management.
- **[audio-engine.js](file:///f:/APPS_PJ/Cloud_TTS__Reader/fly_server/static/audio-engine.js)**: Core logic for real-time audio:
    - WebSocket communication with the backend.
    - Media Source Extensions (MSE) for gapless audio streaming.
    - Prefetching logic for upcoming sentences.
- **[api-service.js](file:///f:/APPS_PJ/Cloud_TTS__Reader/fly_server/static/api-service.js)**: Manages interactions with Firestore (progress sync), Storage (file uploads), and FastAPI parsing endpoints.
- **[ui-renderer.js](file:///f:/APPS_PJ/Cloud_TTS__Reader/fly_server/static/ui-renderer.js)**: Handles rendering of chapters, Table of Contents (TOC), minimaps, and dynamic sentence highlighting.
- **[ui-helpers.js](file:///f:/APPS_PJ/Cloud_TTS__Reader/fly_server/static/ui-helpers.js)**: Simple UI interaction helpers (sidebar toggle, mobile menu handling).
- **[style.css](file:///f:/APPS_PJ/Cloud_TTS__Reader/fly_server/static/style.css)**: Centralized Tailwind CSS configuration and custom animations/styles.
- **[sw.js](file:///f:/APPS_PJ/Cloud_TTS__Reader/fly_server/static/sw.js)**: Service Worker for PWA support.
- **[manifest.json](file:///f:/APPS_PJ/Cloud_TTS__Reader/fly_server/static/manifest.json)**: PWA configuration for mobile installation.

## Key Features
- **Gapless Playback**: Continuous audio streaming using MSE and a custom prefetching queue.
- **Real-time Synchronization**: Seamlessly syncs reading progress across devices via Firestore.
- **Immersive Design**: Modern, responsive interface with Dark Mode, Glassmorphism, and a dedicated reading minimap.
- **Offline Ready**: Fully functional PWA for installation on mobile and desktop.

---

# Cloud TTS | Pro Reader Edition (Tiếng Việt)

Ứng dụng web hiện đại hiệu suất cao mang lại trải nghiệm đọc sách đắm chìm, sử dụng Microsoft Edge TTS (thông qua `edge-tts`).

## Cấu trúc dự án

### Backend (`/fly_server`)
- **[main.py](file:///f:/APPS_PJ/Cloud_TTS__Reader/fly_server/main.py)**: Server FastAPI điều hành ứng dụng. Nó xử lý:
    - Truyền phát Text-to-Speech (TTS) qua WebSocket và REST.
    - Logic phân tích sách (trích xuất chương và câu từ file `.txt`).
    - Phục vụ các file frontend tĩnh.
- **[kaggle.py](file:///f:/APPS_PJ/Cloud_TTS__Reader/fly_server/kaggle.py)**: Mã mẫu để tham khảo (không nằm trong logic chính).

### Frontend (`/fly_server/static`)
- **[index.html](file:///f:/APPS_PJ/Cloud_TTS__Reader/fly_server/static/index.html)**: Điểm vào chính cho giao diện người dùng. Sử dụng Tailwind CSS v4 và ES Modules.
- **[app.js](file:///f:/APPS_PJ/Cloud_TTS__Reader/fly_server/static/app.js)**: Điều phối tất cả các module frontend, thiết lập bộ lắng nghe sự kiện chính và xử lý trạng thái Firebase Auth.
- **[firebase-config.js](file:///f:/APPS_PJ/Cloud_TTS__Reader/fly_server/static/firebase-config.js)**: Chứa khởi tạo Firebase và xuất các dịch vụ Auth, Firestore và Storage.
- **[state.js](file:///f:/APPS_PJ/Cloud_TTS__Reader/fly_server/static/state.js)**: Duy trì đối tượng `STATE` toàn cục và cung cấp các hàm hỗ trợ quản lý chỉ mục.
- **[audio-engine.js](file:///f:/APPS_PJ/Cloud_TTS__Reader/fly_server/static/audio-engine.js)**: Logic cốt lõi cho âm thanh thời gian thực:
    - Giao tiếp WebSocket với backend.
    - Media Source Extensions (MSE) để truyền phát âm thanh không khoảng cách.
    - Logic tải trước (prefetching) cho các câu tiếp theo.
- **[api-service.js](file:///f:/APPS_PJ/Cloud_TTS__Reader/fly_server/static/api-service.js)**: Quản lý tương tác với Firestore (đồng bộ tiến trình), Storage (tải file lên) và các endpoint phân tích của FastAPI.
- **[ui-renderer.js](file:///f:/APPS_PJ/Cloud_TTS__Reader/fly_server/static/ui-renderer.js)**: Xử lý việc hiển thị chương, Mục lục (TOC), minimap và tô sáng câu động.
- **[ui-helpers.js](file:///f:/APPS_PJ/Cloud_TTS__Reader/fly_server/static/ui-helpers.js)**: Các hàm hỗ trợ tương tác UI đơn giản (đóng mở sidebar, menu di động).
- **[style.css](file:///f:/APPS_PJ/Cloud_TTS__Reader/fly_server/static/style.css)**: Cấu hình Tailwind CSS tập trung và các animation/style tùy chỉnh.
- **[sw.js](file:///f:/APPS_PJ/Cloud_TTS__Reader/fly_server/static/sw.js)**: Service Worker để hỗ trợ PWA.
- **[manifest.json](file:///f:/APPS_PJ/Cloud_TTS__Reader/fly_server/static/manifest.json)**: Cấu hình PWA để cài đặt trên thiết bị di động.

## Các tính năng chính
- **Phát lại không khoảng cách**: Truyền phát âm thanh liên tục bằng MSE và hàng đợi tải trước tùy chỉnh.
- **Đồng bộ hóa thời gian thực**: Đồng bộ hóa liền mạch tiến trình đọc trên các thiết bị qua Firestore.
- **Thiết kế đắm chìm**: Giao diện hiện đại, phản hồi tốt với Chế độ tối (Dark Mode), Glassmorphism và minimap dành riêng cho việc đọc.
- **Sẵn sàng ngoại tuyến**: PWA đầy đủ chức năng để cài đặt trên điện thoại và máy tính.
