"""add room farms (Valley shared garden)

Revision ID: e9f0a1b2c3d4
Revises: d8e9f0a1b2c3
Create Date: 2026-10-06 00:00:00.000000

CREATE TABLE only, guarded by has_table (the launchd self-host runs create_all
first), so code one revision behind can still serve a database that has it.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e9f0a1b2c3d4'
down_revision: Union[str, Sequence[str], None] = 'd8e9f0a1b2c3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if not insp.has_table('room_farms'):
        op.create_table(
            'room_farms',
            sa.Column('room_id', sa.String(length=64), nullable=False),
            sa.Column('data', sa.JSON(), nullable=False),
            sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.PrimaryKeyConstraint('room_id'),
        )


def downgrade() -> None:
    op.drop_table('room_farms')
