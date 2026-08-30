/**
 * UI Interactions & Theme Controller
 */

export const THEMES_DATA = {
    'default': {
        nameEn: 'Imperial Sovereign Gold',
        nameVi: 'Vàng Hoàng Gia Đế Vương',
        moodEn: 'Obsidian Ebony & 24K Gold',
        moodVi: 'Gỗ mun đen · Vàng 24K hoàng gia',
        metaColor: '#0C0A09',
        isLight: false
    },
    'warm-night': {
        nameEn: 'Espresso & Warm Cashmere',
        nameVi: 'Espresso & Lụa Cashmere',
        moodEn: 'Dark Roast & Toffee Cashmere',
        moodVi: 'Cà phê rang sẫm · Lụa hạt dẻ',
        metaColor: '#0F0C0A',
        isLight: false
    },
    'forest': {
        nameEn: 'Aged Bourbon & Smoked Oak',
        nameVi: 'Bourbon & Gỗ Sồi Khói',
        moodEn: 'Aged Oak Cask & Amber Bourbon',
        moodVi: 'Gỗ sồi ủ rượu · Hổ phách hun khói',
        metaColor: '#0D0907',
        isLight: false
    },
    'rose': {
        nameEn: 'Royal Dark Walnut & Bronze',
        nameVi: 'Gỗ Óc Chó & Đồng Cổ',
        moodEn: 'Noble Walnut & Antique Bronze',
        moodVi: 'Gỗ óc chó quý tộc · Đồng thau cổ',
        metaColor: '#0C0A09',
        isLight: false
    },
    'ocean': {
        nameEn: 'Cognac Amber & Havana Leather',
        nameVi: 'Hổ Phách Cognac & Da Havana',
        moodEn: 'Aged Havana & Honey Cognac',
        moodVi: 'Da thuộc Havana · Rượu Cognac mật ong',
        metaColor: '#100B08',
        isLight: false
    },
    'mocha': {
        nameEn: 'Sahara Sand Gold & Dunes',
        nameVi: 'Vàng Cát Sa Mạc Sahara',
        moodEn: 'Desert Midnight & Dune Gold',
        moodVi: 'Cát vàng sa mạc · Đêm huyền bí',
        metaColor: '#0E0C0A',
        isLight: false
    },
    'sepia': {
        nameEn: 'Florentine Antique Sepia',
        nameVi: 'Sepia Phục Hưng Florence',
        moodEn: 'Renaissance Leather & Terracotta',
        moodVi: 'Bản thảo Phục Hưng · Nâu đất nung',
        metaColor: '#14100C',
        isLight: false
    },
    'paper': {
        nameEn: 'Antique Honey & Sandalwood',
        nameVi: 'Vàng Mật Ong & Đàn Hương',
        moodEn: 'Deep Sandalwood & Honey Gold',
        moodVi: 'Gỗ đàn hương tuyền · Mật ong hổ phách',
        metaColor: '#0B0806',
        isLight: false
    },
    'e-ink': {
        nameEn: 'Champagne Brut & Onyx Noir',
        nameVi: 'Champagne Brut & Đá Onyx',
        moodEn: 'Noir Onyx & Polished Champagne',
        moodVi: 'Đá Onyx đen bóng · Rượu Champagne Brut',
        metaColor: '#0A0B0E',
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

    // Quick Appearance & Theme Settings Modal
    const quickSettingsBtn = document.getElementById('quick-settings-btn');
    const quickSettingsModal = document.getElementById('quick-settings-modal');
    const quickSettingsOverlay = document.getElementById('quick-settings-overlay');
    const closeQuickSettingsBtn = document.getElementById('close-quick-settings-btn');
    const quickSettingsDoneBtn = document.getElementById('quick-settings-done-btn');

    function openQuickModal() {
        if (!quickSettingsModal) return;
        quickSettingsModal.classList.remove('hidden');
        quickSettingsModal.classList.add('flex');

        // Sync theme active
        const curTheme = localStorage.getItem('reader-theme') || 'default';
        document.querySelectorAll('.quick-theme-btn').forEach(btn => {
            const isAct = btn.dataset.theme === curTheme;
            btn.classList.toggle('border-primary/50', isAct);
            btn.classList.toggle('bg-primary/15', isAct);
        });

        // Sync font family
        const curFont = localStorage.getItem('reader-font-family') || 'Be Vietnam Pro';
        const qFontSelect = document.getElementById('quick-font-family-select');
        if (qFontSelect) qFontSelect.value = curFont;
        const qFontBadge = document.getElementById('quick-font-family-badge');
        if (qFontBadge) qFontBadge.innerText = curFont;
        const qPreview = document.getElementById('quick-font-sample-preview');
        if (qPreview) qPreview.style.fontFamily = `'${curFont}', sans-serif`;

        // Sync font size
        const curSize = parseInt(localStorage.getItem('reader-font-size') || '20');
        const qSizeRange = document.getElementById('quick-font-size-range');
        const qSizeVal = document.getElementById('quick-font-size-val');
        if (qSizeRange) qSizeRange.value = curSize;
        if (qSizeVal) qSizeVal.innerText = `${curSize}px`;
    }

    function closeQuickModal() {
        if (!quickSettingsModal) return;
        quickSettingsModal.classList.add('hidden');
        quickSettingsModal.classList.remove('flex');
    }

    quickSettingsBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openQuickModal();
    });
    quickSettingsOverlay?.addEventListener('click', closeQuickModal);
    closeQuickSettingsBtn?.addEventListener('click', closeQuickModal);
    quickSettingsDoneBtn?.addEventListener('click', closeQuickModal);

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
