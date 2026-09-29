"""add quest op to poke_ledger

Revision ID: b3c4d5e6f7a8
Revises: 6f838c2049e2
Create Date: 2026-09-29

SQLite cannot ALTER CHECK constraints, so we recreate the constraint by
renaming, copying, and dropping. The self-host path (lifespan create_all)
already uses the updated model, so this migration only matters for the
VPS deployment that runs alembic.
"""
from alembic import op
import sqlalchemy as sa

revision = "b3c4d5e6f7a8"
down_revision = "6f838c2049e2"
branch_labels = None
depends_on = None

OLD_CHECK = "op IN ('claim','buy','eat','give')"
NEW_CHECK = "op IN ('claim','buy','eat','give','quest')"


def upgrade() -> None:
    conn = op.get_bind()
    if conn.dialect.name == "sqlite":
        op.execute("PRAGMA foreign_keys=OFF")
        op.execute("""
            CREATE TABLE poke_ledger_new (
                id          VARCHAR(36) NOT NULL PRIMARY KEY,
                user_id     VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                request_id  VARCHAR(100) NOT NULL,
                op          VARCHAR(10) NOT NULL,
                op_date     DATE NOT NULL,
                kind        VARCHAR(20),
                qty         INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
                coins       INTEGER NOT NULL DEFAULT 0 CHECK (coins >= 0),
                to_user_id  VARCHAR(36) REFERENCES users(id) ON DELETE SET NULL,
                note        VARCHAR(80) NOT NULL DEFAULT '',
                created_at  DATETIME NOT NULL,
                delivered_at DATETIME,
                UNIQUE (user_id, request_id),
                CHECK (op IN ('claim','buy','eat','give','quest'))
            )
        """)
        op.execute("""
            INSERT INTO poke_ledger_new
            SELECT id, user_id, request_id, op, op_date, kind, qty, coins,
                   to_user_id, note, created_at, delivered_at
            FROM poke_ledger
        """)
        op.execute("DROP TABLE poke_ledger")
        op.execute("ALTER TABLE poke_ledger_new RENAME TO poke_ledger")
        op.execute("CREATE INDEX ix_poke_ledger_user_date ON poke_ledger (user_id, op_date)")
        op.execute("CREATE INDEX ix_poke_ledger_to_date ON poke_ledger (to_user_id, op_date)")
        op.execute("CREATE INDEX ix_poke_ledger_to_undelivered ON poke_ledger (to_user_id, delivered_at)")
        op.execute("PRAGMA foreign_keys=ON")
    else:
        op.drop_constraint("ck_poke_ledger_op", "poke_ledger", type_="check")
        op.create_check_constraint("ck_poke_ledger_op", "poke_ledger", NEW_CHECK)


def downgrade() -> None:
    conn = op.get_bind()
    if conn.dialect.name == "sqlite":
        op.execute("DELETE FROM poke_ledger WHERE op = 'quest'")
        op.execute("PRAGMA foreign_keys=OFF")
        op.execute("""
            CREATE TABLE poke_ledger_old (
                id          VARCHAR(36) NOT NULL PRIMARY KEY,
                user_id     VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                request_id  VARCHAR(100) NOT NULL,
                op          VARCHAR(10) NOT NULL,
                op_date     DATE NOT NULL,
                kind        VARCHAR(20),
                qty         INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
                coins       INTEGER NOT NULL DEFAULT 0 CHECK (coins >= 0),
                to_user_id  VARCHAR(36) REFERENCES users(id) ON DELETE SET NULL,
                note        VARCHAR(80) NOT NULL DEFAULT '',
                created_at  DATETIME NOT NULL,
                delivered_at DATETIME,
                UNIQUE (user_id, request_id),
                CHECK (op IN ('claim','buy','eat','give'))
            )
        """)
        op.execute("""
            INSERT INTO poke_ledger_old
            SELECT id, user_id, request_id, op, op_date, kind, qty, coins,
                   to_user_id, note, created_at, delivered_at
            FROM poke_ledger
        """)
        op.execute("DROP TABLE poke_ledger")
        op.execute("ALTER TABLE poke_ledger_old RENAME TO poke_ledger")
        op.execute("CREATE INDEX ix_poke_ledger_user_date ON poke_ledger (user_id, op_date)")
        op.execute("CREATE INDEX ix_poke_ledger_to_date ON poke_ledger (to_user_id, op_date)")
        op.execute("CREATE INDEX ix_poke_ledger_to_undelivered ON poke_ledger (to_user_id, delivered_at)")
        op.execute("PRAGMA foreign_keys=ON")
    else:
        op.drop_constraint("ck_poke_ledger_op", "poke_ledger", type_="check")
        op.create_check_constraint("ck_poke_ledger_op", "poke_ledger", OLD_CHECK)
