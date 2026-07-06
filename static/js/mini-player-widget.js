// ============================================================
// Mini Player Widget — YouTube-style floating player
//
// Tier 1: draggable floating widget with corner snapping
// Tier 2: stays alive across Discovery mode (hooked from
//         toggleDiscoveryMode in app.js via window.MiniPlayerWidget)
// Tier 3: Document Picture-in-Picture (Chrome/Edge >= 116)
//
// The widget owns NO audio logic. It is a mirror view over the
// single source of truth in app.js (STATE + #main-audio), reached
// through window.MPW_BRIDGE which app.js exposes at startup.
// ============================================================

(function () {
    'use strict';

    const SYNC_INTERVAL_MS = 400;
    const DRAG_THRESHOLD_PX = 6;
    const CORNER_KEY = 'mpw-corner';
    const MARGIN = 16; // px safe margin from viewport edges

    let bridge = null;          // window.MPW_BRIDGE from app.js
    let root = null;            // #mini-player-widget
    let card = null;            // .mpw-card
    let syncTimer = null;
    let floatReason = null;     // 'manual' | 'discovery' | null
    let pipWindow = null;       // Document PiP window, if open
    let pipReturnReason = null; // floatReason to restore when PiP closes

    // ---------------------------------------------------------
    // DOM creation
    // ---------------------------------------------------------
    function buildWidget() {
        root = document.createElement('div');
        root.id = 'mini-player-widget';
        root.innerHTML = `
            <div class="mpw-card" data-drag-handle>
                <div class="mpw-art"><i class="fas fa-book-open"></i></div>
                <div class="mpw-meta">
                    <span class="mpw-title" id="mpw-title">—</span>
                    <span class="mpw-subtitle" id="mpw-subtitle">—</span>
                </div>
                <button class="mpw-btn" id="mpw-prev-btn" title="Previous"><i class="fas fa-step-backward"></i></button>
                <button class="mpw-btn mpw-play" id="mpw-play-btn" title="Play/Pause"><i class="fas fa-play"></i></button>
                <button class="mpw-btn" id="mpw-next-btn" title="Next"><i class="fas fa-step-forward"></i></button>
                <button class="mpw-btn" id="mpw-pip-btn" title="Picture-in-Picture" hidden><i class="fas fa-external-link-alt"></i></button>
                <button class="mpw-btn" id="mpw-close-btn" title="Stop & close"><i class="fas fa-times"></i></button>
                <div class="mpw-progress-track"><div class="mpw-progress" id="mpw-progress"></div></div>
            </div>`;
        document.body.appendChild(root);
        card = root.querySelector('.mpw-card');

        root.querySelector('#mpw-play-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            bridge.togglePlayback();
        });
        root.querySelector('#mpw-prev-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            const btn = document.getElementById('prev-btn');
            if (btn) btn.click();
        });
        root.querySelector('#mpw-next-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            const btn = document.getElementById('next-btn');
            if (btn) btn.click();
        });
        root.querySelector('#mpw-close-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            closeAndStop();
        });

        // Tier 3: Document PiP — only shown when the browser supports it
        const pipBtn = root.querySelector('#mpw-pip-btn');
        if ('documentPictureInPicture' in window) {
            pipBtn.hidden = false;
            pipBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                openPiP().catch(err => console.error('[MPW] PiP failed:', err));
            });
        }

        setupDrag();

        // Instant play/pause icon updates (polling only covers slow data)
        bridge.audio.addEventListener('play', updatePlayIcon);
        bridge.audio.addEventListener('pause', updatePlayIcon);
    }

    // Adds "pop-out" and "PiP" buttons onto the existing full-size player.
    // PiP is one click away — no need to go through the floating widget first.
    function injectPopoutButton() {
        const mediaPlayer = document.getElementById('media-player');
        if (!mediaPlayer || document.getElementById('mpw-popout-btn')) return;

        const btn = document.createElement('button');
        btn.id = 'mpw-popout-btn';
        btn.title = 'Pop out mini player';
        btn.innerHTML = '<i class="fas fa-compress-alt"></i>';
        btn.addEventListener('click', () => show('manual'));
        mediaPlayer.appendChild(btn);

        if ('documentPictureInPicture' in window) {
            const pipBtn = document.createElement('button');
            pipBtn.id = 'mpw-player-pip-btn';
            pipBtn.title = 'Picture-in-Picture (floating window)';
            pipBtn.innerHTML = '<i class="fas fa-window-restore"></i>';
            pipBtn.addEventListener('click', () => {
                openPiP().catch(err => console.error('[MPW] PiP failed:', err));
            });
            mediaPlayer.appendChild(pipBtn);
        }
    }

    // ---------------------------------------------------------
    // Show / hide / close
    // ---------------------------------------------------------
    function show(reason) {
        if (!bridge.STATE.currentBook) return;
        floatReason = reason || 'manual';
        root.classList.add('mpw-visible');
        applyCorner(loadCorner());
        syncNow();
        if (!syncTimer) syncTimer = setInterval(syncNow, SYNC_INTERVAL_MS);
    }

    function hide() {
        floatReason = null;
        root.classList.remove('mpw-visible');
        if (syncTimer) {
            clearInterval(syncTimer);
            syncTimer = null;
        }
    }

    function closeAndStop() {
        if (pipWindow) pipWindow.close();
        bridge.resetAudioEngine();
        hide();
    }

    // Tapping the widget body expands back to the full player
    function expand() {
        if (pipWindow) pipWindow.close();
        if (floatReason === 'discovery') {
            bridge.toggleDiscoveryMode(false); // calls back into onDiscoveryExit -> hide()
        } else {
            hide();
        }
    }

    // ---------------------------------------------------------
    // Data sync (widget is a read-only mirror of the main player UI)
    // ---------------------------------------------------------
    function syncNow() {
        const doc = pipWindow ? pipWindow.document : document;
        const titleSrc = document.getElementById('player-title');
        const subtitleSrc = document.getElementById('player-author');
        const progressSrc = document.getElementById('progress-bar');

        const titleEl = doc.getElementById('mpw-title');
        const subtitleEl = doc.getElementById('mpw-subtitle');
        const progressEl = doc.getElementById('mpw-progress');

        if (titleEl && titleSrc) titleEl.textContent = titleSrc.textContent;
        if (subtitleEl && subtitleSrc) subtitleEl.textContent = subtitleSrc.textContent;
        if (progressEl && progressSrc) progressEl.style.width = progressSrc.style.width || '0%';
        updatePlayIcon();
    }

    function updatePlayIcon() {
        const doc = pipWindow ? pipWindow.document : document;
        const btn = doc.getElementById('mpw-play-btn');
        if (!btn) return;
        btn.innerHTML = bridge.audio.paused
            ? '<i class="fas fa-play"></i>'
            : '<i class="fas fa-pause"></i>';
    }

    // ---------------------------------------------------------
    // Drag + corner snapping (Pointer Events)
    // ---------------------------------------------------------
    function setupDrag() {
        let startX = 0, startY = 0, origLeft = 0, origTop = 0;
        let dragging = false, pointerId = null;

        // Two cases have no drag surface and expand on a plain tap:
        // inside the PiP window, and the fixed mobile bar. (Desktop clicks
        // are resolved by the pointerup handler below instead.)
        card.addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            if (pipWindow) {
                window.focus();
                expand();
            } else if (window.innerWidth <= 640) {
                expand();
            }
        });

        card.addEventListener('pointerdown', (e) => {
            if (pipWindow) return;                         // PiP: click handler above
            if (e.target.closest('button')) return;      // buttons handle themselves
            if (window.innerWidth <= 640) return;          // mobile: fixed bar, no drag
            pointerId = e.pointerId;
            startX = e.clientX;
            startY = e.clientY;
            const rect = root.getBoundingClientRect();
            origLeft = rect.left;
            origTop = rect.top;
            dragging = false;
            card.setPointerCapture(pointerId);
        });

        card.addEventListener('pointermove', (e) => {
            if (pointerId === null || e.pointerId !== pointerId) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
            dragging = true;
            root.classList.remove('mpw-snapping');
            const rect = root.getBoundingClientRect();
            const x = clamp(origLeft + dx, MARGIN, window.innerWidth - rect.width - MARGIN);
            const y = clamp(origTop + dy, MARGIN, window.innerHeight - rect.height - MARGIN);
            root.style.left = x + 'px';
            root.style.top = y + 'px';
            root.style.right = 'auto';
            root.style.bottom = 'auto';
        });

        const endDrag = (e) => {
            if (pointerId === null || e.pointerId !== pointerId) return;
            pointerId = null;
            if (dragging) {
                snapToNearestCorner();
            } else {
                expand(); // plain click on the card body
            }
            dragging = false;
        };
        card.addEventListener('pointerup', endDrag);
        card.addEventListener('pointercancel', (e) => {
            if (e.pointerId === pointerId) {
                pointerId = null;
                if (dragging) snapToNearestCorner();
                dragging = false;
            }
        });

        window.addEventListener('resize', () => {
            if (root.classList.contains('mpw-visible')) applyCorner(loadCorner());
        });
    }

    function clamp(v, min, max) {
        return Math.max(min, Math.min(max, v));
    }

    function snapToNearestCorner() {
        const rect = root.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const corner =
            (cy < window.innerHeight / 2 ? 't' : 'b') +
            (cx < window.innerWidth / 2 ? 'l' : 'r');
        saveCorner(corner);
        root.classList.add('mpw-snapping');
        applyCorner(corner);
    }

    function applyCorner(corner) {
        if (window.innerWidth <= 640) return; // mobile layout handled purely by CSS
        const rect = root.getBoundingClientRect();
        const w = rect.width || 320;
        const h = rect.height || 60;
        const x = corner.endsWith('l') ? MARGIN : window.innerWidth - w - MARGIN;
        const y = corner.startsWith('t') ? MARGIN : window.innerHeight - h - MARGIN;
        root.style.left = x + 'px';
        root.style.top = y + 'px';
        root.style.right = 'auto';
        root.style.bottom = 'auto';
    }

    function loadCorner() {
        const c = localStorage.getItem(CORNER_KEY);
        return ['tl', 'tr', 'bl', 'br'].includes(c) ? c : 'br';
    }

    function saveCorner(corner) {
        localStorage.setItem(CORNER_KEY, corner);
    }

    // ---------------------------------------------------------
    // Tier 3: Document Picture-in-Picture
    // ---------------------------------------------------------
    async function openPiP() {
        if (pipWindow) {
            pipWindow.focus();
            return;
        }
        if (!bridge.STATE.currentBook) return;

        // Remember where we came from: opened straight from the full player
        // (null) means closing PiP should NOT leave the in-page widget behind.
        pipReturnReason = floatReason;

        pipWindow = await window.documentPictureInPicture.requestWindow({
            width: 380,
            height: 120,
        });

        // Copy only the two sheets the PiP content needs: Font Awesome + our own.
        for (const href of [
            'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css',
            '/static/css/mini-player.css',
        ]) {
            const link = pipWindow.document.createElement('link');
            link.rel = 'stylesheet';
            link.href = href;
            pipWindow.document.head.appendChild(link);
        }
        // Mirror the active color theme variable so the progress bar matches.
        const primary = getComputedStyle(document.documentElement)
            .getPropertyValue('--theme-primary');
        if (primary) {
            pipWindow.document.documentElement.style.setProperty('--theme-primary', primary);
        }

        pipWindow.document.title = 'Cloud TTS Reader';
        pipWindow.document.body.classList.add('mpw-pip-body');

        // MOVE (not clone) the card so button listeners keep working —
        // the PiP window shares this page's JS realm.
        pipWindow.document.body.appendChild(card);
        root.classList.remove('mpw-visible'); // in-page shell hides while PiP owns the card

        pipWindow.addEventListener('pagehide', () => {
            // Return the card to the in-page widget when the PiP window closes.
            root.appendChild(card);
            pipWindow = null;
            floatReason = pipReturnReason;
            if (floatReason) {
                root.classList.add('mpw-visible');
                applyCorner(loadCorner());
            } else {
                hide(); // opened from the full player: nothing to leave behind
            }
            syncNow();
        });

        if (!syncTimer) syncTimer = setInterval(syncNow, SYNC_INTERVAL_MS);
        syncNow();
    }

    // ---------------------------------------------------------
    // Public API (used by app.js — Tier 2 hooks)
    // ---------------------------------------------------------
    window.MiniPlayerWidget = {
        show,
        hide,
        // Discovery opened. keepAlive=true means audio session survived.
        onDiscoveryEnter(keepAlive) {
            if (keepAlive) {
                show('discovery');
            } else {
                if (pipWindow) pipWindow.close();
                hide();
            }
        },
        // Back to the reader: the full player is visible again.
        onDiscoveryExit() {
            if (pipWindow) pipWindow.close();
            hide();
        },
    };

    // ---------------------------------------------------------
    // Boot — app.js (an ES module executed before this script's
    // listener fires) exposes the bridge, then we build the DOM.
    // ---------------------------------------------------------
    function init() {
        bridge = window.MPW_BRIDGE;
        buildWidget();
        injectPopoutButton();
        console.log('[MPW] Mini player widget ready.');
    }

    if (window.MPW_BRIDGE) {
        init();
    } else {
        document.addEventListener('mpw-bridge-ready', init, { once: true });
    }
})();
