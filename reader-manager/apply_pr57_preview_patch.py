from pathlib import Path

path = Path(__file__).with_name("reader_manager_agent.py")
text = path.read_text(encoding="utf-8")
old = '''def api(config, action, payload=None, timeout=45):
    response = requests.post(
        config.get("cloner_url", DEFAULT_CLONER_URL).rstrip("/") + f"{CONTROL_PATH}?action={action}",
        headers={"Authorization": f"Bearer {config['agent_token']}", "Content-Type": "application/json"},
        data=json.dumps(payload or {}, ensure_ascii=False).encode("utf-8"),
        timeout=timeout,
    )
'''
new = '''def api(config, action, payload=None, timeout=45):
    url = config.get("cloner_url", DEFAULT_CLONER_URL).rstrip("/") + f"{CONTROL_PATH}?action={action}"
    headers = {"Authorization": f"Bearer {config['agent_token']}", "Content-Type": "application/json"}
    bypass_secret = str(config.get("vercel_automation_bypass_secret") or "").strip()
    if bypass_secret:
        headers["x-vercel-protection-bypass"] = bypass_secret
        headers["x-vercel-set-bypass-cookie"] = "true"
    response = requests.post(
        url,
        headers=headers,
        data=json.dumps(payload or {}, ensure_ascii=False).encode("utf-8"),
        timeout=timeout,
    )
'''
if old not in text:
    raise SystemExit("preview_patch_target_not_found")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
print("Applied PR57 Preview automation-bypass patch to Reader Manager build source.")
