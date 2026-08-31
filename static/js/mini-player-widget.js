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
    const PIP_LAYOUTS = Object.freeze({
        full: { width: 640, height: 220 },
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
                <div class="mpw-transport" aria-label="Điều khiển đọc">
                    <button class="mpw-btn" id="mpw-prev-btn" title="Chương trước" aria-label="Chương trước"><i class="fas fa-fast-backward"></i></button>
                    <button class="mpw-btn" id="mpw-prev-chunk-btn" title="Câu trước" aria-label="Câu trước"><i class="fas fa-step-backward"></i></button>
                    <button class="mpw-btn mpw-play" id="mpw-play-btn" title="Phát hoặc tạm dừng" aria-label="Phát hoặc tạm dừng"><i class="fas fa-play"></i></button>
                    <button class="mpw-btn" id="mpw-next-chunk-btn" title="Câu kế" aria-label="Câu kế"><i class="fas fa-step-forward"></i></button>
                    <button class="mpw-btn" id="mpw-next-btn" title="Chương kế" aria-label="Chương kế"><i class="fas fa-fast-forward"></i></button>
                </div>
                <div class="mpw-actions" aria-label="Tùy chọn trình phát">
                    <button class="mpw-btn" id="mpw-collapse-btn" title="Thu gọn thành nút tròn" aria-label="Thu gọn trình phát">
                        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <rect x="3.5" y="6.5" width="17" height="11" rx="5.5" stroke="currentColor" stroke-width="2.2" />
                            <circle cx="8" cy="12" r="2.2" fill="currentColor" />
                            <line x1="12" y1="12" x2="16.5" y2="12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
                        </svg>
                    </button>
                    <button class="mpw-btn" id="mpw-pip-btn" title="Mở cửa sổ PiP" aria-label="Mở cửa sổ PiP" hidden>
                        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <rect x="2.5" y="4.5" width="19" height="15" rx="3" stroke="currentColor" stroke-width="2" stroke-opacity="0.8" />
                            <rect x="11.5" y="10.5" width="8" height="7" rx="1.8" fill="currentColor" fill-opacity="0.3" stroke="currentColor" stroke-width="1.8" />
                        </svg>
                    </button>
                    <button class="mpw-btn" id="mpw-close-btn" title="Dừng và đóng" aria-label="Dừng và đóng"><i class="fas fa-times"></i></button>
                </div>
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
        root.querySelector('#mpw-prev-chunk-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            const btn = document.getElementById('prev-chunk-btn');
            if (btn) btn.click();
        });
        root.querySelector('#mpw-next-chunk-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            const btn = document.getElementById('next-chunk-btn');
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
        if (document.pictureInPictureEnabled || 'documentPictureInPicture' in window) {
            pipBtn.hidden = false;
            pipBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                openBestPiP().catch(err => console.error('[MPW] PiP failed:', err));
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
            pipBtn.innerHTML = `
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <rect x="2.5" y="4.5" width="19" height="15" rx="3" stroke="currentColor" stroke-width="2" stroke-opacity="0.8" />
                    <rect x="11.5" y="10.5" width="8" height="7" rx="1.8" fill="currentColor" fill-opacity="0.3" stroke="currentColor" stroke-width="1.8" />
                </svg>`;
            pipBtn.addEventListener('click', () => {
                openBestPiP().catch(err => console.error('[MPW] PiP failed:', err));
            });
            mediaPlayer.appendChild(pipBtn);

        }
    }

    // ---------------------------------------------------------
    // Show / hide / close
    // ---------------------------------------------------------
    function show(reason) {
        if (!bridge?.STATE?.currentBook || !root) return;
        floatReason = reason || 'manual';
        root.classList.add('mpw-visible');
        setCollapsed(localStorage.getItem(COLLAPSED_KEY) === 'true', false);
        applyCorner(loadCorner());
        syncNow();
        if (window.gsap && card) {
            window.gsap.fromTo(card,
                { scale: 0.88, opacity: 0, y: 16 },
                { scale: 1, opacity: 1, y: 0, duration: 0.35, ease: 'back.out(1.5)', overwrite: 'auto' }
            );
        }
        if (!syncTimer) syncTimer = setInterval(syncNow, SYNC_INTERVAL_MS);
    }

    function hide() {
        floatReason = null;
        if (root) {
            root.classList.remove('mpw-visible');
        }
        if (syncTimer) {
            clearInterval(syncTimer);
            syncTimer = null;
        }
    }

    function setCollapsed(collapsed, persist = true) {
        if (!root) return;
        root.classList.toggle('mpw-collapsed', collapsed);
        if (card) {
            card.setAttribute('aria-label', collapsed
                ? 'Mở trình phát thu nhỏ'
                : 'Trình phát thu nhỏ');
        }
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

        const buttonPairs = [
            ['mpw-prev-btn', 'prev-btn'],
            ['mpw-prev-chunk-btn', 'prev-chunk-btn'],
            ['mpw-next-chunk-btn', 'next-chunk-btn'],
            ['mpw-next-btn', 'next-btn'],
        ];
        buttonPairs.forEach(([widgetId, sourceId]) => {
            const widgetButton = doc.getElementById(widgetId);
            const sourceButton = document.getElementById(sourceId);
            if (widgetButton && sourceButton) widgetButton.disabled = sourceButton.disabled;
        });

        if (titleEl && titleSrc) {
            titleEl.textContent = pipWindow && subtitleSrc?.textContent
                ? `${titleSrc.textContent} • ${subtitleSrc.textContent}`
                : titleSrc.textContent;
        }
        if (subtitleEl && subtitleSrc) subtitleEl.textContent = pipWindow ? '' : subtitleSrc.textContent;
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

    function configurePipCanvas() {
        const dimensions = PIP_LAYOUTS.full;
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
            } else {
                line = probe;
            }
        }
        if (line) lines.push(line);
        return lines.slice(0, maxLines);
    }

    function fitText(ctx, text, maxWidth, maxLines, weight, maxSize, minSize, maxHeight = Infinity) {
        const value = String(text || '').trim();
        for (let size = maxSize; size >= minSize; size -= 1) {
            ctx.font = `${weight} ${size}px Arial, sans-serif`;
            const lines = wrapText(ctx, value, maxWidth, maxLines);
            const overflow = wrapText(ctx, value, maxWidth, maxLines + 1).length > maxLines;
            const lineHeight = Math.max(11, Math.round(size * 1.15));
            if (!overflow && lines.length * lineHeight <= maxHeight) return lines;
        }

        ctx.font = `${weight} ${minSize}px Arial, sans-serif`;
        const lines = wrapText(ctx, value, maxWidth, maxLines);
        if (lines.length === maxLines) {
            let last = lines[maxLines - 1];
            while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) {
                last = last.slice(0, -1);
            }
            lines[maxLines - 1] = `${last}…`;
        }
        return lines;
    }

    function getFontSize(ctx, fallback) {
        const match = String(ctx.font || '').match(/(\d+(?:\.\d+)?)px/);
        return match ? Number(match[1]) : fallback;
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
        const bookTitle = document.getElementById('player-author')?.textContent || 'Cloud TTS Reader';
        const pair = getSentencePair();
        const left = 24;
        const contentWidth = dimensions.width - left * 2;
        const headerText = [chapterTitle, bookTitle].filter(Boolean).join(' • ');

        const style = getComputedStyle(document.documentElement);
        const bg = (style.getPropertyValue('--theme-bg') || '#080d1a').trim();
        const surface = (style.getPropertyValue('--theme-surface') || '#0e172a').trim();
        const surfaceHigh = (style.getPropertyValue('--theme-surface-high') || '#18243e').trim();
        const textReading = (style.getPropertyValue('--theme-text-reading') || '#f8fafc').trim();
        const textMain = (style.getPropertyValue('--theme-text') || '#ffffff').trim();
        const isLight = style.getPropertyValue('--theme-is-light').trim() === '1';

        const background = ctx.createLinearGradient(0, 0, dimensions.width, dimensions.height);
        background.addColorStop(0, bg);
        background.addColorStop(0.55, surface);
        background.addColorStop(1, surfaceHigh);
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, dimensions.width, dimensions.height);

        const glow = ctx.createRadialGradient(dimensions.width - 40, 16, 4, dimensions.width - 40, 16, 180);
        glow.addColorStop(0, `${primary}33`);
        glow.addColorStop(1, `${primary}00`);
        ctx.fillStyle = glow;
        ctx.fillRect(dimensions.width - 220, 0, 220, 150);

        ctx.fillStyle = `${primary}22`;
        ctx.fillRect(0, 0, 5, dimensions.height);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = isLight ? textMain : '#f8fafc';
        const headerLines = fitText(ctx, headerText || 'Cloud TTS Reader', contentWidth, 1, '700', 15, 8);
        ctx.fillText(headerLines[0] || 'Cloud TTS Reader', left, 34);
        ctx.fillStyle = `${primary}88`;
        ctx.fillRect(left, 47, contentWidth, 2);

        ctx.fillStyle = isLight ? textReading : '#f8fafc';
        const progressTop = dimensions.height - 27;
        const currentAvailableHeight = Math.max(30, progressTop - 78 - 14);
        const lines = fitText(ctx, pair?.current || 'Sẵn sàng phát nội dung', contentWidth, 10, '600', 20, 8, currentAvailableHeight);
        const currentSize = getFontSize(ctx, 20);
        const currentLineHeight = Math.max(11, Math.round(currentSize * 1.15));
        let textY = 78;
        for (const line of lines) {
            ctx.fillText(line, left, textY);
            textY += currentLineHeight;
        }
        if (pair?.next) {
            const nextTop = textY + Math.max(8, Math.round(currentLineHeight * 0.55));
            const availableNextHeight = Math.max(0, progressTop - nextTop);
            const nextFontMaxLines = Math.max(1, Math.min(5, Math.floor(availableNextHeight / 12)));
            ctx.fillStyle = isLight ? '#78716c' : '#64748b';
            ctx.font = '600 10px Arial, sans-serif';
            const nextLabel = 'Tiếp theo';
            const labelWidth = ctx.measureText(nextLabel).width;
            const nextWidth = Math.max(120, contentWidth - labelWidth - 10);
            const nextLines = fitText(ctx, pair.next, nextWidth, nextFontMaxLines, '500', 12, 8, availableNextHeight);
            const nextSize = getFontSize(ctx, 10);
            const nextLineHeight = Math.max(10, Math.round(nextSize * 1.15));
            ctx.fillText(nextLabel, left, nextTop);
            ctx.font = `500 ${nextSize}px Arial, sans-serif`;
            if (nextLines[0]) ctx.fillText(nextLines[0], left + labelWidth + 10, nextTop);
            for (let index = 1; index < nextLines.length; index += 1) {
                ctx.fillText(nextLines[index], left, nextTop + index * nextLineHeight);
            }
        }

        ctx.fillStyle = isLight ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.10)';
        ctx.fillRect(left, dimensions.height - 17, dimensions.width - left * 2, 3);
        ctx.fillStyle = primary;
        ctx.fillRect(left, dimensions.height - 17, (dimensions.width - left * 2) * progress / 100, 3);
        ctx.fillStyle = isLight ? '#78716c' : '#94a3b8';
        ctx.font = '600 10px Arial, sans-serif';
        ctx.fillText(`${Math.round(progress)}%`, dimensions.width - 52, dimensions.height - 21);
    }

    function drawPipFrame() {
        const ctx = pipCanvas.getContext('2d');
        const primary = (getComputedStyle(document.documentElement)
            .getPropertyValue('--theme-primary') || '#D4AF37').trim() || '#D4AF37';
        const rawProgress = parseFloat(
            ((document.getElementById('progress-bar') || {}).style || {}).width) || 0;
        const progress = Math.min(100, Math.max(0, rawProgress));

        ctx.save();
        ctx.scale(PIP_DPR, PIP_DPR);
        drawFullPipFrame(ctx, primary, progress);
        ctx.restore();
    }

    async function openVideoPiP() {
        if (!bridge.STATE.currentBook) return;
        if (document.pictureInPictureElement) return; // already open
        ensureVideoPipElements();
        configurePipCanvas();
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
    function openBestPiP() {
        if (document.pictureInPictureEnabled) {
            return openVideoPiP();
        } else if ('documentPictureInPicture' in window) {
            return openPiP();
        } else {
            return Promise.reject(new Error('Picture-in-Picture unsupported'));
        }
    }

    // ---------------------------------------------------------
    // Tier 3b: Document Picture-in-Picture (fallback — has origin bar)
    // ---------------------------------------------------------
    function syncPipTheme() {
        if (!pipWindow || !pipWindow.document) return;
        const curTheme = document.documentElement.getAttribute('data-theme');
        if (curTheme) {
            pipWindow.document.documentElement.setAttribute('data-theme', curTheme);
            pipWindow.document.body.setAttribute('data-theme', curTheme);
        } else {
            pipWindow.document.documentElement.removeAttribute('data-theme');
            pipWindow.document.body.removeAttribute('data-theme');
        }
        const computed = getComputedStyle(document.documentElement);
        [
            '--theme-primary', '--theme-primary-dim', '--theme-bg',
            '--theme-surface', '--theme-surface-high', '--theme-text',
            '--theme-text-reading', '--theme-is-light'
        ].forEach(prop => {
            const val = computed.getPropertyValue(prop);
            if (val) {
                pipWindow.document.documentElement.style.setProperty(prop, val);
            }
        });
    }

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
            width: 640,
            height: 260,
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

        // Mirror active color theme and variables
        syncPipTheme();

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

    // Global listener for live theme changes
    window.addEventListener('themechange', () => {
        syncPipTheme();
        if (pipCanvas && pipVideo && document.pictureInPictureElement === pipVideo) {
            drawPipFrame();
        }
    });

    // ---------------------------------------------------------
    // Public API (used by app.js — Tier 2 hooks)
    // ---------------------------------------------------------
    window.MiniPlayerWidget = {
        show,
        hide,
        // PiP is a Reader-only affordance. Discovery owns a separate return
        // dock, so no floating widget or PiP surface may remain there.
        onDiscoveryEnter() {
            if (pipWindow) pipWindow.close();
            hide();
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
