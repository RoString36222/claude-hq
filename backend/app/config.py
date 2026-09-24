"""Runtime settings, read from the environment."""
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# Anchored to the package, not the working directory: launchd starts the
# service from elsewhere, and a relative env_file would silently load nothing
# and fall back to defaults (an empty SQLite file, no OAuth) rather than fail.
_ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="ARENA_", env_file=_ENV_FILE, extra="ignore"
    )

    # Postgres in production; SQLite keeps tests and local runs dependency-free.
    database_url: str = "sqlite+aiosqlite:///./arena.db"

    # Signs pairing codes and websocket tickets. Must be set in production.
    secret_key: str = "dev-only-insecure-change-me"

    github_client_id: str = ""
    github_client_secret: str = ""
    # Where GitHub sends the user back. Must match the OAuth app exactly.
    public_base_url: str = "http://127.0.0.1:8080"

    # Ingest sanity clamps. A day exceeding these is rejected as a client bug or
    # a prank, rather than being allowed to permanently distort the board.
    max_daily_prompts: int = 5_000
    max_daily_tools: int = 50_000
    max_backfill_days: int = 400

    ws_ticket_ttl_secs: int = 60
    pair_code_ttl_secs: int = 900

    @property
    def is_sqlite(self) -> bool:
        return self.database_url.startswith("sqlite")


@lru_cache
def get_settings() -> Settings:
    return Settings()
