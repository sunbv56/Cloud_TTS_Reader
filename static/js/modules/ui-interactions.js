/**
 * UI Interactions & Theme Controller
 */

export const DEFAULT_THEME = 'slate';
export const DEFAULT_READER_FONT = 'Source Serif 4';

export const THEMES_DATA = {
    'slate': {
        nameEn: 'Slate',
        nameVi: 'Slate',
        moodEn: 'Default dark · cool graphite',
        moodVi: 'Tối mặc định · xám than lạnh',
        metaColor: '#2A3139',
        isLight: false
    },
    'slate-deep': {
        nameEn: 'Deep Slate',
        nameVi: 'Slate sâu',
        moodEn: 'Darker · for a dark room',
        moodVi: 'Tối hơn · cho phòng tối',
        metaColor: '#151B21',
        isLight: false
    },
    'mist': {
        nameEn: 'Mist',
        nameVi: 'Sương',
        moodEn: 'Light · cool grey paper',
        moodVi: 'Sáng · giấy xám lạnh',
        metaColor: '#EBEFF2',
        isLight: true
    },
    'sepia': {
        nameEn: 'Sepia',
        nameVi: 'Sepia',
        moodEn: 'Light · warm paper',
        moodVi: 'Sáng · giấy ấm',
        metaColor: '#F2E6D3',
        isLight: true
    }
};

// Theme ids saved by the old 9-theme picker, mapped to the nearest console theme.
export const LEGACY_THEME_MAP = {
    'default': 'slate',
    'forest': 'slate',
    'rose': 'slate',
    'mocha': 'slate',
    'warm-night': 'slate-deep',
    'ocean': 'slate-deep',
    'e-ink': 'slate-deep',
    'paper': 'mist'
};

export function normalizeThemeId(themeId) {
    if (themeId && THEMES_DATA[themeId]) return themeId;
    return LEGACY_THEME_MAP[themeId] || DEFAULT_THEME;
}

function currentUiLang() {
    try {
        return localStorage.getItem('ui-lang') || 'en';
    } catch (_) {
        return 'en';
    }
}

export function syncThemeControls(themeId) {
    const actualId = normalizeThemeId(themeId);
    const theme = THEMES_DATA[actualId];
    const lang = currentUiLang();
    document.querySelectorAll('.theme-card, .theme-swatch').forEach(el => {
        const isActive = el.dataset.theme === actualId;
        el.classList.toggle('active', isActive);
        el.setAttribute('aria-pressed', String(isActive));
    });
    document.querySelectorAll('.quick-theme-btn').forEach(btn => {
        btn.setAttribute('aria-pressed', String(btn.dataset.theme === actualId));
    });
    const nameEl = document.getElementById('current-theme-name');
    if (nameEl) nameEl.textContent = lang === 'vi' ? theme.nameVi : theme.nameEn;
    const moodEl = document.getElementById('current-theme-mood');
    if (moodEl) moodEl.textContent = lang === 'vi' ? theme.moodVi : theme.moodEn;
    const quickNameEl = document.getElementById('quick-theme-current-name');
    if (quickNameEl) quickNameEl.textContent = lang === 'vi' ? theme.nameVi : theme.nameEn;
}

export function applyTheme(themeId) {
    const root = document.documentElement;
    const actualId = normalizeThemeId(themeId);
    const theme = THEMES_DATA[actualId];

    root.setAttribute('data-theme', actualId);

    const metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor) {
        metaThemeColor.content = theme.metaColor;
    }

    syncThemeControls(actualId);

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

// Reading fonts other than the preloaded ones are fetched only when chosen.
const PRELOADED_FONTS = new Set(['Be Vietnam Pro', 'Source Serif 4']);
const READER_FONT_QUERIES = {
    'Playfair Display': 'Playfair+Display:wght@400;600',
    'Plus Jakarta Sans': 'Plus+Jakarta+Sans:wght@400;600',
    'Literata': 'Literata:opsz,wght@7..72,400;7..72,600',
    'Lora': 'Lora:wght@400;600',
    'Merriweather': 'Merriweather:wght@400;700',
    'Montserrat': 'Montserrat:wght@400;600',
    'Inter': 'Inter:wght@400;600'
};
const loadedReaderFonts = new Set();

