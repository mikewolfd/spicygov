"""Whether the installed spicy-regs coverage reader admits carried receipts (it dropped its generation argument).

A carried receipt keeps the generation that first wrote it, so a reader that accepts them can no longer tell a
relabelled selection from the selected one by the receipts alone; the pinned receipt-file bytes bind it instead.
Until the spicy-regs pin carries that reader, the older refusals still apply and their tests still run.
"""
import inspect

from spicy_regs import coverage_reader

CARRIED = len(inspect.signature(coverage_reader.current_receipts).parameters) == 3
