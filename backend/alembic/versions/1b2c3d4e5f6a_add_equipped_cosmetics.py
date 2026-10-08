"""add equipped cosmetics (HQ 2.1)

Revision ID: 1b2c3d4e5f6a
Revises: 0a1b2c3d4e5f
Create Date: 2026-10-08 00:00:00.000000

CREATE TABLE only, guarded by has_table (the launchd self-host runs create_all
first), so code one revision behind can still serve a database that has it.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '1b2c3d4e5f6a'
down_revision: Union[str, Sequence[str], None] = '0a1b2c3d4e5f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if not insp.has_table('equipped_cosmetics'):
        op.create_table(
            'equipped_cosmetics',
            sa.Column('user_id', sa.String(length=36), nullable=False),
            sa.Column('slots', sa.JSON(), nullable=False),
            sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
            sa.PrimaryKeyConstraint('user_id'),
        )


def downgrade() -> None:
    op.drop_table('equipped_cosmetics')
