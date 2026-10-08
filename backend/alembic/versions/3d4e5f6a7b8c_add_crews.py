"""add crews (HQ 2.1)

Revision ID: 3d4e5f6a7b8c
Revises: 2c3d4e5f6a7b
Create Date: 2026-10-08 00:00:00.000000

CREATE TABLE only, guarded by has_table (the launchd self-host runs create_all
first), so code one revision behind can still serve a database that has it.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '3d4e5f6a7b8c'
down_revision: Union[str, Sequence[str], None] = '2c3d4e5f6a7b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if not insp.has_table('crews'):
        op.create_table(
            'crews',
            sa.Column('id', sa.String(length=36), nullable=False),
            sa.Column('name', sa.String(length=32), nullable=False),
            sa.Column('tag', sa.String(length=4), nullable=False),
            sa.Column('color', sa.String(length=7), nullable=False),
            sa.Column('code', sa.String(length=12), nullable=False),
            sa.Column('owner_id', sa.String(length=36), nullable=False),
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.ForeignKeyConstraint(['owner_id'], ['users.id'], ondelete='CASCADE'),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('name'), sa.UniqueConstraint('code'),
        )
    if not insp.has_table('crew_members'):
        op.create_table(
            'crew_members',
            sa.Column('user_id', sa.String(length=36), nullable=False),
            sa.Column('crew_id', sa.String(length=36), nullable=False),
            sa.Column('joined_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
            sa.ForeignKeyConstraint(['crew_id'], ['crews.id'], ondelete='CASCADE'),
            sa.PrimaryKeyConstraint('user_id'),
        )
        op.create_index('ix_crew_members_crew_id', 'crew_members', ['crew_id'])


def downgrade() -> None:
    op.drop_index('ix_crew_members_crew_id', 'crew_members')
    op.drop_table('crew_members')
    op.drop_table('crews')
