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
            'toc-overlay',
            'upload-options-modal',
            'upload-files-modal',
            'image-manager-modal',
            'stats-modal',
            'edit-chapter-modal',
            'global-loading'
        ].map(id => document.getElementById(id)).filter(Boolean);
        const visibility = new WeakMap();
        const animatedChildren = new WeakSet();

        gsap.defaults({ overwrite: 'auto' });

        function isVisible(element) {
            if (!element) return false;
            return !element.classList.contains('hidden')
                && !element.classList.contains('translate-x-full');
        }

        function panelFor(element) {
            if (element.id === 'discovery-mode' || element.id === 'reader-container') {
                return element;
            }
            // TOC owns its own translate-x-full transition in app CSS. Animate
            // its children so GSAP never overwrites that transform.
            if (element.id === 'toc-overlay') {
                return Array.from(element.children);
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
        }

        const listObserver = new MutationObserver(records => {
            records.forEach(record => {
                if (record.type !== 'childList' || !record.addedNodes.length) return;
                if (record.target.id === 'discovery-grid') {
                    animateAddedItems(record.target, '[data-title], .book-card');
                } else if (record.target.id === 'book-list' || record.target.id === 'toc-list') {
                    animateAddedItems(record.target);
                }
            });
        });

        ['discovery-grid', 'book-list', 'toc-list'].forEach(id => {
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
