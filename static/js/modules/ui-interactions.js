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
    },
    'sepia-dark': {
        nameEn: 'Sepia Dark',
        nameVi: 'Sepia tối',
        moodEn: 'Dark · warm wood, cream text',
        moodVi: 'Tối · gỗ nâu, chữ kem',
        metaColor: '#2C2219',
        isLight: false
    },
    'ember': {
        nameEn: 'Ember',
        nameVi: 'Than hồng',
        moodEn: 'Late night · nothing glows',
        moodVi: 'Đêm khuya · không gì loé sáng',
        metaColor: '#17100C',
        isLight: false
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
    document.querySelectorAll('.theme-card').forEach(card => {
        card.title = lang === 'vi' ? THEMES_DATA[card.dataset.theme]?.nameVi : THEMES_DATA[card.dataset.theme]?.nameEn;
    });
    return theme;
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
    document.getElementById('mobile-menu-btn')?.setAttribute('aria-expanded', String(!!show));
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

export function switchSidebarTab(tabName) {
    const tabs = document.querySelectorAll('.sidebar-tab');
    const panels = {
        'library': document.getElementById('panel-library'),
        'toc': document.getElementById('panel-toc')
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

// Keeps Tab inside an open sheet or dialog.
export function trapTab(container, event) {
    if (event.key !== 'Tab' || !container) return;
    const focusable = [...container.querySelectorAll('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
        .filter(el => el.offsetParent !== null || el === document.activeElement);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (active === container || !container.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
    }
}

// Below 1024px the chapter list opens as a bottom sheet: #panel-toc moves into
// #toc-sheet while it is open and goes back to the sidebar when it closes.
let tocSheetReturnFocus = null;

function onTOCSheetKey(event) {
    const sheet = document.getElementById('toc-sheet');
    if (!sheet || sheet.hidden) return;
    // A dialog opened from the sheet (e.g. edit chapter) owns the keyboard.
    const active = document.activeElement;
    if (active && !sheet.contains(active) && active.closest?.('[aria-modal="true"]')) return;
    if (document.querySelector('.modal[aria-modal="true"]:not(.hidden)')) return;
    if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        dismissTOCSheet();
        return;
    }
    trapTab(sheet, event);
}

// User-initiated close: closeTOC also leaves select mode before closing the sheet.
function dismissTOCSheet() {
    if (typeof window.closeTOC === 'function') window.closeTOC();
    else closeTOCSheet();
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
        sidebar.appendChild(panel);
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
    window.showDictStatus = showDictStatus;
}

// Settings sheet: one scrolling page (Nghe · Giao diện · Nâng cao · Bộ nhớ & cache · Thống kê).
// Full-screen sheet on phones, side sheet from 640px. The controls inside are the
// canonical ones app.js listens to; this controller only opens, closes and syncs toggles.
export const SettingsSheet = {
    sheet: null,
    scrim: null,
    returnFocus: null,

    init() {
        this.sheet = document.getElementById('settings-sheet');
        this.scrim = document.getElementById('settings-scrim');
        if (!this.sheet) return;
        this.onKey = this.onKey.bind(this);

        document.getElementById('settings-close')?.addEventListener('click', () => this.close());
        this.scrim?.addEventListener('click', () => this.close());

        this.sheet.querySelectorAll('.settings__jump a').forEach(link => {
            link.addEventListener('click', (event) => {
                event.preventDefault();
                this.scrollTo(link.getAttribute('href').slice(1));
            });
        });
        let spyFrame = 0;
        document.getElementById('settings-body')?.addEventListener('scroll', () => {
            if (spyFrame) return;
            spyFrame = requestAnimationFrame(() => {
                spyFrame = 0;
                this.markSection();
            });
        }, { passive: true });

        // Jump bar marks the section in view. A jump pins its target until the user
        // scrolls by hand, since short last sections can never reach the top.
        const body = document.getElementById('settings-body');
        let frame = 0;
        body?.addEventListener('scroll', () => {
            if (frame) return;
            frame = requestAnimationFrame(() => {
                frame = 0;
                if (!this.pinnedJump) this.markJump(this.sectionInView());
            });
        }, { passive: true });
        const release = () => { this.pinnedJump = null; };
        ['wheel', 'touchstart', 'keydown'].forEach(type => body?.addEventListener(type, release, { passive: true }));

        document.querySelectorAll('#settings-lang [data-lang]').forEach(btn => {
            btn.addEventListener('click', () => this.setLanguage(btn.dataset.lang));
        });
        document.getElementById('settings-zen-toggle')?.addEventListener('change', (event) => {
            window.setZenMode?.(event.target.checked, true);
        });
        document.getElementById('settings-wake-toggle')?.addEventListener('change', (event) => {
            this.setWakeLock(event.target.checked);
        });
        document.getElementById('settings-feedback-toggle')?.addEventListener('change', (event) => {
            const on = event.target.checked;
            try { localStorage.setItem('ui-feedback', on ? 'on' : 'off'); } catch (_) {}
            if (window.AudioHapticFX) window.AudioHapticFX.isMuted = !on;
        });
    },

    isOpen() {
        return !!this.sheet && !this.sheet.hidden;
    },

    open(section = 'listen') {
        if (!this.sheet) return;
        window.closeAppMenu?.();
        if (!this.isOpen()) {
            const active = document.activeElement;
            // Menu items are hidden once the sheet opens; hand focus back to the menu button.
            this.returnFocus = (!active || active === document.body || active.closest('#app-menu'))
                ? document.getElementById('app-menu-btn')
                : active;
            this.sync();
            this.sheet.hidden = false;
            if (this.scrim) this.scrim.hidden = false;
            document.documentElement.toggleAttribute('data-settings-open', true);
            document.addEventListener('keydown', this.onKey, true);
            window.refreshInsights?.();
        }
        // Opened from "Thống kê đọc", the sheet is titled for what it shows.
        const title = document.getElementById('settings-title');
        if (title) {
            title.dataset.i18n = section === 'stats' ? 'settings-stats' : 'settings-title';
            const lang = currentUiLang();
            title.textContent = window.translations?.[lang]?.[title.dataset.i18n] || (section === 'stats' ? 'Thống kê' : 'Cài đặt');
        }
        requestAnimationFrame(() => {
            this.scrollTo(`settings-${section}`, { instant: true });
            this.markSection(`settings-${section}`);
            document.getElementById('settings-close')?.focus({ preventScroll: true });
        });
    },

    // Scroll-spy: underline the jump link of the section in view.
    markSection(forcedId = null) {
        const body = document.getElementById('settings-body');
        const links = [...(this.sheet?.querySelectorAll('.settings__jump a') || [])];
        if (!body || !links.length) return;
        let currentId = forcedId;
        if (!currentId) {
            const atEnd = body.scrollTop + body.clientHeight >= body.scrollHeight - 2;
            const top = body.getBoundingClientRect().top + 24;
            links.forEach(link => {
                const section = document.getElementById(link.getAttribute('href').slice(1));
                if (section && section.getBoundingClientRect().top <= top) currentId = section.id;
            });
            if (atEnd && body.scrollTop > 0) currentId = links[links.length - 1].getAttribute('href').slice(1);
            currentId ||= links[0].getAttribute('href').slice(1);
        }
        links.forEach(link => {
            if (link.getAttribute('href') === `#${currentId}`) link.setAttribute('aria-current', 'true');
            else link.removeAttribute('aria-current');
        });
    },

    close() {
        if (!this.isOpen()) return;
        this.sheet.hidden = true;
        if (this.scrim) this.scrim.hidden = true;
        document.documentElement.removeAttribute('data-settings-open');
        document.removeEventListener('keydown', this.onKey, true);
        if (this.returnFocus?.isConnected) this.returnFocus.focus({ preventScroll: true });
        this.returnFocus = null;
    },

    onKey(event) {
        // A dialog opened from Settings (e.g. confirm) owns the keyboard.
        if (document.querySelector('.modal[aria-modal="true"]:not(.hidden)')) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            this.close();
            return;
        }
        trapTab(this.sheet, event);
    },

    sectionInView() {
        const body = document.getElementById('settings-body');
        const groups = [...(body?.querySelectorAll('.set-group') || [])];
        if (!groups.length) return null;
        if (body.scrollTop + body.clientHeight >= body.scrollHeight - 2) return groups[groups.length - 1].id;
        let current = groups[0];
        for (const group of groups) {
            if (group.offsetTop - body.offsetTop <= body.scrollTop + 32) current = group;
        }
        return current.id;
    },

    markJump(id) {
        this.sheet?.querySelectorAll('.settings__jump a').forEach(link => {
            if (link.getAttribute('href') !== `#${id}`) {
                link.removeAttribute('aria-current');
                return;
            }
            link.setAttribute('aria-current', 'true');
            // At 320px the bar scrolls sideways; keep the marked link in view.
            const nav = link.parentElement;
            const box = link.getBoundingClientRect();
            const bar = nav.getBoundingClientRect();
            if (box.left < bar.left) nav.scrollLeft -= bar.left - box.left;
            else if (box.right > bar.right) nav.scrollLeft += box.right - bar.right;
        });
    },

    scrollTo(id, { instant = false } = {}) {
        const target = document.getElementById(id);
        const body = document.getElementById('settings-body');
        if (!target || !body) return;
        this.pinnedJump = id;
        this.markJump(id);
        // The first group sits under the local-settings note; start at the top so the note stays readable.
        const first = body.querySelector('.set-group') === target;
        const top = first ? 0 : target.offsetTop - body.offsetTop - 4;
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        body.scrollTo({ top: Math.max(0, top), behavior: instant || reduce ? 'auto' : 'smooth' });
    },

    sync() {
        let curTheme = DEFAULT_THEME;
        try { curTheme = normalizeThemeId(localStorage.getItem('reader-theme')); } catch (_) {}
        syncThemeControls(curTheme);

        const zen = document.getElementById('settings-zen-toggle');
        if (zen) zen.checked = !!window.STATE?.zenModeEnabled;
        const wake = document.getElementById('settings-wake-toggle');
        if (wake) wake.checked = !!window.STATE?.wakeLockEnabled;
        const feedback = document.getElementById('settings-feedback-toggle');
        if (feedback) feedback.checked = !window.AudioHapticFX?.isMuted;
        this.syncLang(currentUiLang());
        window.ConsolePlayer?.syncMirrors(this.sheet);
    },

    setWakeLock(enabled) {
        try { localStorage.setItem('wakeLockEnabled', String(enabled)); } catch (_) {}
        if (window.STATE) window.STATE.wakeLockEnabled = enabled;
        if (enabled) window.requestWakeLock?.();
        else window.releaseWakeLock?.();
        window.updateWakeLockUI?.(enabled);
    },

    setLanguage(lang) {
        try { localStorage.setItem('ui-lang', lang); } catch (_) {}
        window.applyLanguage?.(lang);
        this.syncLang(lang);
    },

    syncLang(lang) {
        document.querySelectorAll('#settings-lang [data-lang]').forEach(btn => {
            btn.setAttribute('aria-pressed', String(btn.dataset.lang === lang));
        });
    }
};

if (typeof window !== 'undefined') {
    window.SettingsSheet = SettingsSheet;
}

export function initUIInteractions() {
    const mobileMenuBtn = document.getElementById('mobile-menu-btn');
    const overlay = document.getElementById('sidebar-overlay');
    const closeSidebar = document.getElementById('close-sidebar');

    const closeDrawer = () => {
        toggleSidebar(false);
        mobileMenuBtn?.focus({ preventScroll: true });
    };
    mobileMenuBtn?.addEventListener('click', () => {
        toggleSidebar(true);
        const sidebar = document.getElementById('sidebar-container');
        const target = sidebar?.querySelector('#sidebar-tabs [aria-selected="true"]') || closeSidebar;
        target?.focus({ preventScroll: true });
    });
    overlay?.addEventListener('click', closeDrawer);
    closeSidebar?.addEventListener('click', closeDrawer);

    window.addEventListener('resize', () => {
        if (window.innerWidth >= 1024) toggleSidebar(false);
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

    SettingsSheet.init();

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
        showDictStatus(window.translations?.[currentUiLang()]?.['dict-saved'] || 'Đã lưu từ điển.');
    });

    dictClearBtn?.addEventListener('click', () => {
        if (dictInput) dictInput.value = '';
        if (typeof window.saveSkipDictionary === 'function') {
            window.saveSkipDictionary('');
        } else {
            localStorage.setItem('tts-skip-dictionary', '');
        }
        showDictStatus(window.translations?.[currentUiLang()]?.['dict-cleared'] || 'Đã xoá từ điển.');
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
        window.ConsolePlayer?.closePanel({ restoreFocus: false });
        openQuickTOC();
    });

    document.getElementById('toc-close-btn')?.addEventListener('click', dismissTOCSheet);
    document.getElementById('toc-sheet-scrim')?.addEventListener('click', dismissTOCSheet);

    // Reader Utilities Dropdown (Consolidated 3-dot Menu)
    initReaderMoreMenu();
}

export function initReaderMoreMenu() {
    const moreBtn = document.getElementById('reader-more-menu-btn');
    const menu = document.getElementById('reader-more-menu-dropdown');
    if (!moreBtn || !menu) return;
    let isOpen = false;

    // Skip items inside hidden groups (e.g. the sleep-timer cancel row).
    const items = () => [...menu.querySelectorAll('[role^="menuitem"]:not(:disabled)')]
        .filter(item => item.getClientRects().length > 0);

    // On touch, the tap that dismisses the menu must not also land on the
    // text underneath (a sentence tap would start playback from there).
    function swallowNextClick() {
        const swallow = (event) => {
            event.preventDefault();
            event.stopPropagation();
            cleanup();
        };
        const cleanup = () => {
            clearTimeout(timer);
            document.removeEventListener('click', swallow, true);
        };
        const timer = setTimeout(cleanup, 600);
        document.addEventListener('click', swallow, true);
    }

    function onOutside(event) {
        if (menu.contains(event.target) || moreBtn.contains(event.target)) return;
        setOpen(false);
        if (event.pointerType && event.pointerType !== 'mouse') swallowNextClick();
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
        // Focus moves back to ⋮ before the item's handler runs, so dialogs it
        // opens record a visible element to return focus to.
        if (item && !item.hasAttribute('data-keep-open')) setOpen(false, { restoreFocus: true });
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

