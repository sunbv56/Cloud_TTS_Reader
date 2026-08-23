import re
import os
import glob
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

def audit_dom_and_apis():
    html_path = BASE_DIR / "static" / "index.html"
    with open(html_path, "r", encoding="utf-8") as f:
        html_content = f.read()

    # Find all IDs defined in HTML
    # Note: Matches id="something" or id='something'
    html_ids = set(re.findall(r'\bid=["\']([^"\']+)["\']', html_content))
    print(f"[*] Found {len(html_ids)} unique IDs in index.html")

    js_files = glob.glob(str(BASE_DIR / "static" / "**" / "*.js"), recursive=True)
    
    # Filter out backup files
    js_files = [f for f in js_files if "_backup" not in f and "sw.js" not in f]

    print(f"[*] Analyzing {len(js_files)} active JavaScript files...")

    # Pattern for getElementById('...')
    id_pattern = re.compile(r'document\.getElementById\(["\']([a-zA-Z0-9_-]+)["\']\)')
    # Pattern for querySelector('#...')
    qs_pattern = re.compile(r'querySelector(?:All)?\(["\']#([a-zA-Z0-9_-]+)')

    # Pattern for fetch/authFetch endpoints
    api_pattern = re.compile(r'(?:fetch|fetchWithTimeout|authFetch)\(["\'](/api/[^"\'?]+|/stream/[^"\'?]+)')
    template_api_pattern = re.compile(r'(?:fetch|fetchWithTimeout|authFetch)\(`(/api/[^`?]+|/stream/[^`?]+)')

    all_missing_ids = {}
    all_apis_called = set()

    # Dynamic elements created via JS or template literals that are safe to ignore
    dynamic_prefixes = ("book-", "chapter-", "edit-btn-", "del-btn-", "history-", "stat-", "img-", "toast-", "seg-", "voice-card-", "preview-audio-")

    for js_file in js_files:
        rel_path = os.path.relpath(js_file, BASE_DIR)
        with open(js_file, "r", encoding="utf-8") as f:
            content = f.read()

        by_id = set(id_pattern.findall(content))
        by_qs = set(qs_pattern.findall(content))
        referenced_ids = by_id | by_qs

        missing = []
        for elem_id in referenced_ids:
            if elem_id not in html_ids and not any(elem_id.startswith(p) for p in dynamic_prefixes):
                missing.append(elem_id)

        if missing:
            all_missing_ids[rel_path] = sorted(missing)

        # APIs
        apis1 = api_pattern.findall(content)
        apis2 = template_api_pattern.findall(content)
        for api in apis1 + apis2:
            all_apis_called.add(api)

    print("\n=================== DOM ID AUDIT RESULTS ===================")
    if all_missing_ids:
        for f, ids in all_missing_ids.items():
            print(f"\n[!] Missing or dynamically injected IDs in {f} ({len(ids)}):")
            for elem_id in ids:
                print(f"    - {elem_id}")
    else:
        print("[+] All static DOM IDs referenced in JS exist in index.html!")

    print("\n=================== API ENDPOINTS AUDIT ===================")
    print(f"[*] Frontend calls {len(all_apis_called)} distinct API routes:")
    for api in sorted(all_apis_called):
        print(f"    - {api}")

if __name__ == "__main__":
    audit_dom_and_apis()
