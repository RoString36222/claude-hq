"""The cali menu-items migration (taco_diners.items), run the way a deploy runs
it: alembic in a subprocess against a throwaway SQLite file."""
import sqlite3
import sys
from contextlib import closing

from tests.test_pantry_migration import alembic, run, schema

BEFORE = "c7d8e9f0a1b2"
HEAD = "2c3d4e5f6a7b"


def columns(db) -> dict[str, tuple]:
    with closing(sqlite3.connect(db)) as con:
        # cid, name, type, notnull, dflt_value, pk
        return {r[1]: r for r in con.execute("PRAGMA table_info(taco_diners)")}


def insert_old_style_diner(db) -> str:
    """A row written the way code one revision behind writes it: no `items`."""
    with closing(sqlite3.connect(db)) as con:
        con.execute("INSERT INTO users (id, github_id, handle, display_name, avatar_url, "
                    "trainer_name, is_active) VALUES ('u1', 1, 'ana', 'Ana', '', '', 1)")
        con.execute("INSERT INTO taco_orders (id, user_id, request_id, order_date, created_at) "
                    "VALUES ('o1', 'u1', 'rid-0000000000000001', '2026-09-29', "
                    "'2026-09-29 19:30:00')")
        con.execute("INSERT INTO taco_diners (id, order_id, diner_name, mild_hard) "
                    "VALUES ('d1', 'o1', 'Ana', 2)")
        con.commit()
        return con.execute("SELECT items FROM taco_diners WHERE id = 'd1'").fetchone()[0]


def test_upgrade_adds_items_with_an_empty_default(tmp_path):
    db = tmp_path / "m.db"
    alembic(db, "upgrade", "head")
    col = columns(db)["items"]
    assert col[3] == 1                    # NOT NULL
    assert col[4] == "'{}'"               # server default
    assert insert_old_style_diner(db) == "{}"
    assert HEAD in alembic(db, "current")


def test_downgrade_drops_only_the_column(tmp_path):
    db = tmp_path / "m.db"
    alembic(db, "upgrade", "head")
    alembic(db, "downgrade", BEFORE)
    assert "items" not in columns(db)
    tables = schema(db)
    # A plain DROP COLUMN: the table and its constraints are untouched.
    assert "ck_taco_diners_identity" in tables["taco_diners"]
    assert "ck_taco_diners_counts_nonneg" in tables["taco_diners"]
    assert "ON DELETE SET NULL" in tables["taco_diners"]
    alembic(db, "upgrade", "head")
    assert "items" in columns(db)


def test_upgrade_over_an_old_table_create_all_left_alone(tmp_path):
    """create_all never alters an existing table, so a database already at the
    taco revision still gets the column from the migration."""
    db = tmp_path / "m.db"
    alembic(db, "upgrade", BEFORE)
    run(db, sys.executable, "-c",
        "import sqlalchemy as sa; from app import models; from app.db import Base; "
        f"Base.metadata.create_all(sa.create_engine('sqlite:///{db}'))")
    assert "items" not in columns(db)
    alembic(db, "upgrade", "head")
    assert "items" in columns(db)
    assert HEAD in alembic(db, "current")
