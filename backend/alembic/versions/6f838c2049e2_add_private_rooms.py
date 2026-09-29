"""add private rooms

Revision ID: 6f838c2049e2
Revises: 19986a6eb825
Create Date: 2026-09-29

CREATE TABLE and CREATE INDEX only: no ALTER and no data changes. Each table is
guarded by has_table because the launchd self-host runs main.lifespan's
create_all (which builds them from the models) before alembic gets to run.
"""
from alembic import op
import sqlalchemy as sa

revision = "6f838c2049e2"
down_revision = "19986a6eb825"
branch_labels = None
depends_on = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())

    if not insp.has_table("private_rooms"):
        op.create_table(
            "private_rooms",
            sa.Column("id", sa.String(24), primary_key=True),
            sa.Column("name", sa.String(40), nullable=False),
            sa.Column("name_key", sa.String(255), nullable=False),
            sa.Column("owner_user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("password_hash", sa.String(200), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.UniqueConstraint("name_key", name="uq_private_rooms_name_key"),
        )
        op.create_index("ix_private_rooms_owner_user_id", "private_rooms", ["owner_user_id"])

    if not insp.has_table("private_room_members"):
        op.create_table(
            "private_room_members",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("room_id", sa.String(24), sa.ForeignKey("private_rooms.id", ondelete="CASCADE"), nullable=False),
            sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("role", sa.String(8), nullable=False, server_default="member"),
            sa.Column("joined_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.UniqueConstraint("room_id", "user_id", name="uq_private_room_member"),
            sa.CheckConstraint("role IN ('owner','member','banned')", name="ck_private_room_member_role"),
        )
        op.create_index("ix_private_room_members_room_id", "private_room_members", ["room_id"])
        op.create_index("ix_private_room_members_user_id", "private_room_members", ["user_id"])

    if not insp.has_table("private_room_join_attempts"):
        op.create_table(
            "private_room_join_attempts",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("room_id", sa.String(24), sa.ForeignKey("private_rooms.id", ondelete="CASCADE"), nullable=False),
            sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        )
        op.create_index("ix_private_room_attempts_user_room_at", "private_room_join_attempts", ["user_id", "room_id", "created_at"])
        op.create_index("ix_private_room_attempts_room_at", "private_room_join_attempts", ["room_id", "created_at"])
        op.create_index("ix_private_room_attempts_user_at", "private_room_join_attempts", ["user_id", "created_at"])


def downgrade() -> None:
    op.drop_table("private_room_join_attempts")
    op.drop_table("private_room_members")
    op.drop_table("private_rooms")