export function ensureReaderFont(fontFamily) {
    if (!fontFamily || PRELOADED_FONTS.has(fontFamily) || loadedReaderFonts.has(fontFamily)) return;
    const query = READER_FONT_QUERIES[fontFamily];
    if (!query) return;
    loadedReaderFonts.add(fontFamily);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${query}&display=swap`;
    document.head.appendChild(link);
}

export function readerFontStack(fontFamily) {
    const serif = /Serif|Literata|Lora|Merriweather|Playfair/.test(fontFamily || '');
    return `'${fontFamily}', ${serif ? 'Georgia, serif' : 'system-ui, sans-serif'}`;
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

// Header "settings & tools" popover: same keyboard model as the account menu.
export function initAppMenu() {
    const trigger = document.getElementById('app-menu-btn');
    const menu = document.getElementById('app-menu');
    if (!trigger || !menu) return;
    let isOpen = false;

    const items = () => [...menu.querySelectorAll('[role="menuitem"]:not(:disabled)')];

    function onOutside(event) {
        if (!menu.contains(event.target) && !trigger.contains(event.target)) setOpen(false);
    }

    function setOpen(next, { restoreFocus = false } = {}) {
        if (isOpen === next) return;
        isOpen = next;
        menu.hidden = !next;
        trigger.setAttribute('aria-expanded', String(next));
        if (next) {
            document.addEventListener('pointerdown', onOutside, true);
            items()[0]?.focus();
        } else {
            document.removeEventListener('pointerdown', onOutside, true);
            if (restoreFocus) trigger.focus();
        }
    }

    trigger.addEventListener('click', () => setOpen(!isOpen));
    // Capture phase: close before an item's own handler, some of which stop propagation.
    menu.addEventListener('click', (event) => {
        if (event.target.closest('[role="menuitem"]')) setOpen(false);
    }, true);
    menu.addEventListener('keydown', (event) => {
        const list = items();
        const index = list.indexOf(document.activeElement);
        if (event.key === 'Escape') {
            event.preventDefault();
            setOpen(false, { restoreFocus: true });
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const step = event.key === 'ArrowDown' ? 1 : -1;
            list[(index + step + list.length) % list.length]?.focus();
        } else if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            list[event.key === 'Home' ? 0 : list.length - 1]?.focus();
        } else if (event.key === 'Tab') {
            setOpen(false);
        }
    });

    window.closeAppMenu = () => setOpen(false);
}

// Header search: Discovery search when Home is showing, otherwise the library search.
export function initHeaderSearch() {
    const button = document.getElementById('header-search-btn');
    button?.addEventListener('click', () => {
        const discovery = document.getElementById('discovery-mode');
        if (discovery && !discovery.classList.contains('hidden')) {
            const input = document.getElementById('discovery-search');
            input?.scrollIntoView({ block: 'center' });
            input?.focus();
            return;
        }
        switchSidebarTab('library');
        if (window.innerWidth < 1024) toggleSidebar(true);
        setTimeout(() => document.getElementById('library-search')?.focus(), 60);
    });
}

export function toggleVoiceSettings(expand = true) {
    const voiceBody = document.getElementById('voice-settings-body');
    if (!voiceBody) return;
    voiceBody.style.maxHeight = '';
    voiceBody.style.opacity = '1';
    voiceBody.style.marginTop = '';
}

export function switchSidebarTab(tabName) {
    const tabs = document.querySelectorAll('.sidebar-tab');
    const panels = {
        'library': document.getElementById('panel-library'),
        'toc': document.getElementById('panel-toc'),
        'voice': document.getElementById('panel-voice')
    };

    tabs.forEach(tab => {
        const isTarget = tab.dataset.tab === tabName;
        tab.classList.toggle('active', isTarget);
        tab.setAttribute('aria-selected', isTarget ? 'true' : 'false');
    });

    Object.entries(panels).forEach(([name, panel]) => {
        if (!panel) return;
        if (name === tabName) {
            panel.removeAttribute('hidden');
        } else {
            panel.setAttribute('hidden', '');
        }
    });

    if (tabName === 'toc') {
        if (typeof window.renderTOC === 'function') {
            window.renderTOC();
        }
        if (typeof window.scrollTOCCurrentChapter === 'function') {
            setTimeout(window.scrollTOCCurrentChapter, 100);
        }
    }
}

// Below 1024px the chapter list opens as a bottom sheet: #panel-toc moves into
// #toc-sheet while it is open and goes back to the sidebar when it closes.
let tocSheetReturnFocus = null;

function onTOCSheetKey(event) {
    const sheet = document.getElementById('toc-sheet');
    if (!sheet || sheet.hidden) return;
    if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeTOCSheet();
        return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...sheet.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])')]
        .filter(el => el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

function onTOCSheetResize() {
    if (window.innerWidth >= 1024) closeTOCSheet({ restoreFocus: false });
}

export function openTOCSheet() {
    const sheet = document.getElementById('toc-sheet');
    const scrim = document.getElementById('toc-sheet-scrim');
    const panel = document.getElementById('panel-toc');
    if (!sheet || !panel || !sheet.hidden) return;
    tocSheetReturnFocus = document.activeElement;
    toggleSidebar(false);
    sheet.appendChild(panel);
    panel.hidden = false;
    sheet.hidden = false;
    if (scrim) scrim.hidden = false;
    window.renderTOC?.();
    requestAnimationFrame(() => window.scrollTOCCurrentChapter?.());
    document.getElementById('toc-close-btn')?.focus({ preventScroll: true });
    document.addEventListener('keydown', onTOCSheetKey, true);
    window.addEventListener('resize', onTOCSheetResize);
}

export function closeTOCSheet({ restoreFocus = true } = {}) {
    const sheet = document.getElementById('toc-sheet');
    const scrim = document.getElementById('toc-sheet-scrim');
    const panel = document.getElementById('panel-toc');
    const sidebar = document.getElementById('sidebar-container');
    if (!sheet || sheet.hidden) return false;
    sheet.hidden = true;
    if (scrim) scrim.hidden = true;
    if (panel && sidebar) {
        sidebar.insertBefore(panel, document.getElementById('panel-voice'));
        panel.hidden = document.getElementById('tab-toc')?.getAttribute('aria-selected') !== 'true';
    }
    document.removeEventListener('keydown', onTOCSheetKey, true);
    window.removeEventListener('resize', onTOCSheetResize);
    if (restoreFocus && tocSheetReturnFocus?.isConnected) tocSheetReturnFocus.focus({ preventScroll: true });
    tocSheetReturnFocus = null;
    return true;
}

export function openQuickTOC() {
    const discoveryMode = document.getElementById('discovery-mode');
    if (discoveryMode && !discoveryMode.classList.contains('hidden')) {
        if (typeof window.MPW_BRIDGE?.toggleDiscoveryMode === 'function') {
            window.MPW_BRIDGE.toggleDiscoveryMode(false);
        }
    }

    if (window.innerWidth < 1024) {
        openTOCSheet();
        return;
    }
    document.getElementById('sidebar-container')?.classList.remove('hidden');
    switchSidebarTab('toc');
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
    window.normalizeThemeId = normalizeThemeId;
    window.ensureReaderFont = ensureReaderFont;
    window.readerFontStack = readerFontStack;
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
        let curTheme = DEFAULT_THEME;
        try { curTheme = normalizeThemeId(localStorage.getItem('reader-theme')); } catch (_) {}
        syncThemeControls(curTheme);

        // 2. Font Family
        const curFont = localStorage.getItem('reader-font-family') || DEFAULT_READER_FONT;
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
        if (!font) font = DEFAULT_READER_FONT;
        try { localStorage.setItem('reader-font-family', font); } catch (_) {}
        ensureReaderFont(font);
        document.documentElement.style.setProperty('--reader-font-family', readerFontStack(font));
        
        const qFontBadge = document.getElementById('quick-font-family-badge');
        if (qFontBadge) qFontBadge.innerText = font;
        const qPreview = document.getElementById('quick-font-sample-preview');
        if (qPreview) qPreview.style.fontFamily = readerFontStack(font);
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
        if (typeof window.applyLiteMode === 'function') {
            window.applyLiteMode(enabled);
        } else {
            try { localStorage.setItem('lite-mode-enabled', String(enabled)); } catch (_) {}
            document.body.classList.toggle('lite-mode', enabled);
            const sLiteToggle = document.getElementById('lite-mode-toggle');
            if (sLiteToggle) sLiteToggle.checked = enabled;
            const mToggle = document.getElementById('lite-mode-toggle-mobile');
            if (mToggle) mToggle.checked = enabled;
            const qToggle = document.getElementById('quick-lite-mode-toggle');
            if (qToggle) qToggle.checked = enabled;
            if (window.STATE) window.STATE.isLiteMode = enabled;
        }
        if (enabled && typeof this.close === 'function') {
            this.close();
        }
    },

    setZenMode(enabled) {
        if (typeof window.setZenMode === 'function') {
            window.setZenMode(enabled, true);
        } else {
            try { localStorage.setItem('zen-mode-enabled', String(enabled)); } catch (_) {}
            if (window.STATE) window.STATE.zenModeEnabled = enabled;
            document.body.classList.toggle('zen-focus-mode', enabled);
        }
    },

    setWakeLock(enabled) {
        try { localStorage.setItem('wakeLockEnabled', String(enabled)); } catch (_) {}
        if (window.STATE) window.STATE.wakeLockEnabled = enabled;
        if (typeof window.requestWakeLock === 'function' && enabled) {
            window.requestWakeLock();
        } else if (typeof window.releaseWakeLock === 'function' && !enabled) {
            window.releaseWakeLock();
        } else if (typeof window.updateWakeLockUI === 'function') {
            window.updateWakeLockUI(enabled);
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

    const setThemePickerOpen = (open) => {
        if (!themePickerPanel) return;
        themePickerPanel.hidden = !open;
        themeToggleBtn?.setAttribute('aria-expanded', String(open));
        if (themeChevron) themeChevron.style.transform = open ? 'rotate(180deg)' : 'rotate(0deg)';
    };
    setThemePickerOpen(false);
    themeToggleBtn?.addEventListener('click', () => {
        setThemePickerOpen(!!themePickerPanel?.hidden);
    });

    document.querySelectorAll('.theme-card, .theme-swatch').forEach(card => {
        card.addEventListener('click', (e) => {
            e.stopPropagation();
            applyTheme(card.dataset.theme);
        });
    });

    let savedTheme = null;
    try {
        savedTheme = localStorage.getItem('reader-theme');
    } catch (_) {}
    applyTheme(normalizeThemeId(savedTheme));

    initAppMenu();
    initHeaderSearch();

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

    // Segmented Sidebar Tabs
    document.querySelectorAll('.sidebar-tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
            e.stopPropagation();
            const tabName = tab.dataset.tab;
            if (tabName) switchSidebarTab(tabName);
        });
    });

    // Quick TOC Access Triggers
    const readerTocBtn = document.getElementById('reader-toc-toggle-btn');
    const playerTocBtn = document.getElementById('player-toc-btn');
    readerTocBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        openQuickTOC();
    });
    playerTocBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        openQuickTOC();
    });

    document.getElementById('toc-close-btn')?.addEventListener('click', () => closeTOCSheet());
    document.getElementById('toc-sheet-scrim')?.addEventListener('click', () => closeTOCSheet());

    // Reader Utilities Dropdown (Consolidated 3-dot Menu)
    initReaderMoreMenu();
}

export function initReaderMoreMenu() {
    const moreBtn = document.getElementById('reader-more-menu-btn');
    const menu = document.getElementById('reader-more-menu-dropdown');
    if (!moreBtn || !menu) return;
    let isOpen = false;

    const items = () => [...menu.querySelectorAll('[role^="menuitem"]:not(:disabled)')];

    function onOutside(event) {
        if (!menu.contains(event.target) && !moreBtn.contains(event.target)) setOpen(false);
    }

    function setOpen(next, { restoreFocus = false } = {}) {
        if (isOpen === next) return;
        isOpen = next;
        if (next) document.dispatchEvent(new CustomEvent('reader-menu-open'));
        menu.hidden = !next;
        moreBtn.setAttribute('aria-expanded', String(next));
        if (next) {
            document.addEventListener('pointerdown', onOutside, true);
            items()[0]?.focus();
        } else {
            document.removeEventListener('pointerdown', onOutside, true);
            if (restoreFocus) moreBtn.focus();
        }
    }

    moreBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        setOpen(!isOpen);
    });
    // Toggles and timer presets keep the menu open so the new state is visible.
    menu.addEventListener('click', (event) => {
        const item = event.target.closest('[role^="menuitem"]');
        if (item && !item.hasAttribute('data-keep-open')) setOpen(false);
    }, true);
    menu.addEventListener('keydown', (event) => {
        const list = items();
        const index = list.indexOf(document.activeElement);
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false, { restoreFocus: true });
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const step = event.key === 'ArrowDown' ? 1 : -1;
            list[(index + step + list.length) % list.length]?.focus();
        } else if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            list[event.key === 'Home' ? 0 : list.length - 1]?.focus();
        } else if (event.key === 'Tab') {
            setOpen(false);
        }
    });
    // Escape with focus outside the menu (e.g. after a pointer open).
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && isOpen) setOpen(false, { restoreFocus: true });
    });

    window.closeReaderMenu = () => setOpen(false);
}

// Global window exposure for inter-module communication
window.switchSidebarTab = switchSidebarTab;
window.openQuickTOC = openQuickTOC;
window.openTOCSheet = openTOCSheet;
window.closeTOCSheet = closeTOCSheet;
window.initReaderMoreMenu = initReaderMoreMenu;

