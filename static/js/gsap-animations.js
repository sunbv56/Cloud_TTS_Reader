/*
 * Cloud TTS Reader - visual motion layer
 *
 * This file is intentionally isolated from application state and business
 * logic. It observes the DOM that app.js already updates and adds motion only.
 */
(function () {
    'use strict';

    function startMotionLayer() {
        const gsap = window.gsap;
        if (!gsap) return;

        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const duration = reduceMotion ? 0 : 0.28;
        const ease = 'power3.out';
        const visibilityTargets = [
            'discovery-mode',
            'reader-container',
            'upload-options-modal',
            'upload-files-modal',
            'image-manager-modal',
            'stats-modal',
            'edit-chapter-modal',
            'merge-chapters-modal',
            'image-crop-modal',
            'global-loading'
        ].map(id => document.getElementById(id)).filter(Boolean);
        const visibility = new WeakMap();
        const animatedChildren = new WeakSet();
        const spotlightCards = new WeakSet();
        let spotlightEnabled = false;
        let compactDiscovery = false;

        gsap.defaults({ overwrite: 'auto' });

        const motionMedia = gsap.matchMedia();
        motionMedia.add({
            desktopPointer: '(hover: hover) and (pointer: fine)',
            compactDiscovery: '(max-width: 639px)',
            reduceMotion: '(prefers-reduced-motion: reduce)'
        }, context => {
            spotlightEnabled = context.conditions.desktopPointer && !context.conditions.reduceMotion;
            compactDiscovery = context.conditions.compactDiscovery;
            return () => {
                spotlightEnabled = false;
                compactDiscovery = false;
            };
        });

        function isVisible(element) {
            if (!element) return false;
            return !element.classList.contains('hidden')
                && !element.classList.contains('translate-x-full');
        }

        function panelFor(element) {
            if (element.id === 'discovery-mode' || element.id === 'reader-container') {
                return element;
            }
            return element.querySelector('.glass') || element;
        }

        function animateOpen(element) {
            if (reduceMotion) return;

            const panel = panelFor(element);
            if (element.id === 'global-loading') {
                gsap.fromTo(panel,
                    { autoAlpha: 0, scale: 0.94 },
                    { autoAlpha: 1, scale: 1, duration: 0.25, ease: 'back.out(1.4)' }
                );
                return;
            }

            gsap.fromTo(panel,
                { autoAlpha: 0, y: 14, scale: 0.985 },
                { autoAlpha: 1, y: 0, scale: 1, duration, ease }
            );

            if (element.id === 'discovery-mode') {
                const intro = element.querySelector('header, input, #discovery-grid, #discovery-drop-zone');
                if (intro) {
                    gsap.fromTo(intro,
                        { autoAlpha: 0, y: 10 },
                        { autoAlpha: 1, y: 0, duration: 0.24, delay: 0.05, ease }
                    );
                }
            }
        }

        function inspectVisibility(element) {
            const visible = isVisible(element);
            const previous = visibility.get(element);
            visibility.set(element, visible);
            if (visible && previous === false) animateOpen(element);
        }

        // Record the initial state so the first paint is never animated.
        visibilityTargets.forEach(inspectVisibility);

        // app.js already owns these class changes; this observer only reacts
        // visually when an existing panel becomes visible.
        const visibilityObserver = new MutationObserver(records => {
            records.forEach(record => {
                const target = record.target;
                if (visibilityTargets.includes(target)) inspectVisibility(target);
            });
        });
        visibilityTargets.forEach(element => visibilityObserver.observe(element, {
            attributes: true,
            attributeFilter: ['class']
        }));

        function animateAddedItems(container, selector) {
            if (reduceMotion || !container) return;
            const items = Array.from(container.children).filter(item => {
                if (animatedChildren.has(item)) return false;
                animatedChildren.add(item);
                return !selector || item.matches(selector);
            });
            if (!items.length) return;
            gsap.fromTo(items,
                { autoAlpha: 0, y: compactDiscovery ? 6 : 10 },
                { autoAlpha: 1, y: 0, duration: compactDiscovery ? 0.22 : 0.26, ease, stagger: compactDiscovery ? 0.035 : 0.045 }
            );
            if (container.id === 'discovery-grid') items.forEach(wireDiscoverySpotlight);
        }

        function wireDiscoverySpotlight(card) {
            if (spotlightCards.has(card)) return;
            spotlightCards.add(card);

            const grid = document.getElementById('discovery-grid');
            const art = card.querySelector('.discovery-book-art');
            const image = art?.querySelector('img');
            const content = card.querySelector('.discovery-book-content');
            const meta = card.querySelector('.discovery-book-meta');
            const progress = card.querySelector('.discovery-book-progress');

            const restore = () => {
                if (!grid) return;
                grid.classList.remove('is-spotlight-active');
                card.classList.remove('is-spotlit');
                gsap.to(card, { scale: 1, y: 0, duration: 0.22, ease: 'power2.out', overwrite: 'auto' });
                gsap.to(art, {
                    y: 0, scale: 1, clipPath: 'inset(0 0 15% 0)',
                    duration: 0.28, ease: 'power3.out', overwrite: 'auto'
                });
                gsap.to(image, { scale: 1, duration: 0.3, ease: 'power3.out', overwrite: 'auto' });
                gsap.to([content, meta, progress].filter(Boolean), {
                    y: 0, autoAlpha: 1, duration: 0.22, ease: 'power2.out', overwrite: 'auto'
                });
            };

            card.addEventListener('pointerenter', () => {
                if (!spotlightEnabled || !grid) return;
                grid.classList.add('is-spotlight-active');
                card.classList.add('is-spotlit');
                gsap.to(card, {
                    y: -4, scale: 1.018,
                    duration: 0.22, ease: 'power3.out', overwrite: 'auto'
                });
                gsap.to(art, {
                    y: -7, scale: 1, clipPath: 'inset(0 0 0% 0)',
                    duration: 0.42, ease: 'power3.out', overwrite: 'auto'
                });
                gsap.to(image, { scale: 1.015, duration: 0.42, ease: 'power3.out', overwrite: 'auto' });
                gsap.to(content, { y: -7, duration: 0.3, ease: 'power3.out', overwrite: 'auto' });
                gsap.fromTo([meta, progress].filter(Boolean),
                    { autoAlpha: 0.68, y: 7 },
                    { autoAlpha: 1, y: 0, duration: 0.28, stagger: 0.035, ease: 'power2.out', overwrite: 'auto' }
                );
            });
            card.addEventListener('pointerleave', restore);
        }

        const listObserver = new MutationObserver(records => {
            records.forEach(record => {
                if (record.type !== 'childList' || !record.addedNodes.length) return;
                if (record.target.id === 'discovery-grid') {
                    animateAddedItems(record.target, '[data-title], .book-card');
                } else if (record.target.id === 'book-list') {
                    animateAddedItems(record.target);
                }
            });
        });

        // TOC is intentionally excluded: it is a metadata-only navigation
        // surface and must not create one tween per chapter or touch its load
        // behavior. Its existing CSS slide transition remains in place.
        ['discovery-grid', 'book-list'].forEach(id => {
            const element = document.getElementById(id);
            if (element) listObserver.observe(element, { childList: true });
        });

        // Sentence and minimap highlighting already happens in app.js. A
        // short transform cue makes the active location easier to follow.
        const highlightObserver = new MutationObserver(records => {
            if (reduceMotion) return;
            records.forEach(record => {
                if (record.type !== 'attributes' || record.attributeName !== 'class') return;
                const element = record.target;
                if (element.classList.contains('chunk-active')) {
                    gsap.fromTo(element,
                        { x: -3, autoAlpha: 0.72 },
                        { x: 0, autoAlpha: 1, duration: 0.2, ease: 'power2.out' }
                    );
                } else if (element.classList.contains('minimap-active')) {
                    gsap.fromTo(element,
                        { scale: 0.75, autoAlpha: 0.55 },
                        { scale: 1, autoAlpha: 1, duration: 0.22, ease: 'back.out(1.6)' }
                    );
                }
            });
        });
        const textContainer = document.getElementById('text-container');
        const minimapNodes = document.getElementById('minimap-nodes');
        if (textContainer) highlightObserver.observe(textContainer, { subtree: true, attributes: true, attributeFilter: ['class'] });
        if (minimapNodes) highlightObserver.observe(minimapNodes, { subtree: true, attributes: true, attributeFilter: ['class'] });

        // Keep playback controls responsive without touching playback state.
        const playButton = document.getElementById('play-btn');
        if (playButton && !reduceMotion) {
            const playObserver = new MutationObserver(() => {
                const icon = playButton.querySelector('i') || playButton;
                gsap.fromTo(icon,
                    { scale: 0.9 },
                    { scale: 1, duration: 0.18, ease: 'back.out(2)' }
                );
            });
            playObserver.observe(playButton, { childList: true, subtree: true });
        }

        const statusIndicator = document.getElementById('status-indicator');
        if (statusIndicator && !reduceMotion) {
            const statusObserver = new MutationObserver(() => {
                gsap.fromTo(statusIndicator,
                    { autoAlpha: 0.45, y: 2 },
                    { autoAlpha: 1, y: 0, duration: 0.18, ease: 'power2.out' }
                );
            });
            statusObserver.observe(statusIndicator, { childList: true, characterData: true, subtree: true });
        }
    }

    // Expose MotionLayer utilities globally
    window.MotionLayer = {
        animateProgressBar(fillEl, percent, duration = 0.35) {
            const gsap = window.gsap;
            const target = Math.max(0, Math.min(100, percent));
            if (!fillEl) return;
            if (!gsap) {
                fillEl.style.width = `${target}%`;
                return;
            }
            gsap.to(fillEl, {
                width: `${target}%`,
                duration: duration,
                ease: 'power2.out'
            });
        },
        animateCounter(el, targetVal, duration = 0.35, suffix = '%') {
            const gsap = window.gsap;
            if (!el) return;
            if (!gsap) {
                el.textContent = `${Math.round(targetVal)}${suffix}`;
                return;
            }
            const currentVal = parseInt(el.textContent, 10) || 0;
            const obj = { val: currentVal };
            gsap.to(obj, {
                val: targetVal,
                duration: duration,
                ease: 'power2.out',
                onUpdate: () => {
                    el.textContent = `${Math.round(obj.val)}${suffix}`;
                }
            });
        },
        setButtonLoading(btn, isLoading, loadingText = '') {
            if (!btn) return;
            const gsap = window.gsap;
            if (isLoading) {
                if (!btn.dataset.originalHtml) {
                    btn.dataset.originalHtml = btn.innerHTML;
                }
                btn.disabled = true;
                btn.classList.add('btn-loading');
                btn.innerHTML = `<span class="btn-loading-spinner"><i class="fas fa-spinner fa-spin"></i><span>${loadingText || 'Đang xử lý...'}</span></span><span class="btn-text-content">${btn.dataset.originalHtml}</span>`;
                if (gsap) {
                    gsap.fromTo(btn, { scale: 0.96 }, { scale: 1, duration: 0.2, ease: 'power2.out' });
                }
            } else {
                btn.disabled = false;
                btn.classList.remove('btn-loading');
                if (btn.dataset.originalHtml) {
                    btn.innerHTML = btn.dataset.originalHtml;
                    delete btn.dataset.originalHtml;
                }
                if (gsap) {
                    gsap.fromTo(btn, { scale: 0.96 }, { scale: 1, duration: 0.25, ease: 'back.out(1.5)' });
                }
            }
        },
        animateSuccessCheck(buttonOrIcon) {
            const gsap = window.gsap;
            if (!buttonOrIcon) return;
            if (!gsap) return;
            gsap.timeline()
                .to(buttonOrIcon, { scale: 1.25, color: '#10b981', duration: 0.2, ease: 'back.out(2)' })
                .to(buttonOrIcon, { scale: 1, color: '', duration: 0.3, delay: 0.8, ease: 'power2.inOut' });
        },
        animateItemRemoval(element, onComplete) {
            const gsap = window.gsap;
            if (!element) {
                if (onComplete) onComplete();
                return;
            }
            if (!gsap) {
                element.remove();
                if (onComplete) onComplete();
                return;
            }
            gsap.to(element, {
                opacity: 0,
                x: 20,
                scale: 0.95,
                height: 0,
                paddingTop: 0,
                paddingBottom: 0,
                marginTop: 0,
                marginBottom: 0,
                duration: 0.28,
                ease: 'power2.in',
                onComplete: () => {
                    element.remove();
                    if (onComplete) onComplete();
                }
            });
        },
        animateSkeletonEntrance(container) {
            const gsap = window.gsap;
            if (!gsap || !container) return;
            const items = container.querySelectorAll('.skeleton-card, .skeleton-line, .skeleton-shimmer');
            if (!items.length) return;
            gsap.fromTo(items,
                { autoAlpha: 0, y: 8 },
                { autoAlpha: 1, y: 0, duration: 0.24, stagger: 0.04, ease: 'power2.out' }
            );
        },
        smoothScrollToSweetSpot(container, targetElement, ratio = 0.28, duration = 0.42) {
            if (!container || !targetElement) return;
            const gsap = window.gsap;
            const containerHeight = container.offsetHeight;
            const offsetTop = targetElement.offsetTop;
            const targetScroll = Math.max(0, offsetTop - (containerHeight * ratio));
            
            if (!gsap) {
                container.scrollTo({ top: targetScroll, behavior: 'smooth' });
                return;
            }
            gsap.to(container, {
                scrollTop: targetScroll,
                duration: duration,
                ease: 'power2.out',
                overwrite: 'auto'
            });
        },
        animateToastIn(toastEl) {
            if (!toastEl) return;
            const gsap = window.gsap;
            if (!gsap) return;
            gsap.fromTo(toastEl,
                { y: -24, scale: 0.92, opacity: 0 },
                { y: 0, scale: 1, opacity: 1, duration: 0.35, ease: 'back.out(1.4)' }
            );
            const fill = toastEl.querySelector('.toast-progress-fill');
            if (fill) {
                gsap.fromTo(fill,
                    { scaleX: 1 },
                    { scaleX: 0, duration: 4.8, ease: 'none' }
                );
            }
        },
        animateToastOut(toastEl, onComplete) {
            if (!toastEl) {
                if (onComplete) onComplete();
                return;
            }
            const gsap = window.gsap;
            if (!gsap) {
                toastEl.remove();
                if (onComplete) onComplete();
                return;
            }
            gsap.to(toastEl, {
                x: 40,
                opacity: 0,
                scale: 0.92,
                duration: 0.25,
                ease: 'power2.in',
                onComplete: () => {
                    toastEl.remove();
                    if (onComplete) onComplete();
                }
            });
        },
        setAudioWaveState(isPlaying) {
            const bars = document.querySelectorAll('.audio-wave-bars');
            bars.forEach(el => {
                if (isPlaying) {
                    el.classList.add('is-playing');
                } else {
                    el.classList.remove('is-playing');
                }
            });
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startMotionLayer, { once: true });
    } else {
        startMotionLayer();
    }
})();
