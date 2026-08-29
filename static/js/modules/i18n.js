/**
 * Internationalization (i18n) Module
 */
import { THEMES_DATA } from './ui-interactions.js';

export const translations = {
    en: {
        "cloud-tts": "CLOUD TTS",
        "pro-reader-edition": "Pro Reader Edition",
        "guest-mode": "Guest Mode",
        "sign-in": "Sign In",
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
        "theme-default-name": "Imperial Sovereign Gold",
        "theme-default-mood": "Obsidian Ebony & 24K Gold",
        "theme-warm-night-name": "Espresso & Warm Cashmere",
        "theme-warm-night-mood": "Dark Roast & Toffee Cashmere",
        "theme-forest-name": "Aged Bourbon & Smoked Oak",
        "theme-forest-mood": "Aged Oak Cask & Amber Bourbon",
        "theme-rose-name": "Royal Dark Walnut & Bronze",
        "theme-rose-mood": "Noble Walnut & Antique Bronze",
        "theme-ocean-name": "Cognac Amber & Havana Leather",
        "theme-ocean-mood": "Aged Havana & Honey Cognac",
        "theme-mocha-name": "Sahara Sand Gold & Dunes",
        "theme-mocha-mood": "Desert Midnight & Dune Gold",
        "theme-sepia-name": "Florentine Antique Sepia",
        "theme-sepia-mood": "Renaissance Leather & Terracotta",
        "theme-paper-name": "Antique Honey & Sandalwood",
        "theme-paper-mood": "Deep Sandalwood & Honey Gold",
        "theme-e-ink-name": "Champagne Brut & Onyx Noir",
        "theme-e-ink-mood": "Noir Onyx & Polished Champagne"
    },
    vi: {
        "cloud-tts": "CLOUD TTS",
        "pro-reader-edition": "Phiên bản Pro",
        "guest-mode": "Chế độ Khách",
        "sign-in": "Đăng Nhập",
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
        "theme-default-name": "Vàng Hoàng Gia Đế Vương",
        "theme-default-mood": "Gỗ mun đen · Vàng 24K hoàng gia",
        "theme-warm-night-name": "Espresso & Lụa Cashmere",
        "theme-warm-night-mood": "Cà phê rang sẫm · Lụa hạt dẻ",
        "theme-forest-name": "Bourbon & Gỗ Sồi Khói",
        "theme-forest-mood": "Gỗ sồi ủ rượu · Hổ phách hun khói",
        "theme-rose-name": "Gỗ Óc Chó & Đồng Cổ",
        "theme-rose-mood": "Gỗ óc chó quý tộc · Đồng thau cổ",
        "theme-ocean-name": "Hổ Phách Cognac & Da Havana",
        "theme-ocean-mood": "Da thuộc Havana · Rượu Cognac mật ong",
        "theme-mocha-name": "Vàng Cát Sa Mạc Sahara",
        "theme-mocha-mood": "Cát vàng sa mạc · Đêm huyền bí",
        "theme-sepia-name": "Sepia Phục Hưng Florence",
        "theme-sepia-mood": "Bản thảo Phục Hưng · Nâu đất nung",
        "theme-paper-name": "Vàng Mật Ong & Đàn Hương",
        "theme-paper-mood": "Gỗ đàn hương tuyền · Mật ong hổ phách",
        "theme-e-ink-name": "Champagne Brut & Đá Onyx",
        "theme-e-ink-mood": "Đá Onyx đen bóng · Rượu Champagne Brut"
    }
};

export function applyLanguage(lang) {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (translations[lang] && translations[lang][key]) {
            el.innerHTML = translations[lang][key];
        }
    });

    const langBtn = document.getElementById('lang-btn');
    if (langBtn) langBtn.textContent = lang === 'en' ? 'VI' : 'EN';

    let activeThemeId = 'default';
    try {
        activeThemeId = localStorage.getItem('reader-theme') || 'default';
    } catch (_) {}
    if (THEMES_DATA[activeThemeId]) {
        const t = THEMES_DATA[activeThemeId];
        const nameEl = document.getElementById('current-theme-name');
        if (nameEl) nameEl.textContent = lang === 'vi' ? t.nameVi : t.nameEn;
        const moodEl = document.getElementById('current-theme-mood');
        if (moodEl) moodEl.textContent = lang === 'vi' ? t.moodVi : t.moodEn;
    }
}

if (typeof window !== 'undefined') {
    window.translations = translations;
    window.applyLanguage = applyLanguage;
}

export function initI18n() {
    const langBtn = document.getElementById('lang-btn');
    let currentLang = 'en';
    try {
        currentLang = localStorage.getItem('ui-lang') || 'en';
    } catch (_) {}

    langBtn?.addEventListener('click', () => {
        currentLang = currentLang === 'en' ? 'vi' : 'en';
        try {
            localStorage.setItem('ui-lang', currentLang);
        } catch (_) {}
        applyLanguage(currentLang);
    });

    applyLanguage(currentLang);
}

