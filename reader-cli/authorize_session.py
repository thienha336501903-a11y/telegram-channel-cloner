#!/usr/bin/env python3
"""Interactive one-time authorization for the local Telegram reader session.

This runs only on the owner's computer. Telethon may prompt for phone, OTP and 2FA
on first setup. The resulting .session file remains local and is never uploaded.
"""
import argparse
import asyncio
import os

from telethon import TelegramClient


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-id", type=int, default=os.getenv("TELEGRAM_API_ID"))
    parser.add_argument("--api-hash", default=os.getenv("TELEGRAM_API_HASH"))
    parser.add_argument("--session", default="telegram-cloner-reader")
    args = parser.parse_args()
    if not args.api_id or not args.api_hash:
        parser.error("TELEGRAM_API_ID and TELEGRAM_API_HASH are required")

    print("Checking local Telegram reader session...")
    async with TelegramClient(args.session, args.api_id, args.api_hash) as client:
        me = await client.get_me()
        if not me:
            raise RuntimeError("Telegram reader authorization did not return an account")
        print(f"Telegram reader session ready for account id {int(me.id)}.")
        print("The session file remains on this PC.")


if __name__ == "__main__":
    asyncio.run(main())
