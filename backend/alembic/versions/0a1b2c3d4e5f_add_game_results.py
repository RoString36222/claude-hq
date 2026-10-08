"""add game results (HQ 2.1: progression, leaderboards, profiles)

Revision ID: 0a1b2c3d4e5f
Revises: f0a1b2c3d4e5
Create Date: 2026-10-08 00:00:00.000000

CREATE TABLE only, guarded by has_table (the launchd self-host runs create_all
first), so code one revision behind can still serve a database that has it.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0a1b2c3d4e5f'
down_revision: Union[str, Sequence[str], None] = 'f0a1b2c3d4e5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if not insp.has_table('game_results'):
        op.create_table(
            'game_results',
            sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
            sa.Column('user_id', sa.String(length=36), nullable=False),
            sa.Column('game', sa.String(length=8), nullable=False),
            sa.Column('key', sa.String(length=40), nullable=False),
            sa.Column('mode', sa.String(length=16), nullable=False, server_default=''),
            sa.Column('place', sa.Integer(), nullable=False),
            sa.Column('players', sa.Integer(), nullable=False),
            sa.Column('value', sa.Integer(), nullable=True),
            sa.Column('extra', sa.JSON(), nullable=False),
            sa.Column('at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
            sa.PrimaryKeyConstraint('id'),
        )
        op.create_index('ix_game_results_board', 'game_results', ['game', 'key', 'value'])
        op.create_index('ix_game_results_user', 'game_results', ['user_id', 'at'])


def downgrade() -> None:
    op.drop_index('ix_game_results_user', 'game_results')
    op.drop_index('ix_game_results_board', 'game_results')
    op.drop_table('game_results')
