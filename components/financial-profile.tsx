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
const rawText = (value: unknown) => value == null ? 'Not stated (null)' : value === '' ? 'Empty source text' : display(value);
const date = (value: unknown) => value instanceof Date ? value.toISOString().slice(0, 10) : stated(value);
const publicUrl = (value: unknown): value is string => typeof value === 'string' && /^https?:\/\//.test(value);

// Display published decisions; unknown codes remain visible rather than inferred.
const selectionLabels = {
  selected: 'Source snapshot selected', ambiguous: 'No single source snapshot is selected',
};
const selectionReasons = {
  unique_reported_snapshot: 'One reported snapshot.',
  equivalent_witnesses: 'Matching source records; figures are shown once, not added together.',
  conflicting_reported_snapshots: 'Source records disagree.',
};
const coverageLabels = {
  reported: 'Period checks passed', unqualified: 'Period not qualified', ambiguous: 'Period unresolved',
};
const valueLabels = {
  exact: 'Source-reported', source_null: 'Source field is null', source_empty: 'Source field is empty',
  not_supplied: 'Not supplied by this source', refused: 'Value could not be accepted',
  ambiguous: 'Conflicting source values',
};
const dateLabels = {
  exact: 'Reported date', exact_with_year_bounds: 'Reported year bounds',
  source_null: 'Source date is null', source_empty: 'Source date is empty',
  not_supplied: 'Date not supplied', invalid_date: 'Invalid source date',
  unsupported_spelling: 'Unrecognized source date', ambiguous: 'Conflicting source dates',
};
const reasonLabels = {
  period_start_after_end: 'The reported start follows the reported end.',
  period_end_after_capture: 'The reported end follows the snapshot capture date.',
  period_outside_declared_cycle: 'The reported period extends outside the source cycle.',
  conflicting_reported_snapshots: 'Source records disagree.',
};
const label = (value: unknown, labels: Record<string, string>) =>
  typeof value === 'string' && Object.hasOwn(labels, value) ? labels[value] : `Unknown: ${stated(value)}`;
function reasonLabel(reason: string) {
  const match = /^(period_start|period_end):(.*)$/.exec(reason);
  if (match) {
    return `${match[1] === 'period_start' ? 'Period start' : 'Period end'}: ${label(match[2], dateLabels)}`;
  }
  return label(reason, reasonLabels);
}

function currency(value: unknown): string | undefined {
  // String-only formatting avoids rounding through JavaScript's Number range.
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) return undefined;
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const grouped = whole.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  // Remove only insignificant trailing zeros; keep every nonzero fractional digit.
  return `${negative ? '-' : ''}$${grouped}.${fraction.replace(/0+$/, '').padEnd(2, '0')} USD`;
}

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
    <p>Source cycle: {stated(row.source_cycle)}. Figures are reported by the source, not added from transactions.</p>
    <p>Reported period: {date(row.period_start)} → {date(row.period_end)}</p>
    {(row.period_start_status !== 'exact' || row.period_end_status !== 'exact') &&
      <p>Start: {label(row.period_start_status, dateLabels)} · End: {label(row.period_end_status, dateLabels)}</p>}
    <p>Snapshot captured: {stated(row.captured_at)}</p>
    <p className="financial-profile-note">The cycle and capture time do not establish a current balance.</p>
    <div className="financial-profile-status" role="status">
      <p>{label(row.selection_status, selectionLabels)}. {label(row.selection_reason, selectionReasons)}</p>
      {!selected && <p>No chosen figures are shown.</p>}
      <p>Coverage: {reasons ? label(row.coverage_status, coverageLabels) : 'Qualification unavailable'}</p>
      {reasons ? reasons.length > 0 && <ul>{reasons.map((reason, index) => <li key={index}>{reasonLabel(reason)}</li>)}</ul>
        : <p>Coverage reasons are unavailable. See the raw fields below.</p>}
    </div>
    <dl className="financial-profile-measures">
      {measures.map(([key, name]) => {
        const amount = row[key];
        const formatted = row[`${key}_status`] === 'exact' ? currency(amount) : undefined;
        return <div key={key}>
          <dt>{name}</dt>
          <dd>{!selected ? 'Not selected' : amount == null ? 'Not available' : formatted ?? 'Exact amount unavailable'}</dd>
          <small>{label(row[`${key}_status`], valueLabels)}</small>
        </div>;
      })}
    </dl>
    <details>
      <summary>Source and snapshot details</summary>
      <dl className="record-fields">
        <div><dt>Selection status / reason</dt><dd>{stated(row.selection_status)} / {stated(row.selection_reason)}</dd></div>
        <div><dt>Coverage status / reasons</dt><dd>{stated(row.coverage_status)} / {stated(row.coverage_reasons_json)}</dd></div>
        <div><dt>Source date text</dt><dd>{rawText(row.period_start_raw)} → {rawText(row.period_end_raw)}</dd></div>
        <div><dt>Source date status</dt><dd>{stated(row.period_start_status)} → {stated(row.period_end_status)}</dd></div>
        {measures.map(([key, name]) => <div key={key}>
          <dt>{name}: exact text / raw source text</dt>
          <dd>{rawText(row[key])} / {rawText(row[`${key}_raw`])}</dd>
          <dt>Source field / status</dt>
          <dd>{stated(row[`${key}_native_field`])} / {stated(row[`${key}_status`])}</dd>
        </div>)}
        <div><dt>Source collection</dt><dd>{stated(row.source_collection_id)}</dd></div>
        <div><dt>Retained source SHA-256</dt><dd>{stated(row.source_sha256)}</dd></div>
        <div><dt>Source table generation</dt><dd>{stated(row.source_table_generation)}</dd></div>
        <div><dt>Recorded witnesses</dt><dd>{stated(row.witness_count)}</dd></div>
      </dl>
      {publicUrl(row.source_url) ? <a href={row.source_url} target="_blank" rel="noreferrer">Publisher source (may change)</a> : <p>Publisher source link not stated.</p>}
      {publicUrl(row.publisher_profile_url) && <a href={row.publisher_profile_url} target="_blank" rel="noreferrer">Publisher entity page (may show a different snapshot)</a>}
      {table.publication?.recordUrl && <a href={table.publication.recordUrl} target="_blank" rel="noreferrer">Selected publication evidence</a>}
      {completeIdentity(table, filters) && <a href={makeHref({ id: table.id, filters, cursor: 0, view: 'records', detail: true })}>Link to this profile</a>}
      <p className="financial-profile-note">Only insignificant decimal zeros are hidden in the figures above; amounts are not rounded. Original fields and all recorded witnesses remain below. Coverage qualification is separate from whether an amount was reported. The cycle does not establish calendar-year coverage, and capture time does not establish the reporting period.</p>
    </details>
  </section>;
}
