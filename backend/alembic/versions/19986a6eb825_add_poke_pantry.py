"""add poke pantry (Poke Coins, food, gifts)

Revision ID: 19986a6eb825
Revises: a1b2c3d4e5f6
Create Date: 2026-09-28 00:00:00.000000

CREATE TABLE and CREATE INDEX only: no ALTER and no data changes, so code one
revision behind can still serve a database that has these tables. Each table is
guarded by has_table because the launchd self-host runs `main.lifespan`'s
create_all (which builds them from the models) before alembic gets to run.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '19986a6eb825'
down_revision: Union[str, Sequence[str], None] = 'a1b2c3d4e5f6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    insp = sa.inspect(op.get_bind())

    if not insp.has_table('poke_balances'):
        op.create_table(
            'poke_balances',
            sa.Column('id', sa.String(length=36), nullable=False),
            sa.Column('user_id', sa.String(length=36), nullable=False),
            sa.Column('item', sa.String(length=16), nullable=False),
            sa.Column('qty', sa.Integer(), server_default='0', nullable=False),
            sa.Column('updated_at', sa.DateTime(timezone=True),
                      server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
            sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('user_id', 'item', name='uq_poke_balances_user_item'),
            sa.CheckConstraint('qty >= 0', name='ck_poke_balances_qty_nonneg'),
        )

    if not insp.has_table('poke_ledger'):
        op.create_table(
            'poke_ledger',
            sa.Column('id', sa.String(length=36), nullable=False),
            sa.Column('user_id', sa.String(length=36), nullable=False),
            sa.Column('request_id', sa.String(length=64), nullable=False),
            sa.Column('op', sa.String(length=8), nullable=False),
            sa.Column('op_date', sa.Date(), nullable=False),
            sa.Column('kind', sa.String(length=16), nullable=True),
            sa.Column('qty', sa.Integer(), server_default='0', nullable=False),
            sa.Column('coins', sa.Integer(), server_default='0', nullable=False),
            sa.Column('to_user_id', sa.String(length=36), nullable=True),
            sa.Column('note', sa.String(length=80), server_default='', nullable=False),
            # No server default: set in Python so a replay can return it.
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
            sa.Column('delivered_at', sa.DateTime(timezone=True), nullable=True),
            sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
            sa.ForeignKeyConstraint(['to_user_id'], ['users.id'], ondelete='SET NULL'),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('user_id', 'request_id', name='uq_poke_ledger_user_request'),
            sa.CheckConstraint("op IN ('claim','buy','eat','give')", name='ck_poke_ledger_op'),
            sa.CheckConstraint('qty >= 0', name='ck_poke_ledger_qty_nonneg'),
            sa.CheckConstraint('coins >= 0', name='ck_poke_ledger_coins_nonneg'),
        )
        op.create_index('ix_poke_ledger_user_date', 'poke_ledger', ['user_id', 'op_date'])
        op.create_index('ix_poke_ledger_to_date', 'poke_ledger', ['to_user_id', 'op_date'])
        op.create_index('ix_poke_ledger_to_undelivered', 'poke_ledger',
                        ['to_user_id', 'delivered_at'])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('ix_poke_ledger_to_undelivered', table_name='poke_ledger')
    op.drop_index('ix_poke_ledger_to_date', table_name='poke_ledger')
    op.drop_index('ix_poke_ledger_user_date', table_name='poke_ledger')
    op.drop_table('poke_ledger')
    op.drop_table('poke_balances')
