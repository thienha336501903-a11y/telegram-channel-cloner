# Local history reader

This tool is intentionally **not** deployed to Vercel. Use it when a registered Telegram source needs its existing channel history indexed for V4. Live posts/edits continue to arrive through the webhook separately.

The reader signs in with a dedicated Telegram **user** account via MTProto, reads the selected channel from oldest to newest, and sends normalized message metadata/text to the Cloner API. Media bytes are never downloaded. The local `.session` file stays on the operator's computer and is ignored by Git.

Historical indexing is source-scoped: registering/importing a V4 source **must not change the clone/mirror MASTER**. If the selected source is already MASTER, that role is preserved; otherwise it remains a non-MASTER V4 source.

## Run

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
