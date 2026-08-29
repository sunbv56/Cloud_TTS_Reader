/**
 * UI Interactions & Theme Controller
 */

export const THEMES_DATA = {
    'default': {
        nameEn: 'Obsidian Champagne',
        nameVi: 'Obsidian Champagne',
        moodEn: 'Brut Champagne & Noir Obsidian',
        moodVi: 'Vàng Champagne mờ · Đen tuyền',
        metaColor: '#090B0E',
        isLight: false
    },
    'warm-night': {
        nameEn: 'Espresso & Cashmere',
        nameVi: 'Espresso & Cashmere',
        moodEn: 'Dark Espresso & Soft Cashmere',
        moodVi: 'Cà phê đậm · Gỗ óc chó trầm',
        metaColor: '#0F0D0C',
        isLight: false
    },
    'forest': {
        nameEn: 'Muted Pine & Sage',
        nameVi: 'Thông Rừng & Xô Thơm',
        moodEn: 'Nordic Pine & Muted Sage',
        moodVi: 'Lá xô thơm · Rừng thông rêu',
        metaColor: '#070B09',
        isLight: false
    },
    'rose': {
        nameEn: 'Velvet Rosé & Noir',
        nameVi: 'Hoa Hồng & Nhung Đen',
        moodEn: 'Vintage Rosé & Noir Velvet',
        moodVi: 'Hoa hồng cổ điển · Nhung bordeaux',
        metaColor: '#0F0A0D',
        isLight: false
    },
    'ocean': {
        nameEn: 'Midnight Navy Mist',
        nameVi: 'Hải Quân Biển Đêm',
        moodEn: 'Midnight Abyss & Steel Mist',
        moodVi: 'Xanh thép mist · Biển đêm sâu',
        metaColor: '#060A10',
        isLight: false
    },
    'mocha': {
        nameEn: 'Smoked Slate & Titanium',
        nameVi: 'Titan & Tro Khói Bắc Âu',
        moodEn: 'Brushed Titanium & Dark Slate',
        moodVi: 'Titanium mờ · Khói tro tối giản',
        metaColor: '#0B0D11',
        isLight: false
    },
    'sepia': {
        nameEn: 'Editorial Ivory',
        nameVi: 'Giấy Ngà Mỹ Thuật',
        moodEn: 'Fine Art Vellum & Charcoal Ink',
        moodVi: 'Giấy ngà vellum · Mực than mềm',
        metaColor: '#F7F5F0',
        isLight: true
    },
    'paper': {
        nameEn: 'Swiss Studio Minimal',
        nameVi: 'Studio Thụy Sĩ',
        moodEn: 'Alabaster Ceramic & Deep Slate',
        moodVi: 'Men sứ trắng · Xanh thép đồ họa',
        metaColor: '#F9FAFB',
        isLight: true
    },
    'e-ink': {
        nameEn: 'Monolith Matte',
        nameVi: 'Bạch Kim Monolith',
        moodEn: 'Anti-Glare Carbon & Muted Platinum',
        moodVi: 'Bạch kim chải mờ · Chống lóa',
        metaColor: '#080808',
        isLight: false
    }
};

export function applyTheme(themeId) {
    const root = document.documentElement;
    const theme = THEMES_DATA[themeId] || THEMES_DATA['default'];
    const actualId = THEMES_DATA[themeId] ? themeId : 'default';

    root.setAttribute('data-theme', actualId);

    const metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor) {
        metaThemeColor.content = theme.metaColor;
    }

    document.querySelectorAll('.theme-card, .theme-swatch').forEach(el => {
        el.classList.toggle('active', el.dataset.theme === actualId);
    });

    let lang = 'en';
    try {
        lang = localStorage.getItem('ui-lang') || 'en';
    } catch (_) {}
    const nameEl = document.getElementById('current-theme-name');
    if (nameEl) nameEl.textContent = lang === 'vi' ? theme.nameVi : theme.nameEn;
    const moodEl = document.getElementById('current-theme-mood');
    if (moodEl) moodEl.textContent = lang === 'vi' ? theme.moodVi : theme.moodEn;

    try {
        localStorage.setItem('reader-theme', actualId);
    } catch (e) {
        console.warn('[Theme] Failed to persist theme to localStorage:', e);
    }

    if (typeof window !== 'undefined' && window.STATE) {
        window.STATE.theme = actualId;
    }

    window.dispatchEvent(new CustomEvent('themechange', { detail: { themeId: actualId, theme } }));
}

export function toggleSidebar(show) {
    const sidebar = document.getElementById('sidebar-container');
    const overlay = document.getElementById('sidebar-overlay');
    if (!sidebar || !overlay) return;
    if (show) {
        sidebar.classList.remove('hidden');
        sidebar.classList.add('open');
        overlay.classList.remove('hidden');
        setTimeout(() => overlay.classList.add('opacity-100'), 10);
    } else {
        sidebar.classList.remove('open');
        overlay.classList.remove('opacity-100');
        setTimeout(() => overlay.classList.add('hidden'), 300);
    }
}

