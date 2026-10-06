"""add cali menu items (taco_diners.items)

Revision ID: d8e9f0a1b2c3
Revises: c7d8e9f0a1b2
Create Date: 2026-10-05 00:00:00.000000

One ADD COLUMN with a server default, so code one revision behind can still
write to the table: its INSERTs never name the column and get '{}'. Guarded by
the column's presence because the SQLite dev/self-host path runs
`main.lifespan`'s create_all, which builds a fresh taco_diners straight from the
model (with the column) before alembic gets to run.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd8e9f0a1b2c3'
down_revision: Union[str, Sequence[str], None] = 'c7d8e9f0a1b2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_items() -> bool:
    insp = sa.inspect(op.get_bind())
    return any(c['name'] == 'items' for c in insp.get_columns('taco_diners'))


def upgrade() -> None:
    """Upgrade schema."""
    if _has_items():
        return
    op.add_column(
        'taco_diners',
        sa.Column('items', sa.JSON(), server_default='{}', nullable=False),
    )


def downgrade() -> None:
    """Downgrade schema."""
    if not _has_items():
        return
    # A plain DROP COLUMN (SQLite 3.35+, Postgres): no table rebuild, so the
    # table's CHECK constraints stay exactly as they were.
    op.drop_column('taco_diners', 'items')
