import type { Dataset, Row } from '../lib/catalog';
import { display } from '../lib/catalog';
import { makeHref } from '../lib/explorer-location';
import { completeIdentity } from '../lib/record-lookup';

const measures = [
  ['receipts', 'Reported receipts'],
  ['disbursements', 'Reported disbursements'],
  ['cash_on_hand', 'Cash at reported period end'],
  ['debts_owed', 'Debt at reported period end'],
] as const;

const stated = (value: unknown) => value == null || value === '' ? 'Not available' : display(value);
const date = (value: unknown) => value instanceof Date ? value.toISOString().slice(0, 10) : stated(value);
const publicUrl = (value: unknown): value is string => typeof value === 'string' && /^https?:\/\//.test(value);

function coverageReasons(value: unknown): string[] | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const reasons: unknown = JSON.parse(value);
    if (Array.isArray(reasons) && reasons.every(reason => typeof reason === 'string')) return reasons;
  } catch { /* Keep unreadable evidence explicit instead of claiming no limitations. */ }
  return undefined;
}

/** Present the published decision. Selection, amounts and coverage belong to Regs. */
export function FinancialProfile({ table, row }: { table: Dataset; row: Row }) {
  if (table.id !== 'fec_financial_profiles') return null;
  if (table.metadataState !== 'current' || row.amount_basis !== 'source_reported') {
    return <section className="financial-profile" aria-label="Reported financial profile">
      <h2>Reported financial profile</h2>
      <p role="status">The profile definition is unavailable for this publication. See the raw fields below.</p>
    </section>;
  }
  const selected = row.selection_status === 'selected';
  const reasons = coverageReasons(row.coverage_reasons_json);
  const filters = typeof row.profile_id === 'string' ? [{ column: 'profile_id', value: row.profile_id }] : [];
  return <section className="financial-profile" aria-label="Reported financial profile">
    <h2>Reported financial profile</h2>
    <p><strong>{stated(row.entity_name)}</strong> · {stated(row.entity_kind)} {stated(row.entity_id)}</p>
    <p>Source cycle: {stated(row.source_cycle)}. Amounts are source-reported, not totals calculated from transactions.</p>
    <p>Reported period: {date(row.period_start)} → {date(row.period_end)}</p>
    <p>Period start status: {stated(row.period_start_status)} · Period end status: {stated(row.period_end_status)}</p>
    {(row.period_start_raw != null || row.period_end_raw != null) && <p>Source date text: {stated(row.period_start_raw)} → {stated(row.period_end_raw)}</p>}
    <p>Snapshot captured: {stated(row.captured_at)}</p>
    <p className="financial-profile-note">The cycle does not establish calendar-year coverage. Capture time does not establish the reporting period or a current balance.</p>
    <div className="financial-profile-status" role="status">
      <p>Selection: {stated(row.selection_status)}. {stated(row.selection_reason)}</p>
      {!selected && <p>No single source snapshot is selected. No chosen figures are shown.</p>}
      <p>Coverage: {stated(row.coverage_status)}</p>
      {reasons ? reasons.length > 0 && <ul>{reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
        : <p>Coverage reasons are unavailable. See the raw fields below.</p>}
    </div>
    <dl className="financial-profile-measures">
      {measures.map(([key, label]) => {
        const amount = row[key];
        // Never coerce monetary text through Number or substitute zero for null.
        const exact = row[`${key}_status`] === 'exact' && typeof amount === 'string' && /^-?\d+(?:\.\d+)?$/.test(amount);
        return <div key={key}>
          <dt>{label}</dt>
          <dd>{!selected ? 'Not selected' : amount == null ? 'Not available' : exact ? `USD ${amount}` : 'Exact amount unavailable'}</dd>
          <small>Status: {stated(row[`${key}_status`])}</small>
          <small>Source field: {stated(row[`${key}_native_field`])}</small>
        </div>;
      })}
    </dl>
    <details>
      <summary>Source and snapshot details</summary>
      <dl className="record-fields">
        <div><dt>Source collection</dt><dd>{stated(row.source_collection_id)}</dd></div>
        <div><dt>Retained source SHA-256</dt><dd>{stated(row.source_sha256)}</dd></div>
        <div><dt>Source table generation</dt><dd>{stated(row.source_table_generation)}</dd></div>
        <div><dt>Recorded witnesses</dt><dd>{stated(row.witness_count)}</dd></div>
      </dl>
      {publicUrl(row.source_url) ? <a href={row.source_url} target="_blank" rel="noreferrer">Publisher source (may change)</a> : <p>Publisher source link not stated.</p>}
      {publicUrl(row.publisher_profile_url) && <a href={row.publisher_profile_url} target="_blank" rel="noreferrer">Publisher entity page (may show a different snapshot)</a>}
      {table.publication?.recordUrl && <a href={table.publication.recordUrl} target="_blank" rel="noreferrer">Selected publication evidence</a>}
      {completeIdentity(table, filters) && <a href={makeHref({ id: table.id, filters, cursor: 0, view: 'records', detail: true })}>Link to this profile</a>}
      <p className="financial-profile-note">Original fields and all recorded witnesses remain below. Coverage qualification is separate from whether an amount was reported.</p>
    </details>
  </section>;
}
