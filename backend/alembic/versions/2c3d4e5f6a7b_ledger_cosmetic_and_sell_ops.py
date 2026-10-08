"""poke ledger: allow the 'cosmetic' and 'sell' ops (HQ 2.1 cosmetics + market)

Revision ID: 2c3d4e5f6a7b
Revises: 1b2c3d4e5f6a
Create Date: 2026-10-08 00:00:00.000000

Swaps the CHECK on poke_ledger.op. SQLite cannot alter a CHECK, so it rebuilds
the table in batch mode (rows and the other constraints are carried over).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '2c3d4e5f6a7b'
down_revision: Union[str, Sequence[str], None] = '1b2c3d4e5f6a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

NEW = "op IN ('claim','buy','eat','give','quest','cosmetic','sell')"
OLD = "op IN ('claim','buy','eat','give','quest')"


def _swap(old: str, new: str) -> None:
    bind = op.get_bind()
    if bind.dialect.name == "sqlite":
        # SQLite cannot alter a CHECK. Rebuild the table from its OWN create
        # statement with only that clause changed, so every other rule (ON DELETE
        # actions, UNIQUE, the other CHECKs) and the indexes stay exactly as they were.
        sql = bind.exec_driver_sql("SELECT sql FROM sqlite_master WHERE type='table' AND name='poke_ledger'").scalar()
        if not sql or new in sql:
            return
        if old not in sql:
            raise RuntimeError("poke_ledger has an unexpected op CHECK; not rewriting it")
        idx = [r[0] for r in bind.exec_driver_sql(
            "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='poke_ledger' AND sql IS NOT NULL").all()]
        bind.exec_driver_sql("PRAGMA foreign_keys=OFF")
        bind.exec_driver_sql(sql.replace(old, new).replace('CREATE TABLE "poke_ledger"', 'CREATE TABLE "poke_ledger_new"', 1)
                             .replace("CREATE TABLE poke_ledger", "CREATE TABLE poke_ledger_new", 1))
        bind.exec_driver_sql("INSERT INTO poke_ledger_new SELECT * FROM poke_ledger")
        bind.exec_driver_sql("DROP TABLE poke_ledger")
        bind.exec_driver_sql("ALTER TABLE poke_ledger_new RENAME TO poke_ledger")
        for i in idx:
            bind.exec_driver_sql(i)
        bind.exec_driver_sql("PRAGMA foreign_keys=ON")
    else:
        op.drop_constraint("ck_poke_ledger_op", "poke_ledger", type_="check")
        op.create_check_constraint("ck_poke_ledger_op", "poke_ledger", new)


def upgrade() -> None:
    _swap(OLD, NEW)


def downgrade() -> None:
    _swap(NEW, OLD)
