# Cloud TTS Reader - Frontend Refactoring Plan

This document outlines the plan to refactor the monolithic `index.html` and `app.js` into a modular, dev-friendly structure without changing any logic.

## 1. Safety Measures (Backups)
Before any modifications, the following backups will be created:
- `static/index_v1_backup.html`
- `static/app_v1_backup.js`

## 2. Directory Structure
```
static/
├── css/
│   ├── themes.css         (Standard CSS: Color themes)
│   ├── ui-extras.css      (Standard CSS: Lite mode, Player logic, Transitions)
│   └── main.css           (Imports the above)
├── js/
│   ├── modules/
│   │   ├── config.js      (Firebase config & Constants)
│   │   ├── state.js       (Global STATE)
│   │   ├── firebase.js    (Firebase Init & Auth)
│   │   ├── audio.js       (Audio Engine, MSE, WebSocket)
│   │   ├── ui.js          (DOM Interactions & Inline Scripts)
│   │   ├── utils.js       (Helper functions)
│   │   └── managers/
│   │       ├── offline.js (IndexedDB/Cache)
│   │       ├── stats.js   (Reading statistics)
│   │       └── dictionary.js (Dictionary rules)
│   └── app.js             (New modular entry point)
└── index.html             (Original file cleaned up)
```

## 3. CSS Separation Strategy
Only **Standard CSS** will be moved to external files. 
- **Keep in `index.html`**: Any code using Tailwind CSS features like `@theme`, `@layer`, or `@apply`.
- **Move to `themes.css`**: Color theme variables and `[data-theme]` overrides.
- **Move to `ui-extras.css`**: Lite mode logic, player minimize styles, and transitions.

## 4. JS Modularization (No Logic Change)
All code will be split via copy-paste. To maintain logic:
- Global variables (like `STATE`, `auth`, `db`) will be exported from their respective modules.
- Functions will be exported as-is.
- The new `static/js/app.js` will orchestrate the imports and initialization in the exact order of the original file.

## 5. Detailed Execution Checklist

### Phase 1: Environment Preparation
- [ ] **Task 1.1**: Verify presence of backups (`index_v1_backup.html`, `app_v1_backup.js`).
- [ ] **Task 1.2**: Create directory structure (`static/css/`, `static/js/modules/managers/`).

### Phase 2: CSS Modularization
- [ ] **Task 2.1**: Create `static/css/themes.css` and paste Theme System code.
- [ ] **Verification**: Compare `themes.css` with lines 114-520 of `index_v1_backup.html`.
- [ ] **Task 2.2**: Create `static/css/ui-extras.css` and paste Player, Lite Mode, and Transitions code.
- [ ] **Verification**: Compare `ui-extras.css` with lines 522-654 of `index_v1_backup.html`.
- [ ] **Task 2.3**: Create `static/css/main.css` to import all modules.

### Phase 3: JS Modularization (Copy-Paste from Backup)
- [ ] **Task 3.1**: Create `static/js/modules/state.js` (Export `STATE` object).
- [ ] **Verification**: Compare with lines 10-90 of `app_v1_backup.js`.
- [ ] **Task 3.2**: Create `static/js/modules/managers/offline.js` (Export `OFFLINE_MANAGER`).
- [ ] **Verification**: Compare with lines 92-177 of `app_v1_backup.js`.
- [ ] **Task 3.3**: Create `static/js/modules/managers/stats.js` (Export `STATS_MANAGER`).
- [ ] **Verification**: Compare with lines 179-266 of `app_v1_backup.js`.
- [ ] **Task 3.4**: Create `static/js/modules/firebase.js` (Export Firebase init & Auth logic).
- [ ] **Verification**: Compare with lines 1-5 and 268-313 of `app_v1_backup.js`.
- [ ] **Task 3.5**: Create `static/js/modules/managers/dictionary.js` (Export dictionary functions).
- [ ] **Verification**: Compare with lines 371-476 of `app_v1_backup.js`.
- [ ] **Task 3.6**: Create `static/js/modules/audio-engine.js` (Export audio & websocket logic).
- [ ] **Verification**: Compare with lines 527-611 and 665-800+ of `app_v1_backup.js`.
- [ ] **Task 3.7**: Create `static/js/modules/ui.js` (Export UI interactions and inline scripts).
- [ ] **Verification**: Compare with remaining utility functions in `app_v1_backup.js` and inline scripts in `index_v1_backup.html`.
- [ ] **Task 3.8**: Create `static/js/modules/utils.js` (Export helper functions).
- [ ] **Verification**: Compare with utility lines in `app_v1_backup.js`.

### Phase 4: Final Integration
- [ ] **Task 4.1**: Create the new modular entry point `static/js/app.js`.
- [ ] **Task 4.2**: Update `static/index.html` to link to new files and remove monolithic code.
- [ ] **Verification**: Test the application for full functionality (Playback, Auth, Library).

## 6. UI/UX Pro Max Theme System Specification
The theme system adheres to UI/UX Pro Max principles with dark-mode-first curated palettes, multi-layered glassmorphism, glowing micro-interactions, and real-time cross-window synchronization.

### Standard Theme Tokens:
| Variable | Description | Example (Cyber Obsidian) |
|---|---|---|
| `--theme-primary` | Main accent & glowing action color | `#00E5FF` |
| `--theme-primary-dim` | Secondary / darker accent tone | `#0099b8` |
| `--theme-bg` | Deep canvas background | `#080d1a` |
| `--theme-surface` | Card / panel container surface | `#0e172a` |
| `--theme-surface-high` | Elevated / active layer surface | `#18243e` |
| `--theme-glass` | Multi-layered translucent backdrop | `rgba(14, 23, 42, 0.68)` |
| `--theme-glass-border` | Delicate glass border highlight | `rgba(0, 229, 255, 0.16)` |
| `--theme-text` | Primary high-contrast text | `#dae2fd` |
| `--theme-text-reading` | Optimized body reading text | `#bac9cc` |
| `--theme-text-muted` | Secondary/subtle metadata text | `#64748b` |
| `--theme-glow` | Accent outer glow shadow | `rgba(0, 229, 255, 0.28)` |
| `--theme-is-light` | Mode flag (`0`: dark, `1`: daylight) | `0` |

### Curated Pro Max Palettes:
1. `default`: **Cyber Obsidian** (Max Focus & Cyber Aesthetics)
2. `warm-night`: **Warm Amber Night** (Blue-Light Filter & Bedtime Reading)
3. `forest`: **Emerald Zen** (Visual Relaxation & Immersion)
4. `rose`: **Sunset Velvet** (Poetic Fiction & Atmosphere)
5. `ocean`: **Nordic Ocean** (Mental Clarity & Serenity)
6. `mocha`: **Royal Mocha** (Cozy Classic & Warmth)
7. `sepia`: **Vintage Sepia** (Nostalgic Parchment, Light)
8. `paper`: **Paper Minimalist** (Crisp Daylight Print, Light)

