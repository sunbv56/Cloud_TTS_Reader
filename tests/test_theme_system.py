import os
import re
from pathlib import Path
import pytest

BASE_DIR = Path(__file__).resolve().parent.parent

EXPECTED_THEMES = [
    'default',
    'warm-night',
    'forest',
    'rose',
    'ocean',
    'mocha',
    'sepia',
    'paper',
    'e-ink'
]

def test_themes_metadata_in_app_js():
    app_js_path = BASE_DIR / "static" / "app.js"
    content = app_js_path.read_text(encoding="utf-8")
    
    # Extract THEMES_METADATA block
    match = re.search(r'const THEMES_METADATA = \{([\s\S]+?)\};', content)
    assert match is not None, "THEMES_METADATA not found in app.js"
    metadata_block = match.group(1)
    
    for theme_id in EXPECTED_THEMES:
        assert f"'{theme_id}':" in metadata_block, f"Theme '{theme_id}' missing from THEMES_METADATA in app.js"

def test_themes_data_in_ui_interactions_js():
    ui_js_path = BASE_DIR / "static" / "js" / "modules" / "ui-interactions.js"
    content = ui_js_path.read_text(encoding="utf-8")
    
    # Extract THEMES_DATA block
    match = re.search(r'export const THEMES_DATA = \{([\s\S]+?)\};', content)
    assert match is not None, "THEMES_DATA not found in ui-interactions.js"
    data_block = match.group(1)
    
    for theme_id in EXPECTED_THEMES:
        assert f"'{theme_id}':" in data_block, f"Theme '{theme_id}' missing from THEMES_DATA in ui-interactions.js"

def test_themes_in_index_html():
    html_path = BASE_DIR / "static" / "index.html"
    content = html_path.read_text(encoding="utf-8")
    
    # Check that each theme button exists in the DOM
    for theme_id in EXPECTED_THEMES:
        assert f'data-theme="{theme_id}"' in content, f"Theme button for '{theme_id}' missing in index.html"
        
    # Check that Early Theme Loader (anti-FOUC) is present in <head>
    assert "reader-theme" in content, "reader-theme not found in index.html"
    assert "document.documentElement.setAttribute('data-theme', savedTheme)" in content, "Anti-FOUC theme loader missing in index.html"

def test_themes_in_css():
    css_path = BASE_DIR / "static" / "css" / "themes.css"
    content = css_path.read_text(encoding="utf-8")
    
    for theme_id in EXPECTED_THEMES:
        assert f'[data-theme="{theme_id}"]' in content, f"CSS rules for data-theme='{theme_id}' missing in themes.css"

def test_themes_i18n_keys():
    i18n_path = BASE_DIR / "static" / "js" / "modules" / "i18n.js"
    content = i18n_path.read_text(encoding="utf-8")
    
    for theme_id in EXPECTED_THEMES:
        name_key = f"theme-{theme_id}-name"
        mood_key = f"theme-{theme_id}-mood"
        assert name_key in content, f"Translation key '{name_key}' missing in i18n.js"
        assert mood_key in content, f"Translation key '{mood_key}' missing in i18n.js"
