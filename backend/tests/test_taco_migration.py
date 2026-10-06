"""The taco-Tuesdays migration, run the way a deploy runs it: alembic in a
subprocess against a throwaway SQLite file. It can't run in-process, because
env.py forces the cached settings URL (the pytest database) and calls
asyncio.run."""
import sys

from tests.test_pantry_migration import alembic, run, schema

TACO_TABLES = {"taco_orders", "taco_diners"}
BEFORE = "b3c4d5e6f7a8"


def test_upgrade_head_creates_the_taco_tables(tmp_path):
    db = tmp_path / "m.db"
    alembic(db, "upgrade", "head")
    tables = schema(db)
    assert TACO_TABLES <= set(tables)
    assert "UNIQUE (user_id, request_id)" in tables["taco_orders"]
    assert "CHECK (paid_tacos <= total_tacos)" in tables["taco_orders"]
    # A diner keeps an identity after their account goes away.
    assert "ON DELETE SET NULL" in tables["taco_diners"]
    assert "ck_taco_diners_identity" in tables["taco_diners"]
    assert {"ix_taco_orders_date", "ix_taco_diners_order_id",
            "ix_taco_diners_user"} <= set(schema(db, "index"))


def test_downgrade_drops_only_the_taco_tables(tmp_path):
    db = tmp_path / "m.db"
    alembic(db, "upgrade", "head")
    alembic(db, "downgrade", BEFORE)
    tables = set(schema(db))
    assert not TACO_TABLES & tables
    assert {"users", "poke_ledger", "nudges"} <= tables
    alembic(db, "upgrade", "head")
    assert TACO_TABLES <= set(schema(db))


def test_upgrade_over_tables_create_all_already_built(tmp_path):
    """The launchd self-host runs main.lifespan's create_all before alembic, so
    the tables can exist before their migration does."""
    db = tmp_path / "m.db"
    alembic(db, "upgrade", BEFORE)
    run(db, sys.executable, "-c",
        "import sqlalchemy as sa; from app import models; from app.db import Base; "
        f"Base.metadata.create_all(sa.create_engine('sqlite:///{db}'))")
    assert TACO_TABLES <= set(schema(db))
    alembic(db, "upgrade", "head")
    assert "d8e9f0a1b2c3" in alembic(db, "current")
