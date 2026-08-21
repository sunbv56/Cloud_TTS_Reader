/**
 * Cloud TTS Reader - Frontend Master Orchestrator
 */
import { initUIInteractions } from './modules/ui-interactions.js';
import { initI18n } from './modules/i18n.js';

// Initialize DOM helpers, theme controls, and i18n
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        initUIInteractions();
        initI18n();
    });
} else {
    initUIInteractions();
    initI18n();
}
