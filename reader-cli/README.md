# Local history reader

This tool is intentionally **not** deployed to Vercel. Use it when a registered Telegram source needs its existing channel history indexed for V4. Live posts/edits continue to arrive through the webhook separately.

The reader signs in with a dedicated Telegram **user** account via MTProto, reads the selected channel from oldest to newest, and sends normalized message metadata/text to the Cloner API. Media bytes are never downloaded. The local `.session` file stays on the operator's computer and is ignored by Git.

Historical indexing is source-scoped: registering/importing a V4 source **must not change the clone/mirror MASTER**. If the selected source is already MASTER, that role is preserved; otherwise it remains a non-MASTER V4 source.

## Windows: one-command helper

From the repository root, run:

```powershell
.\reader-cli\import-history.cmd "@your_channel"
```

You may also omit the channel and paste it when prompted. The helper accepts `@username`, public `t.me` links, private `t.me/c/...` links, and Bot API `-100...` chat IDs. For private inputs, the dedicated Telegram reader account must already be a member of that channel.

On the first run, the helper reuses `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, and `READER_INGEST_SECRET` from the current environment when available; otherwise it prompts locally. It stores the reusable secret values in `reader-cli/.reader-windows-secrets.json` encrypted with Windows DPAPI for the current Windows user. That file and Telegram session files are ignored by Git.

The helper also installs `reader-cli/requirements.txt` only when the Python dependencies are missing. When the local repository is clean and currently on `main`, it performs a safe `git pull --ff-only`; otherwise it skips the update rather than touching local work.

To replace the encrypted local credentials later:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\reader-cli\import_history_windows.ps1 -ResetSecrets
```

## Manual / macOS / Linux run

```bash
cd reader-cli
python -m venv .venv
# Windows: .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt

# Set these locally; never commit their values.
# TELEGRAM_API_ID
# TELEGRAM_API_HASH
# READER_INGEST_SECRET

python export_history.py \
  --channel @your_channel \
  --cloner-url https://telegram-channel-cloner.vercel.app
```

The first run may ask for the Telegram phone/login code for the dedicated reader account. Later runs reuse the local session. The import is idempotent at `(source_id, source_message_id)`, so rerunning the same source updates existing indexed rows rather than intentionally creating duplicate messages.
