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

    const SYNC_INTERVAL_MS = 1000;
    const DRAG_THRESHOLD_PX = 6;
    const CORNER_KEY = 'mpw-corner';
    const COLLAPSED_KEY = 'mpw-collapsed';
    const MARGIN = 16; // px safe margin from viewport edges

    let bridge = null;          // window.MPW_BRIDGE from app.js
    let root = null;            // #mini-player-widget
    let card = null;            // .mpw-card
    let syncTimer = null;
    let floatReason = null;     // 'manual' | 'discovery' | null
    let pipWindow = null;       // Document PiP window, if open
    let pipReturnReason = null; // floatReason to restore when PiP closes

    // Borderless video PiP (canvas → captureStream). Unlike Document PiP,
    // the classic video PiP window has NO origin bar; playback is driven by
    // Chrome's native overlay buttons through the Media Session handlers
    // that app.js already registers (play/pause/prev/next).
    let pipCanvas = null;
    let pipVideo = null;
    let pipDrawTimer = null;
    let isExitingPip = false;
    let lastPipTime = 0;
    let pipLayout = 'full';
    const PIP_LAYOUTS = Object.freeze({
        full: { width: 480, height: 140 },
        compact: { width: 50, height: 50 },
    });
    const PIP_DPR = 1;
    const PIP_FRAME_RATE = 1;

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
                <button class="mpw-btn" id="mpw-collapse-btn" title="Thu gọn thành nút tròn"><i class="fas fa-compress-alt"></i></button>
                <button class="mpw-btn" id="mpw-pip-btn" title="Picture-in-Picture" hidden><i class="fas fa-external-link-alt"></i></button>
                <button class="mpw-btn" id="mpw-pip-round-btn" title="PiP dạng tròn" hidden><i class="fas fa-circle"></i></button>
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
        root.querySelector('#mpw-collapse-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            setCollapsed(true);
        });

        // Tier 3: PiP — only shown when the browser supports either flavor
        const pipBtn = root.querySelector('#mpw-pip-btn');
        const roundPipBtn = root.querySelector('#mpw-pip-round-btn');
        if (document.pictureInPictureEnabled || 'documentPictureInPicture' in window) {
            pipBtn.hidden = false;
            roundPipBtn.hidden = false;
            pipBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                openBestPiP('full').catch(err => console.error('[MPW] PiP failed:', err));
            });
            roundPipBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (pipWindow) {
                    const compact = pipWindow.document.body.classList.contains('mpw-pip-compact');
                    setDocumentPipLayout(compact ? 'full' : 'compact');
                    return;
                }
                openBestPiP('compact').catch(err => console.error('[MPW] Round PiP failed:', err));
            });
        }

        setupDrag();

        // Instant play/pause icon updates & PiP video syncing
        bridge.audio.addEventListener('play', () => {
            updatePlayIcon();
            if (pipVideo && document.pictureInPictureElement === pipVideo && pipVideo.paused) {
                pipVideo.play().catch(e => console.warn('[MPW] failed to play pipVideo:', e));
            }
        });
        bridge.audio.addEventListener('pause', () => {
            updatePlayIcon();
            if (pipVideo && document.pictureInPictureElement === pipVideo && !pipVideo.paused) {
                pipVideo.pause();
            }
        });
    }

    // Adds the one-click PiP button onto the existing full-size player.
    function injectPopoutButton() {
        const mediaPlayer = document.getElementById('media-player');
        if (!mediaPlayer || document.getElementById('mpw-player-pip-btn')) return;

        if (document.pictureInPictureEnabled || 'documentPictureInPicture' in window) {
            const pipBtn = document.createElement('button');
            pipBtn.id = 'mpw-player-pip-btn';
            pipBtn.title = 'Picture-in-Picture (floating window)';
            pipBtn.innerHTML = '<i class="fas fa-window-restore"></i>';
            pipBtn.addEventListener('click', () => {
                openBestPiP('full').catch(err => console.error('[MPW] PiP failed:', err));
            });
            mediaPlayer.appendChild(pipBtn);

            const roundBtn = document.createElement('button');
            roundBtn.id = 'mpw-player-round-pip-btn';
            roundBtn.title = 'PiP dạng tròn';
            roundBtn.innerHTML = '<i class="fas fa-circle"></i>';
            roundBtn.addEventListener('click', () => {
                openBestPiP('compact').catch(err => console.error('[MPW] Round PiP failed:', err));
            });
            mediaPlayer.appendChild(roundBtn);
        }
    }

    // ---------------------------------------------------------
    // Show / hide / close
    // ---------------------------------------------------------
    function show(reason) {
        if (!bridge.STATE.currentBook) return;
        floatReason = reason || 'manual';
        root.classList.add('mpw-visible');
        setCollapsed(localStorage.getItem(COLLAPSED_KEY) === 'true', false);
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

    function setCollapsed(collapsed, persist = true) {
        root.classList.toggle('mpw-collapsed', collapsed);
        card.setAttribute('aria-label', collapsed
            ? 'Mở trình phát thu nhỏ'
            : 'Trình phát thu nhỏ');
        if (persist) localStorage.setItem(COLLAPSED_KEY, String(collapsed));
        if (root.classList.contains('mpw-visible')) applyCorner(loadCorner());
    }

    function closeVideoPiPIfOpen() {
        if (document.pictureInPictureElement) {
            document.exitPictureInPicture().catch(() => { });
        }
    }

    function closeAndStop() {
        if (pipWindow) pipWindow.close();
        closeVideoPiPIfOpen();
        bridge.stopPlaybackSession();
        hide();
    }

    // Tapping the widget body expands back to the full player
    function expand() {
        if (pipWindow) pipWindow.close();
        closeVideoPiPIfOpen();
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
            if (root.classList.contains('mpw-collapsed')) {
                setCollapsed(false);
                return;
            }
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
    // Tier 3a: Borderless video PiP (no origin bar)
    // ---------------------------------------------------------
    function ensureVideoPipElements() {
        if (pipCanvas) return;
        pipCanvas = document.createElement('canvas');
        pipVideo = document.createElement('video');
        pipVideo.muted = true;
        pipVideo.playsInline = true;
        pipVideo.setAttribute('aria-hidden', 'true');
        pipVideo.style.cssText =
            'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
        
        // Sync PiP video playback events back to main audio
        pipVideo.addEventListener('play', () => {
            if (isExitingPip) return;
            if (document.pictureInPictureElement === pipVideo) {
                if (bridge && bridge.audio && bridge.audio.paused) {
                    bridge.togglePlayback();
                }
            }
        });
        pipVideo.addEventListener('pause', () => {
            if (isExitingPip) return;
            if (document.pictureInPictureElement === pipVideo) {
                if (bridge && bridge.audio && !bridge.audio.paused) {
                    bridge.audio.pause();
                }
            }
        });

        // Detect seek forward/backward from native PiP window controls
        pipVideo.addEventListener('timeupdate', () => {
            if (document.pictureInPictureElement === pipVideo) {
                const curTime = pipVideo.currentTime;
                if (Math.abs(curTime - lastPipTime) < 2.0) {
                    lastPipTime = curTime;
                }
            }
        });
        pipVideo.addEventListener('seeking', () => {
            if (isExitingPip) return;
            if (document.pictureInPictureElement !== pipVideo) return;

            const curTime = pipVideo.currentTime;
            const diff = curTime - lastPipTime;

            if (Math.abs(diff) >= 2.0) {
                if (diff > 0) {
                    console.log('[MPW] PiP seeking forward:', diff);
                    if (bridge && bridge.playNextChunk) {
                        bridge.playNextChunk();
                    }
                } else {
                    console.log('[MPW] PiP seeking backward:', diff);
                    if (bridge && bridge.playPrevChunk) {
                        bridge.playPrevChunk();
                    }
                }
                lastPipTime = curTime;
            }
        });

        document.body.appendChild(pipVideo);
    }

    function configurePipCanvas(layout) {
        const nextLayout = PIP_LAYOUTS[layout] ? layout : 'full';
        const dimensions = PIP_LAYOUTS[nextLayout];
        pipLayout = nextLayout;

        if (pipCanvas.width === dimensions.width * PIP_DPR
            && pipCanvas.height === dimensions.height * PIP_DPR) return;

        if (pipVideo.srcObject) {
            pipVideo.srcObject.getTracks().forEach(track => track.stop());
            pipVideo.srcObject = null;
        }
        pipCanvas.width = dimensions.width * PIP_DPR;
        pipCanvas.height = dimensions.height * PIP_DPR;
    }

    function wrapText(ctx, text, maxWidth, maxLines) {
        const words = String(text || '').split(/\s+/);
        const lines = [];
        let line = '';
        for (const word of words) {
            const probe = line ? `${line} ${word}` : word;
            if (ctx.measureText(probe).width > maxWidth && line) {
                lines.push(line);
                line = word;
                if (lines.length === maxLines) break;
            } else {
                line = probe;
            }
        }
        if (lines.length < maxLines && line) lines.push(line);
        return lines;
    }

    function getSentencePair() {
        const state = bridge.STATE;
        const chapter = state.currentBook?.chapters?.[state.currentChapterIndex];
        const sentences = chapter?.sentences;
        if (!sentences?.length) return null;
        const index = Math.max(0, state.currentSentenceIndex || 0);
        return { current: sentences[index] || '', next: sentences[index + 1] || '' };
    }

    function drawFullPipFrame(ctx, primary, progress) {
        const dimensions = PIP_LAYOUTS.full;
        const chapterTitle = document.getElementById('player-title')?.textContent || '';
        const pair = getSentencePair();
        const textX = 20;
        const textWidth = dimensions.width - textX * 2;

        const background = ctx.createLinearGradient(0, 0, dimensions.width, dimensions.height);
        background.addColorStop(0, '#10151f');
        background.addColorStop(0.6, '#0b0f17');
        background.addColorStop(1, '#0e1a22');
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, dimensions.width, dimensions.height);

        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = '#64748b';
        ctx.font = '700 10px Inter, system-ui, sans-serif';
        ctx.fillText(
            wrapText(ctx, chapterTitle.toUpperCase(), textWidth, 1)[0] || '',
            textX,
            22
        );

        ctx.fillStyle = '#ffffff';
        ctx.font = '600 15px Inter, system-ui, sans-serif';
        const lines = wrapText(ctx, pair?.current || chapterTitle, textWidth, 3);
        const lineHeight = 20;
        let textY = 52 - Math.round(((lines.length - 1) * lineHeight) / 2);
        for (const line of lines) {
            ctx.fillText(line, textX, textY);
            textY += lineHeight;
        }

        if (pair?.next) {
            ctx.fillStyle = primary;
            ctx.font = '400 12px Inter, system-ui, sans-serif';
            ctx.fillText('▸', textX, dimensions.height - 17);
            ctx.fillStyle = '#64748b';
            ctx.fillText(
                wrapText(ctx, pair.next, textWidth - 14, 1)[0] || '',
                textX + 14,
                dimensions.height - 17
            );
        }

        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fillRect(0, dimensions.height - 5, dimensions.width, 5);
        ctx.fillStyle = primary;
        ctx.fillRect(0, dimensions.height - 5, dimensions.width * progress / 100, 5);
    }

    function drawCompactPipFrame(ctx, primary, progress) {
        const dimensions = PIP_LAYOUTS.compact;
        const center = dimensions.width / 2;
        const radius = 21;

        ctx.fillStyle = '#070a10';
        ctx.fillRect(0, 0, dimensions.width, dimensions.height);

        const bubble = ctx.createRadialGradient(center - 6, center - 7, 2, center, center, radius);
        bubble.addColorStop(0, '#1f2937');
        bubble.addColorStop(1, '#0b0f17');
        ctx.beginPath();
        ctx.arc(center, center, radius, 0, Math.PI * 2);
        ctx.fillStyle = bubble;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(center, center, radius - 1, -Math.PI / 2,
            -Math.PI / 2 + Math.PI * 2 * progress / 100);
        ctx.strokeStyle = primary;
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        if (bridge.audio.paused) {
            ctx.beginPath();
            ctx.moveTo(center - 4, center - 7);
            ctx.lineTo(center + 8, center);
            ctx.lineTo(center - 4, center + 7);
            ctx.closePath();
            ctx.fill();
        } else {
            ctx.fillRect(center - 6, center - 7, 4, 14);
            ctx.fillRect(center + 2, center - 7, 4, 14);
        }
    }

    function drawPipFrame() {
        const ctx = pipCanvas.getContext('2d');
        const primary = (getComputedStyle(document.documentElement)
            .getPropertyValue('--theme-primary') || '#00E5FF').trim() || '#00E5FF';
        const rawProgress = parseFloat(
            ((document.getElementById('progress-bar') || {}).style || {}).width) || 0;
        const progress = Math.min(100, Math.max(0, rawProgress));

        ctx.save();
        ctx.scale(PIP_DPR, PIP_DPR);
        if (pipLayout === 'compact') drawCompactPipFrame(ctx, primary, progress);
        else drawFullPipFrame(ctx, primary, progress);
        ctx.restore();
    }

    async function openVideoPiP(layout = 'full') {
        if (!bridge.STATE.currentBook) return;
        if (document.pictureInPictureElement) return; // already open
        ensureVideoPipElements();
        configurePipCanvas(layout);
        drawPipFrame();
        if (!pipVideo.srcObject) pipVideo.srcObject = pipCanvas.captureStream(PIP_FRAME_RATE);
        const startPaused = bridge.audio.paused;
        // Prime the canvas stream before requesting PiP. Requesting PiP on a
        // never-started video fails on Chrome when the audiobook is paused.
        await pipVideo.play();
        lastPipTime = pipVideo.currentTime; // Align initial time
        await pipVideo.requestPictureInPicture();
        if (startPaused) pipVideo.pause();
        pipDrawTimer = setInterval(drawPipFrame, 1000);
        pipVideo.addEventListener('leavepictureinpicture', stopVideoPiP, { once: true });
    }

    function stopVideoPiP() {
        isExitingPip = true;
        if (pipDrawTimer) {
            clearInterval(pipDrawTimer);
            pipDrawTimer = null;
        }
        if (pipVideo) pipVideo.pause();
        isExitingPip = false;
    }

    // Prefer the borderless Canvas Video PiP; fall back to Document PiP.
    function openBestPiP(layout = 'full') {
        if (document.pictureInPictureEnabled) {
            return openVideoPiP(layout);
        } else if ('documentPictureInPicture' in window) {
            return openPiP(layout);
        } else {
            return Promise.reject(new Error('Picture-in-Picture unsupported'));
        }
    }

    // ---------------------------------------------------------
    // Tier 3b: Document Picture-in-Picture (fallback — has origin bar)
    // ---------------------------------------------------------
    function setDocumentPipLayout(layout) {
        if (!pipWindow) return;
        const compact = layout === 'compact';
        pipWindow.document.body.classList.toggle('mpw-pip-compact', compact);
        const button = pipWindow.document.getElementById('mpw-pip-round-btn');
        if (button) {
            button.title = compact ? 'Trở lại PiP đầy đủ' : 'PiP dạng tròn';
            button.innerHTML = compact
                ? '<i class="fas fa-expand-alt"></i>'
                : '<i class="fas fa-circle"></i>';
        }
        try {
            pipWindow.resizeTo(compact ? 50 : 480, compact ? 50 : 148);
        } catch (_) {
            // Window sizing is controlled by the browser/OS on some platforms.
        }
    }

    async function openPiP(layout = 'full') {
        if (pipWindow) {
            setDocumentPipLayout(layout);
            pipWindow.focus();
            return;
        }
        if (!bridge.STATE.currentBook) return;

        // Remember where we came from: opened straight from the full player
        // (null) means closing PiP should NOT leave the in-page widget behind.
        pipReturnReason = floatReason;

        const compact = layout === 'compact';
        pipWindow = await window.documentPictureInPicture.requestWindow({
            width: compact ? 50 : 480,
            height: compact ? 50 : 148,
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
        setDocumentPipLayout(layout);

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
