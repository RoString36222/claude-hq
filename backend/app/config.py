"""Runtime settings, read from the environment."""
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# Anchored to the package, not the working directory: launchd starts the
# service from elsewhere, and a relative env_file would silently load nothing
# and fall back to defaults (an empty SQLite file, no OAuth) rather than fail.
_ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


DEFAULT_SECRET_KEY = "dev-only-insecure-change-me"
MIN_SECRET_KEY_LEN = 32


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="ARENA_", env_file=_ENV_FILE, extra="ignore"
    )

    # Postgres in production; SQLite keeps tests and local runs dependency-free.
    database_url: str = "sqlite+aiosqlite:///./arena.db"

    # Signs pairing codes and websocket tickets. Must be set in production:
    # the server refuses to start with this default or anything shorter than
    # MIN_SECRET_KEY_LEN characters unless ARENA_DEV=1 (see check_secret_key).
    secret_key: str = DEFAULT_SECRET_KEY
    # Local development and tests only: allows the default/short secret key.
    dev: bool = False

    github_client_id: str = ""
    github_client_secret: str = ""
    # Where GitHub sends the user back. Must match the OAuth app exactly.
    public_base_url: str = "http://127.0.0.1:8080"

    # Ingest sanity clamps. A day exceeding these is rejected as a client bug or
    # a prank, rather than being allowed to permanently distort the board.
    max_daily_prompts: int = 5_000
    max_daily_tools: int = 50_000
    max_backfill_days: int = 400
    # Same idea for the other per-day counters. Generous: a real heavy day sits
    # orders of magnitude below these, a corrupt or forged payload does not.
    max_daily_artifacts: int = 5_000
    max_daily_replies: int = 50_000
    # Per token bucket (input, output, cacheRead, cacheCreation) per day.
    max_daily_tokens: int = 10_000_000_000

    # A device token unused for this many days is revoked on its next use.
    device_idle_days: int = 90

    # Directory of soundboard clips served by GET /v1/sounds. The files live on
    # the host (git-ignored) and should sit on a mounted volume so a redeploy
    # does not wipe them -- set ARENA_SOUNDS_DIR=/data/sounds in production.
    sounds_dir: str = "./sounds"
    # Largest clip POST /v1/sounds will accept, in bytes (default 5 MB). Keeps a
    # stray large file from filling the sounds volume.
    max_sound_bytes: int = 5 * 1024 * 1024

    ws_ticket_ttl_secs: int = 60
    pair_code_ttl_secs: int = 900

    @property
    def is_sqlite(self) -> bool:
        return self.database_url.startswith("sqlite")


def check_secret_key(settings: "Settings") -> None:
    """Refuse to serve with a guessable signing key. Anyone who knows the key
    can mint websocket tickets for any user, so this is a startup failure, not
    a warning. ARENA_DEV=1 opts out for local runs and tests."""
    if settings.dev:
        return
    key = settings.secret_key
    if key == DEFAULT_SECRET_KEY or len(key) < MIN_SECRET_KEY_LEN:
        raise RuntimeError(
            "ARENA_SECRET_KEY is unset, the default, or shorter than "
            f"{MIN_SECRET_KEY_LEN} characters. Generate one with: "
            'python3 -c "import secrets; print(secrets.token_urlsafe(48))" '
            "(or set ARENA_DEV=1 for local development only)."
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()
