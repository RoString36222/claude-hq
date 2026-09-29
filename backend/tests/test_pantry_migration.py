"""The pantry migration, run the way a deploy runs it: alembic in a subprocess
against a throwaway SQLite file. It can't run in-process, because env.py forces
the cached settings URL (the pytest database) and calls asyncio.run."""
import os
import sqlite3
import subprocess
import sys
from contextlib import closing
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
PANTRY_TABLES = {"poke_balances", "poke_ledger"}


def run(db: Path, *args: str) -> str:
    env = {**os.environ, "ARENA_DATABASE_URL": f"sqlite+aiosqlite:///{db}"}
    done = subprocess.run(args, cwd=BACKEND, env=env, capture_output=True, text=True,
                          timeout=120)
    assert done.returncode == 0, done.stderr
    return done.stdout


def alembic(db: Path, *args: str) -> str:
    return run(db, sys.executable, "-m", "alembic", *args)


def schema(db: Path, kind: str = "table") -> dict[str, str]:
    with closing(sqlite3.connect(db)) as con:
        return dict(con.execute("SELECT name, sql FROM sqlite_master WHERE type = ?", (kind,)))


def test_upgrade_head_creates_the_pantry(tmp_path):
    db = tmp_path / "m.db"
    alembic(db, "upgrade", "head")
    tables = schema(db)
    assert PANTRY_TABLES <= set(tables)
    assert "uq_poke_ledger_user_request" in tables["poke_ledger"]
    assert "CHECK (op IN ('claim','buy','eat','give'))" in tables["poke_ledger"]
    assert "ON DELETE SET NULL" in tables["poke_ledger"]
    assert "uq_poke_balances_user_item" in tables["poke_balances"]
    assert "CHECK (qty >= 0)" in tables["poke_balances"]
    assert {"ix_poke_ledger_user_date", "ix_poke_ledger_to_date",
            "ix_poke_ledger_to_undelivered"} <= set(schema(db, "index"))


def test_downgrade_drops_only_the_pantry(tmp_path):
    db = tmp_path / "m.db"
    alembic(db, "upgrade", "head")
    alembic(db, "downgrade", "a1b2c3d4e5f6")
    tables = set(schema(db))
    assert not PANTRY_TABLES & tables
    assert {"users", "nudges"} <= tables
    alembic(db, "upgrade", "head")
    assert PANTRY_TABLES <= set(schema(db))


def test_upgrade_over_tables_create_all_already_built(tmp_path):
    """The launchd self-host runs main.lifespan's create_all before alembic, so
    the tables can exist before their migration does."""
    db = tmp_path / "m.db"
    alembic(db, "upgrade", "a1b2c3d4e5f6")
    run(db, sys.executable, "-c",
        "import sqlalchemy as sa; from app import models; from app.db import Base; "
        f"Base.metadata.create_all(sa.create_engine('sqlite:///{db}'))")
    assert PANTRY_TABLES <= set(schema(db))
    alembic(db, "upgrade", "head")
    assert "6f838c2049e2" in alembic(db, "current")


def test_single_head(tmp_path):
    heads = [line for line in alembic(tmp_path / "m.db", "heads").splitlines() if line.strip()]
    assert len(heads) == 1, heads
    assert heads[0].startswith("6f838c2049e2")
