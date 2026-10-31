/**
 * Internationalization (i18n) Module
 */
import { syncThemeControls } from './ui-interactions.js';

export const translations = {
    en: {
        "cloud-tts": "Cloud TTS",
        "pro-reader-edition": "Pro Reader Edition",
        "guest-mode": "Guest Mode",
        "sign-in": "Sign In",
        "account-menu-title": "Accounts on this device",
        "account-add": "Add account",
        "account-sign-out": "Sign out of this account",
        "account-limit": "Up to 5 accounts",
        "navigation": "Navigation",
        "library": "Library",
        "no-books-loaded": "No books loaded.<br>Drag or upload a .txt file!",
        "voice-intelligence": "Voice Intelligence",
        "typography-style": "Typography & Style",
        "skip-dictionary": "Dictionary",
        "reading-theme": "Reading Theme",
        "select-masterpiece": "Select a Masterpiece",
        "standby-mode": "Standby Mode",
        "ready-to-start": "Ready to Start?",
        "select-book-desc": "Select a book from your library or upload a new .txt file to begin your immersive reading experience.",
        "chapters": "Chapters",
        "0-chapters": "0 chapters",
        "selected": "selected",
        "delete-selected": "Delete Selected",
        "download-offline-mp3": "Download Offline MP3",
        "download-source-txt": "TXT",
        "discover-masterpiece": "Discover Your Next Masterpiece",
        "recent-reads": "Recent Reads",
        "import-book": "Import Book",
        "click-or-drag-file": "Click or Drag File",
        "supported-formats": "Supported formats: .txt, .epub, .pdf",
        "view-format-example": "View chapter format",
        "chapter-format-hint": "Use a line containing === to separate chapters. Without ===, the whole file is imported as one chapter.",
        "download-sample-file": "Download sample .txt file",
        "settings": "Settings",
        "reading-insights": "Reading Insights",
        "day-streak": "Day Streak",
        "total-time": "Total Time",
        "books-completed": "Books",
        "avg-speed": "Avg Speed",
        "offline-storage": "Offline Storage",
        "clear-cache": "Clear Cache",
        "locally-cached": "Locally Cached",
        "tab-library": "Books",
        "tab-toc": "Chapters",
        "tab-voice": "Voice",
        "theme-slate-name": "Slate",
        "theme-slate-mood": "Default dark · cool graphite",
        "theme-slate-deep-name": "Deep Slate",
        "theme-slate-deep-mood": "Darker · for a dark room",
        "theme-mist-name": "Mist",
        "theme-mist-mood": "Light · cool grey paper",
        "theme-sepia-name": "Sepia",
        "theme-sepia-mood": "Light · warm paper",
        "keys-play": "play",
        "keys-sentence": "sentence",
        "keys-chapter": "chapter",
        "search-books": "Search books",
        "app-menu-label": "Settings and tools",
        "menu-settings": "Display & voice settings",
        "menu-stats": "Reading stats",
        "menu-sync": "Sync library",
        "menu-language": "Switch language",
        "menu-fullscreen": "Full screen",
        "offline-banner": "You are offline. New changes cannot be saved yet.",
        "player-label": "Player",
        "quick-settings-title": "Quick Settings Master Hub",
        "quick-settings-subtitle": "Quick Settings Master Hub",
        "quick-tab-appearance": "Appearance",
        "quick-tab-voice": "Voice & Audio",
        "quick-tab-experience": "Utilities",
        "quick-font-family": "Vietnamese Reading Font",
        "quick-font-size": "Font Size",
        "quick-font-color": "Reading Text Color",
        "quick-color-default": "Theme Default",
        "quick-theme-header": "Colour theme",
        "quick-voice-header": "AI Reading Voice",
        "quick-speed-header": "Playback Speed",
        "quick-pitch-header": "Vocal Pitch",
        "quick-workers-header": "Parallel Workers",
        "quick-lite-mode-title": "Audio-Only Pocket Mode",
        "quick-lite-mode-desc": "Blackout screen with double-tap protection for pocket listening.",
        "pocket-mode-active": "Audio-Only Mode (Pocket Lock Active)",
        "pocket-mode-exit": "Double-tap to wake screen",
        "pocket-double-tap-hint": "Tap once more to unlock",
        "pocket-anti-accidental-hint": "Protected against accidental touch in pocket",
        "quick-zen-mode-title": "Zen Focus Reading Mode",
        "quick-zen-mode-desc": "Hides toolbars for an uninterrupted pure reading space.",
        "quick-wakelock-title": "Keep Screen Awake (WakeLock)",
        "quick-wakelock-desc": "Prevents screen from dimming or turning off during reading.",
        "quick-lang-title": "Interface Language",
        "quick-lang-desc": "Switch between Vietnamese and English.",
        "quick-auto-saved": "Auto-saved to device",
        "quick-done-btn": "Done"
    },
    vi: {
        "cloud-tts": "Cloud TTS",
        "pro-reader-edition": "Phiên bản Pro",
        "guest-mode": "Chế độ Khách",
        "sign-in": "Đăng Nhập",
        "account-menu-title": "Tài khoản trên máy này",
        "account-add": "Thêm tài khoản",
        "account-sign-out": "Đăng xuất tài khoản này",
        "account-limit": "Tối đa 5 tài khoản",
        "navigation": "Điều hướng",
        "library": "Thư viện",
        "no-books-loaded": "Chưa có sách nào.<br>Kéo thả hoặc tải lên file .txt!",
        "voice-intelligence": "Giọng đọc AI",
        "typography-style": "Giao diện & Chữ",
        "skip-dictionary": "Từ điển",
        "reading-theme": "Chủ đề đọc",
        "select-masterpiece": "Chọn một tác phẩm",
        "standby-mode": "Chế độ chờ",
        "ready-to-start": "Sẵn sàng chưa?",
        "select-book-desc": "Chọn một cuốn sách từ thư viện hoặc tải lên file .txt mới để bắt đầu trải nghiệm đọc.",
        "chapters": "Chương",
        "0-chapters": "0 chương",
        "selected": "đã chọn",
        "delete-selected": "Xóa mục đã chọn",
        "download-offline-mp3": "Tải MP3 ngoại tuyến",
        "download-source-txt": "TXT",
        "discover-masterpiece": "Khám phá tác phẩm mới",
        "recent-reads": "Đọc gần đây",
        "import-book": "Nhập sách",
        "click-or-drag-file": "Nhấn hoặc kéo thả tệp",
        "supported-formats": "Định dạng hỗ trợ: .txt, .epub, .pdf",
        "view-format-example": "Xem định dạng chương",
        "chapter-format-hint": "Dùng một dòng chứa === để phân cách các chương. Nếu không có ===, toàn bộ file sẽ được nhập thành một chương.",
        "download-sample-file": "Tải file mẫu .txt",
        "settings": "Cài đặt",
        "reading-insights": "Phân tích đọc sách",
        "day-streak": "Ngày liên tiếp",
        "total-time": "Tổng thời gian",
        "books-completed": "Sách đã đọc",
        "avg-speed": "Tốc độ TB",
        "offline-storage": "Lưu trữ ngoại tuyến",
        "clear-cache": "Xóa bộ nhớ đệm",
        "locally-cached": "Đã lưu cục bộ",
        "tab-library": "Truyện",
        "tab-toc": "Chương",
        "tab-voice": "Giọng",
        "theme-slate-name": "Slate",
        "theme-slate-mood": "Tối mặc định · xám than lạnh",
        "theme-slate-deep-name": "Slate sâu",
        "theme-slate-deep-mood": "Tối hơn · cho phòng tối",
        "theme-mist-name": "Sương",
        "theme-mist-mood": "Sáng · giấy xám lạnh",
        "theme-sepia-name": "Sepia",
        "theme-sepia-mood": "Sáng · giấy ấm",
        "keys-play": "phát",
        "keys-sentence": "câu",
        "keys-chapter": "chương",
        "search-books": "Tìm truyện",
        "app-menu-label": "Cài đặt và tiện ích",
        "menu-settings": "Cài đặt hiển thị & giọng",
        "menu-stats": "Thống kê đọc",
        "menu-sync": "Đồng bộ thư viện",
        "menu-language": "Đổi ngôn ngữ",
        "menu-fullscreen": "Toàn màn hình",
        "offline-banner": "Bạn đang ngoại tuyến. Các thay đổi mới chưa thể lưu.",
        "player-label": "Trình phát",
        "quick-settings-title": "Trung Tâm Cài Đặt Nhanh",
        "quick-settings-subtitle": "Quick Settings Master Hub",
        "quick-tab-appearance": "Giao diện",
        "quick-tab-voice": "Giọng đọc",
        "quick-tab-experience": "Tiện ích",
        "quick-font-family": "Font chữ Tiếng Việt",
        "quick-font-size": "Kích thước chữ",
        "quick-font-color": "Màu sắc chữ đọc",
        "quick-color-default": "Mặc định Theme",
        "quick-theme-header": "Màu giao diện",
        "quick-voice-header": "Giọng đọc AI",
        "quick-speed-header": "Tốc độ đọc (Playback Speed)",
        "quick-pitch-header": "Cao độ giọng (Vocal Pitch)",
        "quick-workers-header": "Luồng xử lý song song",
        "quick-lite-mode-title": "Chế độ Chỉ Nghe Audio (Pocket Mode)",
        "quick-lite-mode-desc": "Tối đen màn hình có khóa chạm 2 lần chống chạm nhầm khi bỏ túi.",
        "pocket-mode-active": "Chế độ chỉ nghe (Đang khóa chống chạm nhầm)",
        "pocket-mode-exit": "Chạm 2 lần để mở màn hình",
        "pocket-double-tap-hint": "Chạm thêm lần nữa để mở khóa",
        "pocket-anti-accidental-hint": "Chống chạm nhầm khi để trong túi quần",
        "quick-zen-mode-title": "Chế độ Đọc Tập Trung (Zen Mode)",
        "quick-zen-mode-desc": "Ẩn các thanh công cụ thừa, mang lại không gian đọc thuần khiết.",
        "quick-wakelock-title": "Giữ Màn Hình Luôn Sáng (WakeLock)",
        "quick-wakelock-desc": "Ngăn thiết bị tự động khóa hoặc tắt màn hình trong khi đang đọc.",
        "quick-lang-title": "Ngôn ngữ Giao diện (Language)",
        "quick-lang-desc": "Chuyển đổi giữa Tiếng Việt và English.",
        "quick-auto-saved": "Tự động lưu 100% vào thiết bị",
        "quick-done-btn": "Hoàn tất"
    }
};

