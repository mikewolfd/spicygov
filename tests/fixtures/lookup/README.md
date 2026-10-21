These tiny synthetic Parquet files exercise the existing bounded reader, not
publisher evidence. `groups` contains IDs `a,b,needle,m,x,z,zz,zzz` in two-row
groups; `late-duplicate` contains `a,b,needle,m`; `no-statistics` contains the
same rows as `groups` with statistics disabled. `empty` has the same schema
and no rows. Both columns (`id`, `literal`) are strings; `literal` is `row:N`.
PyArrow wrote them without compression using `row_group_size=2`.

They distinguish conservative candidate budgets from physical cursor positions,
including absent statistics, a duplicate in a later member and trailing empty
member validation. No large-table or source fixture is required.
