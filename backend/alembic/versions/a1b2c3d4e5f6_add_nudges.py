"""add nudges

Revision ID: a1b2c3d4e5f6
Revises: 619402b7d8c8
Create Date: 2026-09-25 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, Sequence[str], None] = '619402b7d8c8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'nudges',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('from_user_id', sa.String(length=36), nullable=False),
        sa.Column('to_user_id', sa.String(length=36), nullable=False),
        sa.Column('note', sa.String(length=120), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('delivered_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['from_user_id'], ['users.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['to_user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_nudges_from_user_id'), 'nudges', ['from_user_id'])
    op.create_index(op.f('ix_nudges_to_user_id'), 'nudges', ['to_user_id'])
    op.create_index('ix_nudges_to_undelivered', 'nudges', ['to_user_id', 'delivered_at'])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('ix_nudges_to_undelivered', table_name='nudges')
    op.drop_index(op.f('ix_nudges_to_user_id'), table_name='nudges')
    op.drop_index(op.f('ix_nudges_from_user_id'), table_name='nudges')
    op.drop_table('nudges')
