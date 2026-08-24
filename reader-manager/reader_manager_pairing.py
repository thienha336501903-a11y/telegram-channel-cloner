"""Parse one-field Reader Manager pairing packages without network access."""
import re
from urllib.parse import urlparse


DEFAULT_CLONER_URL = "https://telegram-channel-cloner.vercel.app"
PAIRING_PACKAGE_PREFIX = "YNA1"
PRODUCTION_CLONER_HOST = "telegram-channel-cloner.vercel.app"
PREVIEW_CLONER_HOST = re.compile(
    r"^telegram-(?:chan-git|channel-cloner)-[a-z0-9-]+-thienha100022653824678-stacks-projects\.vercel\.app$"
)


def allowed_cloner_url(value):
    """Return a normalized trusted Cloner URL or raise before any network call."""
    parsed = urlparse(str(value or "").strip())
    hostname = str(parsed.hostname or "").lower()
    valid_host = hostname == PRODUCTION_CLONER_HOST or bool(PREVIEW_CLONER_HOST.fullmatch(hostname))
    try:
        port = parsed.port
    except ValueError as exc:
        raise RuntimeError("reader_server_not_trusted") from exc
    if (
        parsed.scheme != "https"
        or not valid_host
        or parsed.username
        or parsed.password
        or port not in (None, 443)
        or parsed.path not in ("", "/")
        or parsed.params
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError("reader_server_not_trusted")
    return f"https://{hostname}"


def parse_pairing_package(value):
    """Accept a legacy short code or YNA1|trusted-url|short-code package."""
    text = str(value or "").strip()
    if text.upper().startswith(f"{PAIRING_PACKAGE_PREFIX}|"):
        parts = text.split("|", 2)
        if len(parts) != 3 or not parts[2].strip():
            raise RuntimeError("pairing_package_invalid")
        return allowed_cloner_url(parts[1]), parts[2].strip()
    return DEFAULT_CLONER_URL, text
