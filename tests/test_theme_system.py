import re
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

EXPECTED_THEMES = ['slate', 'slate-deep', 'mist', 'sepia']
LEGACY_THEMES = {
    'default': 'slate',
    'forest': 'slate',
    'rose': 'slate',
    'mocha': 'slate',
    'warm-night': 'slate-deep',
    'ocean': 'slate-deep',
    'e-ink': 'slate-deep',
    'paper': 'mist',
}


def _read(*parts):
    return (BASE_DIR.joinpath(*parts)).read_text(encoding="utf-8")


def _block(content, pattern):
    match = re.search(pattern, content)
    assert match is not None, f"{pattern} not found"
    return match.group(1)


def test_themes_data_in_ui_interactions_js():
    data_block = _block(_read("static", "js", "modules", "ui-interactions.js"), r'export const THEMES_DATA = \{([\s\S]+?)\n\};')
    for theme_id in EXPECTED_THEMES:
        assert f"'{theme_id}':" in data_block, f"Theme '{theme_id}' missing from THEMES_DATA"
    assert len(re.findall(r"metaColor: '#[0-9A-Fa-f]{6}'", data_block)) == len(EXPECTED_THEMES)


def test_legacy_theme_ids_map_to_console_themes():
    content = _read("static", "js", "modules", "ui-interactions.js")
    legacy_block = _block(content, r'export const LEGACY_THEME_MAP = \{([\s\S]+?)\};')
    for old_id, new_id in LEGACY_THEMES.items():
        assert f"'{old_id}': '{new_id}'" in legacy_block, f"Legacy theme '{old_id}' should map to '{new_id}'"

    # The pre-paint loader in <head> must apply the same mapping before first paint.
    html = _read("static", "index.html")
    head = html.split("</head>")[0]
    for old_id, new_id in LEGACY_THEMES.items():
        assert f"'{old_id}': '{new_id}'" in head, f"Head loader misses legacy theme '{old_id}'"


def test_app_js_uses_shared_theme_module():
    content = _read("static", "app.js")
    assert "THEMES_METADATA" not in content, "app.js should not keep its own theme table"
    assert "normalizeThemeId" in content


def test_themes_in_index_html():
    content = _read("static", "index.html")
    for theme_id in EXPECTED_THEMES:
        assert f'class="theme-card' in content and f'data-theme="{theme_id}"' in content, f"Theme card for '{theme_id}' missing"
    assert "reader-theme" in content, "reader-theme not found in index.html"
    assert "document.documentElement.setAttribute('data-theme', savedTheme)" in content, "Anti-FOUC theme loader missing"


def test_themes_in_console_css():
    content = _read("static", "css", "console.css")
    for theme_id in EXPECTED_THEMES:
        assert f'[data-theme="{theme_id}"]' in content, f"Tokens for data-theme='{theme_id}' missing in console.css"
    # Old screens and mini-player.css still read the legacy --theme-* names.
    for alias in ("--theme-primary", "--theme-bg", "--theme-surface", "--theme-text", "--theme-text-reading"):
        assert f"{alias}:" in content


def test_themes_i18n_keys():
    content = _read("static", "js", "modules", "i18n.js")
    for theme_id in EXPECTED_THEMES:
        assert content.count(f'"theme-{theme_id}-name"') == 2, f"theme-{theme_id}-name needs vi + en"
        assert content.count(f'"theme-{theme_id}-mood"') == 2, f"theme-{theme_id}-mood needs vi + en"
