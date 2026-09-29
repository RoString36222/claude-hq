"""add taco tuesdays (cali order log + leaderboard)

Revision ID: c7d8e9f0a1b2
Revises: b3c4d5e6f7a8
Create Date: 2026-09-29 00:00:00.000000

CREATE TABLE and CREATE INDEX only: no ALTER and no data changes, so code one
revision behind can still serve a database that has these tables. Each table is
guarded by has_table because the launchd self-host runs `main.lifespan`'s
create_all (which builds them from the models) before alembic gets to run.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c7d8e9f0a1b2'
down_revision: Union[str, Sequence[str], None] = 'b3c4d5e6f7a8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    insp = sa.inspect(op.get_bind())

    if not insp.has_table('taco_orders'):
        op.create_table(
            'taco_orders',
            sa.Column('id', sa.String(length=36), nullable=False),
            sa.Column('user_id', sa.String(length=36), nullable=False),
            sa.Column('request_id', sa.String(length=64), nullable=False),
            sa.Column('order_date', sa.Date(), nullable=False),
            sa.Column('total_tacos', sa.Integer(), server_default='0', nullable=False),
            sa.Column('paid_tacos', sa.Integer(), server_default='0', nullable=False),
            sa.Column('note', sa.String(length=80), server_default='', nullable=False),
            # No server default: set in Python so a replay can return it.
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('user_id', 'request_id', name='uq_taco_orders_user_request'),
            sa.CheckConstraint('total_tacos >= 0', name='ck_taco_orders_total_nonneg'),
            sa.CheckConstraint('paid_tacos >= 0', name='ck_taco_orders_paid_nonneg'),
            sa.CheckConstraint('paid_tacos <= total_tacos', name='ck_taco_orders_paid_le_total'),
        )
        op.create_index('ix_taco_orders_user_id', 'taco_orders', ['user_id'])
        op.create_index('ix_taco_orders_date', 'taco_orders', ['order_date'])

    if not insp.has_table('taco_diners'):
        op.create_table(
            'taco_diners',
            sa.Column('id', sa.String(length=36), nullable=False),
            sa.Column('order_id', sa.String(length=36), nullable=False),
            # Nullable: a founder without a paired device is carried by name.
            sa.Column('user_id', sa.String(length=36), nullable=True),
            sa.Column('diner_name', sa.String(length=40), server_default='', nullable=False),
            sa.Column('mild_hard', sa.Integer(), server_default='0', nullable=False),
            sa.Column('mild_soft', sa.Integer(), server_default='0', nullable=False),
            sa.Column('wild_hard', sa.Integer(), server_default='0', nullable=False),
            sa.Column('wild_soft', sa.Integer(), server_default='0', nullable=False),
            sa.ForeignKeyConstraint(['order_id'], ['taco_orders.id'], ondelete='CASCADE'),
            # SET NULL, not CASCADE: deleting an account keeps the dinner's history.
            sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='SET NULL'),
            sa.PrimaryKeyConstraint('id'),
            sa.CheckConstraint(
                "user_id IS NOT NULL OR diner_name <> ''", name='ck_taco_diners_identity'
            ),
            sa.CheckConstraint(
                'mild_hard >= 0 AND mild_soft >= 0 AND wild_hard >= 0 AND wild_soft >= 0',
                name='ck_taco_diners_counts_nonneg',
            ),
        )
        op.create_index('ix_taco_diners_order_id', 'taco_diners', ['order_id'])
        op.create_index('ix_taco_diners_user', 'taco_diners', ['user_id'])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('ix_taco_diners_user', table_name='taco_diners')
    op.drop_index('ix_taco_diners_order_id', table_name='taco_diners')
    op.drop_table('taco_diners')
    op.drop_index('ix_taco_orders_date', table_name='taco_orders')
    op.drop_index('ix_taco_orders_user_id', table_name='taco_orders')
    op.drop_table('taco_orders')
