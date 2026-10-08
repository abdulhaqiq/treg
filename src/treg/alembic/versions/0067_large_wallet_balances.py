"""Widen wallet balances and funding entries beyond the 32-bit micro-USD ceiling.

Revision ID: 0067
Revises: 0066
Create Date: 2026-10-08

Micro-USD gives an INTEGER column a maximum value of only $2,147.48. Larger prepaid or
promotional balances therefore failed before the journal transaction could be committed. The
wallet total, funding blocks, and append-only journal are widened together so their invariant can
represent the same value on every side.

Rollback floor: once a wallet, block, or journal entry exceeds INT32, old database schemas cannot
represent it. Older application releases remain compatible with BIGINT columns, but downgrading
this migration requires all four columns to fit in INT32 first.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0067"
down_revision: str | Sequence[str] | None = "0066"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
contract = True


def _alter(type_: sa.types.TypeEngine) -> None:
    with op.batch_alter_table("org") as batch:
        batch.alter_column(
            "balance_micro", existing_type=sa.Integer(), type_=type_, existing_nullable=False)
    with op.batch_alter_table("creditblock") as batch:
        batch.alter_column(
            "amount_micro", existing_type=sa.Integer(), type_=type_, existing_nullable=False)
        batch.alter_column(
            "remaining_micro", existing_type=sa.Integer(), type_=type_, existing_nullable=False)
    with op.batch_alter_table("ledgerentry") as batch:
        batch.alter_column(
            "amount_micro", existing_type=sa.Integer(), type_=type_, existing_nullable=False)


def upgrade() -> None:
    _alter(sa.BigInteger())


def downgrade() -> None:
    _alter(sa.Integer())