export function applyLanguage(lang) {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (translations[lang] && translations[lang][key]) {
            el.innerHTML = translations[lang][key];
        }
    });

    document.querySelectorAll('[data-i18n-aria]').forEach(el => {
        const value = translations[lang]?.[el.getAttribute('data-i18n-aria')];
        if (value) {
            el.setAttribute('aria-label', value);
            if (el.hasAttribute('title')) el.title = value;
        }
    });

    // The language row shows the language a click switches to.
    const langValue = document.getElementById('lang-btn-value');
    if (langValue) langValue.textContent = lang === 'en' ? 'Tiếng Việt' : 'English';

    let activeThemeId = 'slate';
    try {
        activeThemeId = localStorage.getItem('reader-theme') || 'slate';
    } catch (_) {}
    syncThemeControls(activeThemeId);
}

if (typeof window !== 'undefined') {
    window.translations = translations;
    window.applyLanguage = applyLanguage;
}

export function initI18n() {
    const langBtn = document.getElementById('lang-btn');
    const storedLang = () => {
        try {
            return localStorage.getItem('ui-lang') || 'en';
        } catch (_) {
            return 'en';
        }
    };

    // Read the stored language on every click so Quick Settings and this row never disagree.
    langBtn?.addEventListener('click', () => {
        const nextLang = storedLang() === 'en' ? 'vi' : 'en';
        try {
            localStorage.setItem('ui-lang', nextLang);
        } catch (_) {}
        applyLanguage(nextLang);
        window.QuickSettingsController?.updateLangButtons?.(nextLang);
    });

    applyLanguage(storedLang());
}

