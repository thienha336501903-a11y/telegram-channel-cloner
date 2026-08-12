# Local history reader

This tool is intentionally **not** deployed to Vercel. It is run only when an existing MASTER channel needs historical indexing.

It uses a dedicated Telegram user account via MTProto, reads the channel from oldest to newest, and sends normalized text/caption/entity metadata to the Cloner API. Media bytes are never downloaded; the production bot later uses Telegram's `copyMessage`/`copyMessages` server-side.

The `.session` file remains on the operator's computer and is ignored by Git.

Setup and login are postponed until the API/dashboard is deployed and a test channel is ready.
