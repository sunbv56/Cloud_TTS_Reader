import { initUIInteractions } from './modules/ui-interactions.js';
import { initI18n } from './modules/i18n.js';
import { initConsolePlayer } from './modules/console-player.js';

function boot() {
    initUIInteractions();
    initConsolePlayer();
    initI18n();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}