export function toggleVoiceSettings(expand = true) {
    const voiceBody = document.getElementById('voice-settings-body');
    if (!voiceBody) return;
    voiceBody.style.maxHeight = '';
    voiceBody.style.opacity = '1';
    voiceBody.style.marginTop = '';
}

export function toggleVisualSettings(expand = true) {
    const visualBody = document.getElementById('visual-settings-body');
    if (!visualBody) return;
    visualBody.style.maxHeight = '';
    visualBody.style.opacity = '1';
    visualBody.style.marginTop = '';
}

export function toggleDictPanel(expand = true) {
    const dictBody = document.getElementById('dict-settings-body');
    if (!dictBody) return;
    dictBody.style.maxHeight = '';
    dictBody.style.opacity = '1';
    dictBody.style.marginTop = '';
}

export function showDictStatus(msg) {
    const dictStatus = document.getElementById('dict-status');
    if (!dictStatus) return;
    dictStatus.textContent = msg;
    dictStatus.style.opacity = '1';
    setTimeout(() => { dictStatus.style.opacity = '0'; }, 2000);
}

// Bind to window for global access across legacy modules & DOM event listeners
if (typeof window !== 'undefined') {
    window.THEMES_DATA = THEMES_DATA;
    window.applyTheme = applyTheme;
    window.toggleSidebar = toggleSidebar;
    window.toggleVoiceSettings = toggleVoiceSettings;
    window.toggleVisualSettings = toggleVisualSettings;
    window.toggleDictPanel = toggleDictPanel;
    window.showDictStatus = showDictStatus;
}

export function initUIInteractions() {
    const mobileMenuBtn = document.getElementById('mobile-menu-btn');
    const overlay = document.getElementById('sidebar-overlay');
    const closeSidebar = document.getElementById('close-sidebar');

    mobileMenuBtn?.addEventListener('click', () => toggleSidebar(true));
    overlay?.addEventListener('click', () => toggleSidebar(false));
    closeSidebar?.addEventListener('click', () => toggleSidebar(false));

    window.addEventListener('resize', () => {
        if (window.innerWidth >= 1024) toggleSidebar(false);
    });

    // Theme Picker Panel
    const themeToggleBtn = document.getElementById('theme-toggle-btn');
    const themePickerPanel = document.getElementById('theme-picker-panel');
    const themeChevron = document.getElementById('theme-chevron');

    themeToggleBtn?.addEventListener('click', () => {
        if (!themePickerPanel) return;
        const isOpen = themePickerPanel.classList.contains('open') || themePickerPanel.classList.contains('active');
        themePickerPanel.classList.toggle('open', !isOpen);
        themePickerPanel.classList.toggle('active', !isOpen);
        if (themeChevron) themeChevron.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(180deg)';
    });

    document.querySelectorAll('.theme-card, .theme-swatch').forEach(card => {
        card.addEventListener('click', (e) => {
            e.stopPropagation();
            applyTheme(card.dataset.theme);
        });
    });

    try {
        const savedTheme = localStorage.getItem('reader-theme');
        if (savedTheme && THEMES_DATA[savedTheme]) {
            applyTheme(savedTheme);
        } else {
            applyTheme('default');
        }
    } catch (_) {
        applyTheme('default');
    }

    // Dictionary Panel handlers
    const dictInput = document.getElementById('dict-input');
    const dictSaveBtn = document.getElementById('dict-save-btn');
    const dictClearBtn = document.getElementById('dict-clear-btn');

    if (dictInput) {
        dictInput.value = localStorage.getItem('tts-skip-dictionary') || '';
    }

    dictSaveBtn?.addEventListener('click', () => {
        if (typeof window.saveSkipDictionary === 'function') {
            window.saveSkipDictionary(dictInput.value);
        } else {
            localStorage.setItem('tts-skip-dictionary', dictInput.value.trim());
        }
        showDictStatus('✓ Dictionary saved!');
    });

    dictClearBtn?.addEventListener('click', () => {
        if (dictInput) dictInput.value = '';
        if (typeof window.saveSkipDictionary === 'function') {
            window.saveSkipDictionary('');
        } else {
            localStorage.setItem('tts-skip-dictionary', '');
        }
        showDictStatus('✓ Dictionary cleared!');
    });

    // Ripple effect
    function createRipple(event) {
        const button = event.currentTarget;
        const circle = document.createElement("span");
        const diameter = Math.max(button.clientWidth, button.clientHeight);
        const radius = diameter / 2;
        const rect = button.getBoundingClientRect();
        circle.style.width = circle.style.height = `${diameter}px`;
        circle.style.left = `${event.clientX - rect.left - radius}px`;
        circle.style.top = `${event.clientY - rect.top - radius}px`;
        circle.classList.add("ripple");
        const ripple = button.getElementsByClassName("ripple")[0];
        if (ripple) ripple.remove();
        button.appendChild(circle);
    }

    document.querySelectorAll(".ripple-btn").forEach(button => {
        button.addEventListener("click", createRipple);
    });
}
