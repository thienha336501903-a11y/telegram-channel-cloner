from pathlib import Path

path = Path(__file__).with_name("reader_manager_agent.py")
text = path.read_text(encoding="utf-8")
old = '''def api(config, action, payload=None, timeout=45):
    response = requests.post(
        config.get("cloner_url", DEFAULT_CLONER_URL).rstrip("/") + f"{CONTROL_PATH}?action={action}",
'''
new = '''def api(config, action, payload=None, timeout=45):
    url = config.get("cloner_url", DEFAULT_CLONER_URL).rstrip("/") + f"{CONTROL_PATH}?action={action}"
    share_token = str(config.get("vercel_share_token") or "").strip()
    if share_token:
        url += "&_vercel_share=" + requests.utils.quote(share_token, safe="")
    response = requests.post(
        url,
'''
if old not in text:
    raise SystemExit("preview_patch_target_not_found")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
print("Applied PR57 Preview share-token patch to Reader Manager build source.")
