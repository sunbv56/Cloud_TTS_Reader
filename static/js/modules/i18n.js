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
        "theme-default-mood": "European Royalty · 24K Gold & Obsidian",
        "theme-warm-night-name": "Cyberpunk Neon Horizon",
        "theme-warm-night-mood": "Neo-Tokyo Midnight · Electric Cyan Laser HUD",
        "theme-forest-name": "Emerald Zen Sanctuary",
        "theme-forest-mood": "Bamboo Mist & Imperial Jade Tea House",
        "theme-rose-name": "Bordeaux Haute Couture",
        "theme-rose-mood": "Parisian Velvet Noir & Rose Gold Champagne",
        "theme-ocean-name": "Monaco Deep Sapphire",
        "theme-ocean-mood": "Abyssal Oceanic Trench & Bioluminescent Waves",
        "theme-mocha-name": "Nordic Bauhaus Studio",
        "theme-mocha-mood": "Scandinavian Slate & Bauhaus Cobalt Minimalism",
        "theme-sepia-name": "Florentine Renaissance Parchment",
        "theme-sepia-mood": "16th Century Vellum & Antique Terracotta Bronze",
        "theme-paper-name": "Swiss Editorial Newsprint",
        "theme-paper-mood": "Alabaster White Paper & International Klein Blue",
        "theme-e-ink-name": "Kindle Paperwhite Monolith",
        "theme-e-ink-mood": "Anti-Glare Paperwhite & Pure Matte Monochrome"
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
        "theme-default-mood": "Vương giả Châu Âu · Vàng 24K & Gỗ mun",
        "theme-warm-night-name": "Cyberpunk Neon Viễn Tưởng",
        "theme-warm-night-mood": "Công nghệ viễn tưởng · Laser Cyan HUD",
        "theme-forest-name": "Ngọc Lục Bảo Thiền Định",
        "theme-forest-mood": "Trà đạo thiền định · Rừng thông ngập sương",
        "theme-rose-name": "Vang Đỏ Bordeaux Quý Tộc",
        "theme-rose-mood": "Thời trang Paris · Vàng hồng & Nhung đỏ",
        "theme-ocean-name": "Lam Ngọc Biển Sâu Monaco",
        "theme-ocean-mood": "Đại dương sâu thẳm · Lam ngọc phát quang",
        "theme-mocha-name": "Tối Giản Bắc Âu Bauhaus",
        "theme-mocha-mood": "Kiến trúc Scandinavian · Sắc nét & Tối giản",
        "theme-sepia-name": "Bản Thảo Phục Hưng Florence",
        "theme-sepia-mood": "Giấy da vellum cổ · Mực đất nung ấm áp",
        "theme-paper-name": "Ấn Phẩm Nghệ Thuật Thụy Sĩ",
        "theme-paper-mood": "Giấy trắng Alabaster · Mực in tạp chí nghệ thuật",
        "theme-e-ink-name": "Mực Điện Tử Kindle Monolith",
        "theme-e-ink-mood": "E-Ink chống chói · Tối ưu mắt đọc xuyên đêm"
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

