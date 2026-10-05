"""tabledoc + tablerow — openenrich's team tables (docs/context/architecture/tables.md)

Revision ID: 0063
Revises: 0062
Create Date: 2026-10-04

Two new tables, nothing else touched. Reached only behind the /table/ flag.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0063"
down_revision: str | Sequence[str] | None = "0062"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "tabledoc",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("org_id", sa.Integer(), sa.ForeignKey("org.id"), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("parent_id", sa.Integer(), nullable=True),
        sa.Column("parent_column", sa.String(), nullable=True),
        sa.Column("source", sa.JSON(), nullable=True),
        sa.Column("columns", sa.JSON(), nullable=False),
        sa.Column("created_by", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("org_id", "name", name="uq_tabledoc_org_name"),
    )
    op.create_index("ix_tabledoc_org_id", "tabledoc", ["org_id"])
    op.create_table(
        "tablerow",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("table_id", sa.Integer(), sa.ForeignKey("tabledoc.id"), nullable=False),
        sa.Column("row_key", sa.String(), nullable=False),
        sa.Column("parent_row", sa.String(), nullable=True),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("cells", sa.JSON(), nullable=False),
        sa.Column("runs", sa.JSON(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("table_id", "row_key", name="uq_tablerow_table_key"),
    )
    op.create_index("ix_tablerow_table_id", "tablerow", ["table_id"])


def downgrade() -> None:
    op.drop_index("ix_tablerow_table_id", table_name="tablerow")
    op.drop_table("tablerow")
    op.drop_index("ix_tabledoc_org_id", table_name="tabledoc")
    op.drop_table("tabledoc")
