"""tablerun — openenrich's server-side column runs (docs/context/architecture/tables.md, phase 2)

Revision ID: 0066
Revises: 0065
Create Date: 2026-10-07

One new table, nothing else touched. Reached only behind the /table/ flag.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0066"
down_revision: str | Sequence[str] | None = "0065"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "tablerun",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("org_id", sa.Integer(), sa.ForeignKey("org.id"), nullable=False),
        sa.Column("table_id", sa.Integer(), sa.ForeignKey("tabledoc.id"), nullable=False),
        sa.Column("group", sa.String(), nullable=False),
        sa.Column("membership_id", sa.Integer(), sa.ForeignKey("membership.id"), nullable=False),
        sa.Column("row_ids", sa.JSON(), nullable=False),
        sa.Column("fresh_ids", sa.JSON(), nullable=False),
        sa.Column("state", sa.String(), nullable=False),
        sa.Column("total", sa.Integer(), nullable=False),
        sa.Column("done", sa.Integer(), nullable=False),
        sa.Column("hits", sa.Integer(), nullable=False),
        sa.Column("misses", sa.Integer(), nullable=False),
        sa.Column("errors", sa.Integer(), nullable=False),
        sa.Column("spent_micro", sa.Integer(), nullable=False),
        sa.Column("max_usd", sa.Float(), nullable=True),
        sa.Column("stop_requested", sa.Boolean(), nullable=False),
        sa.Column("error", sa.String(), nullable=True),
        sa.Column("lease_until", sa.DateTime(), nullable=True),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_tablerun_org_id", "tablerun", ["org_id"])
    op.create_index("ix_tablerun_table_id", "tablerun", ["table_id"])
    op.create_index("ix_tablerun_state", "tablerun", ["state"])
    op.create_index("ix_tablerun_lease_until", "tablerun", ["lease_until"])


def downgrade() -> None:
    op.drop_table("tablerun")
