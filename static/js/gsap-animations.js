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
            'global-loading'
        ].map(id => document.getElementById(id)).filter(Boolean);
        const visibility = new WeakMap();
        const animatedChildren = new WeakSet();
        const spotlightCards = new WeakSet();
        let spotlightEnabled = false;

        gsap.defaults({ overwrite: 'auto' });

        const motionMedia = gsap.matchMedia();
        motionMedia.add({
            desktopPointer: '(hover: hover) and (pointer: fine)',
            reduceMotion: '(prefers-reduced-motion: reduce)'
        }, context => {
            spotlightEnabled = context.conditions.desktopPointer && !context.conditions.reduceMotion;
            return () => { spotlightEnabled = false; };
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
                    { autoAlpha: 0 },
                    { autoAlpha: 1, duration: 0.2, ease: 'power2.out' }
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
                { autoAlpha: 0, y: 10 },
                { autoAlpha: 1, y: 0, duration: 0.26, ease, stagger: 0.045 }
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
                    y: 0, scale: 1, clipPath: 'inset(0 0 22% 0)',
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

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startMotionLayer, { once: true });
    } else {
        startMotionLayer();
    }
})();
