/**
 * UI Interactions & Theme Controller
 */

export const THEMES_DATA = {
    'default': {
        nameEn: 'Imperial Sovereign Gold',
        nameVi: 'Vàng Hoàng Gia Đế Vương',
        moodEn: 'European Royalty · 24K Gold & Obsidian',
        moodVi: 'Vương giả Châu Âu · Vàng 24K & Gỗ mun',
        metaColor: '#0A0908',
        isLight: false
    },
    'warm-night': {
        nameEn: 'Cyberpunk Neon Horizon',
        nameVi: 'Cyberpunk Neon Viễn Tưởng',
        moodEn: 'Neo-Tokyo Midnight · Electric Cyan Laser HUD',
        moodVi: 'Công nghệ viễn tưởng · Laser Cyan HUD',
        metaColor: '#05070D',
        isLight: false
    },
    'forest': {
        nameEn: 'Emerald Zen Sanctuary',
        nameVi: 'Ngọc Lục Bảo Thiền Định',
        moodEn: 'Bamboo Mist & Imperial Jade Tea House',
        moodVi: 'Trà đạo thiền định · Rừng thông ngập sương',
        metaColor: '#050E0A',
        isLight: false
    },
    'rose': {
        nameEn: 'Bordeaux Haute Couture',
        nameVi: 'Vang Đỏ Bordeaux Quý Tộc',
        moodEn: 'Parisian Velvet Noir & Rose Gold Champagne',
        moodVi: 'Thời trang Paris · Vàng hồng & Nhung đỏ',
        metaColor: '#0E050A',
        isLight: false
    },
    'ocean': {
        nameEn: 'Monaco Deep Sapphire',
        nameVi: 'Lam Ngọc Biển Sâu Monaco',
        moodEn: 'Abyssal Oceanic Trench & Bioluminescent Waves',
        moodVi: 'Đại dương sâu thẳm · Lam ngọc phát quang',
        metaColor: '#030712',
        isLight: false
    },
    'mocha': {
        nameEn: 'Nordic Bauhaus Studio',
        nameVi: 'Tối Giản Bắc Âu Bauhaus',
        moodEn: 'Scandinavian Slate & Bauhaus Cobalt Minimalism',
        moodVi: 'Kiến trúc Scandinavian · Sắc nét & Tối giản',
        metaColor: '#0B0E14',
        isLight: false
    },
    'sepia': {
        nameEn: 'Florentine Renaissance Parchment',
        nameVi: 'Bản Thảo Phục Hưng Florence',
        moodEn: '16th Century Vellum & Antique Terracotta Bronze',
        moodVi: 'Giấy da vellum cổ · Mực đất nung ấm áp',
        metaColor: '#F5EEDC',
        isLight: true
    },
    'paper': {
        nameEn: 'Swiss Editorial Newsprint',
        nameVi: 'Ấn Phẩm Nghệ Thuật Thụy Sĩ',
        moodEn: 'Alabaster White Paper & International Klein Blue',
        moodVi: 'Giấy trắng Alabaster · Mực in tạp chí nghệ thuật',
        metaColor: '#F8F9FA',
        isLight: true
    },
    'e-ink': {
        nameEn: 'Kindle Paperwhite Monolith',
        nameVi: 'Mực Điện Tử Kindle Monolith',
        moodEn: 'Anti-Glare Paperwhite & Pure Matte Monochrome',
        moodVi: 'E-Ink chống chói · Tối ưu mắt đọc xuyên đêm',
        metaColor: '#0B0C0E',
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

export const QuickSettingsController = {
    modal: null,
    overlay: null,
    
    init() {
        this.modal = document.getElementById('quick-settings-modal');
        this.overlay = document.getElementById('quick-settings-overlay');
        
        // Tab switching
        document.querySelectorAll('.quick-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const targetTab = btn.dataset.tab;
                this.switchTab(targetTab);
            });
        });

        // Close handlers
        document.getElementById('close-quick-settings-btn')?.addEventListener('click', () => this.close());
        document.getElementById('quick-settings-done-btn')?.addEventListener('click', () => this.close());
        this.overlay?.addEventListener('click', () => this.close());
        
        // ESC key handler
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen()) {
                this.close();
            }
        });

        // Quick Settings Button on Top Nav
        document.getElementById('quick-settings-btn')?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.open();
        });

        // Font Family Select
        const qFontSelect = document.getElementById('quick-font-family-select');
        qFontSelect?.addEventListener('change', (e) => {
            this.setFontFamily(e.target.value);
        });

        // Font Size Range
        const qSizeRange = document.getElementById('quick-font-size-range');
        qSizeRange?.addEventListener('input', (e) => {
            this.setFontSize(parseInt(e.target.value));
        });

        // Text Color Picker
        const qColorPicker = document.getElementById('quick-font-color-picker');
        qColorPicker?.addEventListener('input', (e) => {
            this.setTextColor(e.target.value);
        });

        // Preset Colors
        document.querySelectorAll('.quick-preset-color').forEach(btn => {
            btn.addEventListener('click', () => {
                this.setTextColor(btn.dataset.color);
            });
        });

        // Reset Text Color
        document.getElementById('quick-color-reset-btn')?.addEventListener('click', () => {
            this.setTextColor('default');
        });

        // Themes
        document.querySelectorAll('.quick-theme-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.setTheme(btn.dataset.theme);
            });
        });

        // Voice Select
        const qVoiceSelect = document.getElementById('quick-voice-select');
        qVoiceSelect?.addEventListener('change', (e) => {
            this.setVoice(e.target.value);
        });

        // Speed Range
        const qSpeedRange = document.getElementById('quick-speed-range');
        qSpeedRange?.addEventListener('input', (e) => {
            this.setSpeed(parseFloat(e.target.value));
        });

        // Pitch Range
        const qPitchRange = document.getElementById('quick-pitch-range');
        qPitchRange?.addEventListener('input', (e) => {
            this.setPitch(parseInt(e.target.value));
        });

        // Workers Range
        const qWorkersRange = document.getElementById('quick-workers-range');
        qWorkersRange?.addEventListener('input', (e) => {
            this.setWorkers(parseInt(e.target.value));
        });

        // Lite Mode Toggle
        const qLiteToggle = document.getElementById('quick-lite-mode-toggle');
        qLiteToggle?.addEventListener('change', (e) => {
            this.setLiteMode(e.target.checked);
        });

        // Zen Mode Toggle
        const qZenToggle = document.getElementById('quick-zen-mode-toggle');
        qZenToggle?.addEventListener('change', (e) => {
            this.setZenMode(e.target.checked);
        });

        // WakeLock Toggle
        const qWakeToggle = document.getElementById('quick-wakelock-toggle');
        qWakeToggle?.addEventListener('change', (e) => {
            this.setWakeLock(e.target.checked);
        });

        // Language Buttons
        document.getElementById('quick-lang-vi-btn')?.addEventListener('click', () => {
            this.setLanguage('vi');
        });
        document.getElementById('quick-lang-en-btn')?.addEventListener('click', () => {
            this.setLanguage('en');
        });
    },

    isOpen() {
        return this.modal && !this.modal.classList.contains('hidden');
    },

    open() {
        if (!this.modal) this.modal = document.getElementById('quick-settings-modal');
        if (!this.modal) return;
        this.syncAllValues();
        this.modal.classList.remove('hidden');
        this.modal.classList.add('flex');
    },

    close() {
        if (!this.modal) this.modal = document.getElementById('quick-settings-modal');
        if (!this.modal) return;
        this.modal.classList.add('hidden');
        this.modal.classList.remove('flex');
    },

    switchTab(tabName) {
        document.querySelectorAll('.quick-tab-btn').forEach(btn => {
            const isActive = btn.dataset.tab === tabName;
            btn.classList.toggle('active', isActive);
            btn.classList.toggle('text-slate-300', isActive);
            btn.classList.toggle('text-slate-400', !isActive);
        });

        document.querySelectorAll('.quick-tab-panel').forEach(panel => {
            panel.classList.add('hidden');
        });

        const activePanel = document.getElementById(`quick-panel-${tabName}`);
        if (activePanel) {
            activePanel.classList.remove('hidden');
        }
    },

    syncAllValues() {
        // 1. Theme
        const curTheme = localStorage.getItem('reader-theme') || 'default';
        document.querySelectorAll('.quick-theme-btn').forEach(btn => {
            const isAct = btn.dataset.theme === curTheme;
            btn.classList.toggle('border-primary/50', isAct);
            btn.classList.toggle('bg-primary/15', isAct);
        });
        const themeNameEl = document.getElementById('quick-theme-current-name');
        if (themeNameEl && THEMES_DATA[curTheme]) {
            themeNameEl.innerText = THEMES_DATA[curTheme].nameVi || curTheme;
        }

        // 2. Font Family
        const curFont = localStorage.getItem('reader-font-family') || 'Be Vietnam Pro';
        const qFontSelect = document.getElementById('quick-font-family-select');
        if (qFontSelect) qFontSelect.value = curFont;
        const qFontBadge = document.getElementById('quick-font-family-badge');
        if (qFontBadge) qFontBadge.innerText = curFont;
        const qPreview = document.getElementById('quick-font-sample-preview');
        if (qPreview) qPreview.style.fontFamily = `'${curFont}', sans-serif`;

        // 3. Font Size
        const curSize = parseInt(localStorage.getItem('reader-font-size') || '20');
        const qSizeRange = document.getElementById('quick-font-size-range');
        const qSizeVal = document.getElementById('quick-font-size-val');
        if (qSizeRange) qSizeRange.value = curSize;
        if (qSizeVal) qSizeVal.innerText = `${curSize}px`;

        // 4. Voice & Audio Settings from localStorage
        let localSettings = {};
        try {
            localSettings = JSON.parse(localStorage.getItem('reader-settings-v1') || '{}');
        } catch (_) {}

        const curVoice = localSettings.voice || 'vi-VN-HoaiMyNeural';
        const qVoiceSelect = document.getElementById('quick-voice-select');
        const qVoiceBadge = document.getElementById('quick-voice-badge');
        if (qVoiceSelect) qVoiceSelect.value = curVoice;
        if (qVoiceBadge) qVoiceBadge.innerText = curVoice.includes('NamMinh') ? 'Nam Minh' : (curVoice.includes('HoaiMy') ? 'Hoài My' : curVoice.split('-')[2] || 'AI Voice');

        const curSpeed = localSettings.speed !== undefined ? localSettings.speed : 1.0;
        const qSpeedRange = document.getElementById('quick-speed-range');
        const qSpeedVal = document.getElementById('quick-speed-val');
        if (qSpeedRange) qSpeedRange.value = curSpeed;
        if (qSpeedVal) qSpeedVal.innerText = `${curSpeed.toFixed(1)}x`;

        const curPitch = localSettings.pitch ? parseInt(localSettings.pitch) : 0;
        const qPitchRange = document.getElementById('quick-pitch-range');
        const qPitchVal = document.getElementById('quick-pitch-val');
        if (qPitchRange) qPitchRange.value = isNaN(curPitch) ? 0 : curPitch;
        if (qPitchVal) qPitchVal.innerText = `${curPitch >= 0 ? '+' : ''}${curPitch}Hz`;

        const curWorkers = localSettings.numWorkers || 2;
        const qWorkersRange = document.getElementById('quick-workers-range');
        const qWorkersVal = document.getElementById('quick-workers-val');
        if (qWorkersRange) qWorkersRange.value = curWorkers;
        if (qWorkersVal) qWorkersVal.innerText = `${curWorkers} Luồng`;

        // 5. Text Color
        const curColor = localSettings.textColor || 'default';
        const qColorPicker = document.getElementById('quick-font-color-picker');
        if (qColorPicker && curColor !== 'default' && curColor.startsWith('#')) {
            qColorPicker.value = curColor;
        }

        // 6. Lite Mode
        const isLite = localStorage.getItem('lite-mode-enabled') === 'true';
        const qLiteToggle = document.getElementById('quick-lite-mode-toggle');
        if (qLiteToggle) qLiteToggle.checked = isLite;

        // 7. Zen Mode
        const isZen = localStorage.getItem('zen-mode-enabled') === 'true';
        const qZenToggle = document.getElementById('quick-zen-mode-toggle');
        if (qZenToggle) qZenToggle.checked = isZen;

        // 8. WakeLock
        const isWake = localStorage.getItem('wakeLockEnabled') === 'true';
        const qWakeToggle = document.getElementById('quick-wakeLockEnabled') || document.getElementById('quick-wakelock-toggle');
        if (qWakeToggle) qWakeToggle.checked = isWake;

        // 9. Language
        const curLang = localStorage.getItem('ui-lang') || 'vi';
        this.updateLangButtons(curLang);
    },

    setFontFamily(font) {
        if (!font) font = 'Be Vietnam Pro';
        try { localStorage.setItem('reader-font-family', font); } catch (_) {}
        document.documentElement.style.setProperty('--reader-font-family', `'${font}', sans-serif`);
        
        const qFontBadge = document.getElementById('quick-font-family-badge');
        if (qFontBadge) qFontBadge.innerText = font;
        const qPreview = document.getElementById('quick-font-sample-preview');
        if (qPreview) qPreview.style.fontFamily = `'${font}', sans-serif`;
        const sFontSelect = document.getElementById('font-family-select');
        if (sFontSelect) sFontSelect.value = font;
        const sFontVal = document.getElementById('font-family-val');
        if (sFontVal) sFontVal.innerText = font;
    },

    setFontSize(size) {
        try { localStorage.setItem('reader-font-size', size); } catch (_) {}
        document.documentElement.style.setProperty('--reader-font-size', `${size}px`);
        
        const qSizeVal = document.getElementById('quick-font-size-val');
        if (qSizeVal) qSizeVal.innerText = `${size}px`;
        const sSizeRange = document.getElementById('font-size-range');
        if (sSizeRange) sSizeRange.value = size;
        const sSizeVal = document.getElementById('font-size-val');
        if (sSizeVal) sSizeVal.innerText = `${size}px`;
        
        if (window.STATE && window.STATE.settings) {
            window.STATE.settings.fontSize = size;
        }
    },

    setTextColor(color) {
        let saved = {};
        try { saved = JSON.parse(localStorage.getItem('reader-settings-v1') || '{}'); } catch (_) {}
        saved.textColor = color;
        try { localStorage.setItem('reader-settings-v1', JSON.stringify(saved)); } catch (_) {}

        if (color === 'default') {
            document.documentElement.style.setProperty('--reader-text-color', 'var(--theme-text-reading)');
        } else {
            document.documentElement.style.setProperty('--reader-text-color', color);
            const qColorPicker = document.getElementById('quick-font-color-picker');
            if (qColorPicker) qColorPicker.value = color;
        }

        const sColorPicker = document.getElementById('font-color-picker');
        if (sColorPicker && color !== 'default') sColorPicker.value = color;
        
        if (window.STATE && window.STATE.settings) {
            window.STATE.settings.textColor = color;
        }
    },

    setTheme(themeId) {
        applyTheme(themeId);
        document.querySelectorAll('.quick-theme-btn').forEach(btn => {
            const isAct = btn.dataset.theme === themeId;
            btn.classList.toggle('border-primary/50', isAct);
            btn.classList.toggle('bg-primary/15', isAct);
        });
        const themeNameEl = document.getElementById('quick-theme-current-name');
        if (themeNameEl && THEMES_DATA[themeId]) {
            themeNameEl.innerText = THEMES_DATA[themeId].nameVi || themeId;
        }
    },

    setVoice(voice) {
        let saved = {};
        try { saved = JSON.parse(localStorage.getItem('reader-settings-v1') || '{}'); } catch (_) {}
        saved.voice = voice;
        try { localStorage.setItem('reader-settings-v1', JSON.stringify(saved)); } catch (_) {}

        const qVoiceBadge = document.getElementById('quick-voice-badge');
        if (qVoiceBadge) qVoiceBadge.innerText = voice.includes('NamMinh') ? 'Nam Minh' : (voice.includes('HoaiMy') ? 'Hoài My' : voice.split('-')[2] || 'AI Voice');

        const sVoiceSelect = document.getElementById('voice-select');
        if (sVoiceSelect) sVoiceSelect.value = voice;

        if (window.STATE && window.STATE.settings) {
            window.STATE.settings.voice = voice;
        }
    },

    setSpeed(speed) {
        let saved = {};
        try { saved = JSON.parse(localStorage.getItem('reader-settings-v1') || '{}'); } catch (_) {}
        saved.speed = speed;
        try { localStorage.setItem('reader-settings-v1', JSON.stringify(saved)); } catch (_) {}

        const qSpeedVal = document.getElementById('quick-speed-val');
        if (qSpeedVal) qSpeedVal.innerText = `${speed.toFixed(1)}x`;

        const sSpeedRange = document.getElementById('speed-range');
        if (sSpeedRange) sSpeedRange.value = speed;
        const sSpeedVal = document.getElementById('speed-val');
        if (sSpeedVal) sSpeedVal.innerText = `${speed.toFixed(1)}x`;

        const chip = document.getElementById('speak-speed-chip');
        if (chip) chip.innerText = `${speed.toFixed(1)}X`;

        if (window.STATE && window.STATE.settings) {
            window.STATE.settings.speed = speed;
        }
    },

    setPitch(pitch) {
        const pitchStr = `${pitch >= 0 ? '+' : ''}${pitch}Hz`;
        let saved = {};
        try { saved = JSON.parse(localStorage.getItem('reader-settings-v1') || '{}'); } catch (_) {}
        saved.pitch = pitchStr;
        try { localStorage.setItem('reader-settings-v1', JSON.stringify(saved)); } catch (_) {}

        const qPitchVal = document.getElementById('quick-pitch-val');
        if (qPitchVal) qPitchVal.innerText = pitchStr;

        const sPitchRange = document.getElementById('pitch-range');
        if (sPitchRange) sPitchRange.value = pitch;
        const sPitchVal = document.getElementById('pitch-val');
        if (sPitchVal) sPitchVal.innerText = pitchStr;

        if (window.STATE && window.STATE.settings) {
            window.STATE.settings.pitch = pitchStr;
        }
    },

    setWorkers(workers) {
        let saved = {};
        try { saved = JSON.parse(localStorage.getItem('reader-settings-v1') || '{}'); } catch (_) {}
        saved.numWorkers = workers;
        try { localStorage.setItem('reader-settings-v1', JSON.stringify(saved)); } catch (_) {}

        const qWorkersVal = document.getElementById('quick-workers-val');
        if (qWorkersVal) qWorkersVal.innerText = `${workers} Luồng`;

        const sPrefetchRange = document.getElementById('prefetch-range');
        if (sPrefetchRange) sPrefetchRange.value = workers === 4 ? 2 : (workers === 2 ? 1 : 0);
        const sPrefetchVal = document.getElementById('prefetch-val');
        if (sPrefetchVal) sPrefetchVal.innerText = `${workers} Workers`;

        if (window.STATE && window.STATE.settings) {
            window.STATE.settings.numWorkers = workers;
        }
    },

    setLiteMode(enabled) {
        try { localStorage.setItem('lite-mode-enabled', String(enabled)); } catch (_) {}
        document.body.classList.toggle('lite-mode', enabled);
        const sLiteToggle = document.getElementById('lite-mode-toggle');
        if (sLiteToggle) sLiteToggle.checked = enabled;
        if (window.STATE) window.STATE.isLiteMode = enabled;
    },

    setZenMode(enabled) {
        try { localStorage.setItem('zen-mode-enabled', String(enabled)); } catch (_) {}
        if (window.STATE) window.STATE.zenModeEnabled = enabled;
        if (typeof window.toggleZenMode === 'function') {
            window.toggleZenMode(enabled);
        } else {
            document.body.classList.toggle('zen-mode', enabled);
        }
    },

    setWakeLock(enabled) {
        try { localStorage.setItem('wakeLockEnabled', String(enabled)); } catch (_) {}
        if (window.STATE) window.STATE.wakeLockEnabled = enabled;
        if (typeof window.requestWakeLock === 'function' && enabled) {
            window.requestWakeLock();
        } else if (typeof window.releaseWakeLock === 'function' && !enabled) {
            window.releaseWakeLock();
        }
    },

    setLanguage(lang) {
        try { localStorage.setItem('ui-lang', lang); } catch (_) {}
        this.updateLangButtons(lang);
        if (typeof window.applyLanguage === 'function') {
            window.applyLanguage(lang);
        }
    },

    updateLangButtons(lang) {
        const viBtn = document.getElementById('quick-lang-vi-btn');
        const enBtn = document.getElementById('quick-lang-en-btn');
        if (viBtn && enBtn) {
            if (lang === 'vi') {
                viBtn.className = 'px-2.5 py-1 text-[11px] font-bold rounded-lg transition-all bg-primary text-black';
                enBtn.className = 'px-2.5 py-1 text-[11px] font-bold rounded-lg transition-all text-slate-400 hover:text-white';
            } else {
                enBtn.className = 'px-2.5 py-1 text-[11px] font-bold rounded-lg transition-all bg-primary text-black';
                viBtn.className = 'px-2.5 py-1 text-[11px] font-bold rounded-lg transition-all text-slate-400 hover:text-white';
            }
        }
    }
};

if (typeof window !== 'undefined') {
    window.QuickSettingsController = QuickSettingsController;
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

    QuickSettingsController.init();
    window.QuickSettingsController = QuickSettingsController;

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
