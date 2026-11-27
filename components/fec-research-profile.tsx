import type { Dataset, Row } from '../lib/catalog';
import { display } from '../lib/catalog';
import { currency } from '../lib/exact-currency';

const text = (v: unknown) => v == null ? 'Not supplied' : v === '' ? 'Empty source text' : display(v);
const money = (v: unknown) => currency(v) ?? 'Exact amount unavailable';
const labels: Record<string, string> = {
  missing_field: 'Field not supplied', null: 'Source null', empty_list: 'Empty source list',
  empty_string: 'Empty source text', reported_none: 'Source explicitly reports none', reported: 'Reported',
};
const relations: Record<string, string> = {
  affiliated_committee_or_connected_organization: 'Disclosed affiliation', committee_candidate: 'Candidate link',
  leadership_pac_sponsor: 'Leadership PAC sponsor',
};
// Exact versions emitted by the coordinated Regs/source readers. Tables without
// policy_version use their existing interpretation, mapping or amount-basis
// fields; the UI must not invent a producer policy for them.
const definitions: Record<string, Record<string, string | readonly string[]>> = {
  fec_committee_relationship_profiles: {policy_version:'fec-disclosed-relationships/1'},
  fec_contribution_profiles: {policy_version:'fec-selected-report-contributions/1',
    amount_basis:'effective_as_filed_recipient_report_reconciled_to_official_report'},
  fec_contribution_decisions: {policy_version:'fec-selected-report-contributions/1'},
  fec_outside_spending_profiles: {policy_version:'fec-publisher-outside-spending/1',
    amount_basis:'publisher_schedule_e_aggregate_reconciled_to_publisher_total',
    election_basis:'all_elections_in_selected_two_year_cycle'},
  fec_outside_spending_spenders: {policy_version:'fec-publisher-outside-spending/1',
    amount_basis:'publisher_schedule_e_aggregate_reconciled_to_publisher_total',
    election_basis:'all_elections_in_selected_two_year_cycle'},
  fec_election_results: {
    interpretation_version: ['fec-senate-results/1', 'fec-federal-election-results/2'],
    reader_version: ['fec-election-workbook/1', 'fec-election-workbook/2'],
    vote_basis: ['ballot_line', 'reported_total', 'combined_party_witness', 'ranked_choice_round', 'electoral_vote'],
  },
  sector_financial_comparisons: {policy_version:'fec-lda-sector-comparison/1',
    classification_scheme:'NAICS-2022',mapping_version:'fec-lda-curated-naics2022-context-20261113/2'},
  sector_classification_evidence: {classification_scheme:'NAICS-2022',
    mapping_version:'fec-lda-curated-naics2022-context-20261113/2'},
  lobbying_issue_financial_observations: {amount_basis:'whole_selected_filing_not_allocated_by_issue'},
};
const definitionLabels: Record<string, string> = {
  policy_version:'policy version', amount_basis:'amount basis', election_basis:'election scope',
  interpretation_version:'election interpretation version', reader_version:'workbook reader version',
  vote_basis:'vote basis', classification_scheme:'classification scheme', mapping_version:'sector mapping version',
};
const sectorBases: Record<string, string> = {
  fec:'publisher_reported_period_flow', lda:'selected_quarterly_reported_estimates',
};
function objects(value: unknown): Row[] | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const rows: unknown = JSON.parse(value);
    return Array.isArray(rows) && rows.every(r => r && typeof r === 'object' && !Array.isArray(r)) ? rows : undefined;
  } catch { return undefined; }
}
function source(row: Row) {
  const urls = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== 'string') return;
    try { const url = new URL(value); if (url.protocol === 'https:' && url.hostname && !url.username && !url.password) urls.add(value); }
    catch { /* An unavailable source link does not change the displayed source decision. */ }
  };
  add(row.source_url);
  for (const field of ['source_evidence_json', 'evidence_json']) {
    const queue = [...(objects(row[field]) ?? [])];
    // Only the bounded, declared evidence arrays are inspected. Full original
    // fields remain in the explorer's source rows below this panel.
    for (let visited = 0; queue.length && visited < 128; visited++) {
      const item = queue.shift()!;
      add(item.url); add(item.request_url); add(item.source_url);
      for (const key of ['pages', 'evidence']) if (Array.isArray(item[key])) {
        for (const entry of item[key]) if (entry && typeof entry === 'object' && !Array.isArray(entry)) queue.push(entry as Row);
      }
    }
  }
  return <>
    {urls.size > 0 && <ul aria-label="Publisher sources">{[...urls].slice(0, 8).map(url =>
      <li key={url}><a href={url} target="_blank" rel="noreferrer">Publisher source: {new URL(url).hostname}</a></li>)}</ul>}
    {row.source_sha256 ? <p>Original: {text(row.source_sha256)}</p> : null}
    <p className="financial-profile-note">{text(row.coverage_note ?? row.overlap_note)}</p>
  </>;
}
function candidateLink(row: Row) {
  const id = row.object_id;
  return typeof id === 'string' && /^[HPS][A-Z0-9]{8}$/.test(id)
    ? <a href={`https://www.fec.gov/data/candidate/${id}/`} target="_blank" rel="noreferrer">{id}</a>
    : text(id);
}

/** Display domain decisions already qualified by Regs; never calculate a new financial total. */
export function FecResearchProfile({ table, row }: { table: Dataset; row: Row }) {
  if (!Object.hasOwn(definitions, table.id)) return null;
  // The ordinary catalog binds metadata to the exact family generation and
  // physical schema. Consume that decision; do not promote stale definitions or
  // replace the existing producer-side whole-file FEC metadata identity check.
  let unavailable = table.metadataState !== 'current'
    ? 'Current matching table metadata is unavailable for this publication.' : undefined;
  if (!unavailable) {
    const mismatch = Object.entries(definitions[table.id]).find(([field, expected]) =>
      typeof expected === 'string' ? row[field] !== expected : !expected.includes(row[field] as string));
    if (mismatch) unavailable = `The record’s ${definitionLabels[mismatch[0]]} is missing or unsupported by this reader.`;
    if (!unavailable && table.id === 'sector_financial_comparisons' &&
      (typeof row.source_family !== 'string' || !Object.hasOwn(sectorBases, row.source_family) || row.amount_basis !== sectorBases[row.source_family])) {
      unavailable = 'The record’s source and amount basis are missing or unsupported by this reader.';
    }
  }
  if (unavailable) return <section className="financial-profile" aria-label="FEC research interpretation">
    <h2>FEC research interpretation</h2>
    <p role="status">The interpretation is unavailable. {unavailable} See the raw fields below.</p>
  </section>;
  if (table.id === 'sector_financial_comparisons') {
    return <section className="financial-profile" aria-label="Sector comparison">
      <h2>{text(row.sector_label)}</h2>
      <p>{text(row.source_family)} · {text(row.measure)} · {money(row.known_reported_amount)}</p>
      <p>Known selected observations, {text(row.period_start)} through {text(row.period_end)}. {text(row.amount_status)}.</p>
      <p>{text(row.qualified_measure_profiles)} qualified amounts among {text(row.group_profiles)} profiles in this group; {text(row.unresolved_measure_profiles)} remain unresolved.</p>
      <p>Source population: {text(row.population_profiles)} profiles; {text(row.classified_population_profiles)} classified, {text(row.unclassified_population_profiles)} unclassified, {text(row.uncertain_population_profiles)} uncertain.</p>
      <p>NAICS 2022 · mapping {text(row.mapping_version)} · policy {text(row.policy_version)} · cutoff {text(row.cutoff)}. Industry context is separate from lobbying issue codes.</p>
      {source(row)}
    </section>;
  }
  if (table.id === 'sector_classification_evidence') {
    return <section className="financial-profile" aria-label="Sector classification evidence">
      <h2>Sector classification evidence</h2>
      <p>{text(row.source_namespace)} · {text(row.native_entity_id)} · {text(row.classification_status)}</p>
      <p>Method: {text(row.method)}. Applies {text(row.applicable_start)} through {text(row.applicable_end)}; observed {text(row.observed_at)}.</p>
      <p>{text(row.uncertainty)}</p>
      <p>Industry assignments do not establish a same-organization link across sources.</p>
    </section>;
  }
  if (table.id === 'lobbying_issue_financial_observations') {
    return <section className="financial-profile" aria-label="Issue-filtered filing amounts">
      <h2>Issue-filtered filing amounts</h2>
      <p>Reported issue {text(row.issue_code)} · filing {text(row.filing_uuid)}</p>
      <p>Registrant income: {money(row.income)}. In-house expenses: {money(row.expenses)}.</p>
      <p>{text(row.overlap_note)}</p>
      {source(row)}
    </section>;
  }
  if (table.id === 'fec_committee_relationship_profiles') {
    const relationships = objects(row.relationships_json);
    return <section className="financial-profile" aria-label="Disclosed committee relationships">
      <h2>Disclosed committee relationships</h2>
      <p>{text(row.committee_name)} · {text(row.committee_id)}</p>
      <p>Each line preserves a source field or array entry. A sponsor link does not establish candidate authorization.</p>
      {relationships ? <ul>{relationships.map((r, i) => <li key={i}>
        <strong>{relations[String(r.relationship_type)] ?? text(r.relationship_type)}:</strong>{' '}
        {r.object_name ? text(r.object_name) : null}{r.object_id ? <> · {candidateLink(r)}</> : null}
        {' '}({labels[String(r.value_status)] ?? text(r.value_status)}{!r.object_id && r.object_name && r.value_status === 'reported' ? '; identity unresolved' : ''})
      </li>)}</ul> : <p role="status">Relationship evidence could not be read.</p>}
      <p>Observed {text(row.captured_at)}. {text(row.relationship_effective_date_status)}.</p>
      {source(row)}
    </section>;
  }
  if (table.id === 'fec_contribution_profiles') {
    const breakdown = objects(row.breakdown_json);
    return <section className="financial-profile" aria-label="Contribution breakdown">
      <h2>{row.contribution_family === 'pac' ? 'PAC contributions' : 'Individual contributions'}</h2>
      <p>Recipient committee {text(row.committee_id)} · candidate {text(row.candidate_id)} · cycle {text(row.source_cycle)}</p>
      <p>Report {text(row.filing_id)}, {text(row.period_start)} through {text(row.period_end)}.</p>
      <dl className="financial-profile-measures">
        {[
          ['gross_itemized_receipts', 'Positive itemized receipts'],
          ['negative_receipt_adjustments', 'Negative receipt adjustments'],
          ['signed_itemized_receipts', 'Signed itemized receipts'],
          ['itemized_refunds', 'Itemized refunds'], ['net_itemized_flow', 'Net itemized flow'],
          ['unitemized_receipts', 'Separately reported unitemized receipts'],
          ['net_reported_family', 'Net including the reported unitemized amount'],
        ].map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{money(row[key])}</dd></div>)}
      </dl>
      <p>{text(row.included_records)} included records; {text(row.memo_records)} memo records excluded.</p>
      <p>{row.contribution_family === 'pac' ? 'Signed itemized receipts by source PAC ID.' : 'Signed itemized receipts by reported contributor state. Employer labels describe donors; they are not employer donations.'}</p>
      {breakdown ? <ul>{breakdown.map((r, i) => <li key={i}>{text(r.source_donor_id ?? r.reported_state)}: {money(r.amount)} · {text(r.records)} records</li>)}</ul>
        : <p role="status">Breakdown evidence could not be read.</p>}
      {source(row)}
    </section>;
  }
  if (table.id === 'fec_outside_spending_profiles' || table.id === 'fec_outside_spending_spenders') {
    return <section className="financial-profile" aria-label="Independent spending">
      <h2>Independent spending {row.support_oppose === 'S' ? 'supporting' : row.support_oppose === 'O' ? 'opposing' : 'with unresolved target'} {text(row.candidate_name)}</h2>
      <p>{money(row.total)} · cycle {text(row.source_cycle)}</p>
      {table.id === 'fec_outside_spending_profiles'
        ? <p>{text(row.reported_spender_count)} identified filers; {text(row.unknown_spender_rows)} rows with unresolved filer identity.</p>
        : <p>{text(row.spender_name)} · {text(row.spender_id)} · {text(row.spender_namespace)}</p>}
      <p>{text(row.period_start)} through {text(row.period_end)}. All elections in this cycle; election-specific totals are unavailable from this aggregate.</p>
      <p>Publisher aggregates omit memo items and 24/48-hour notices. Spender groups reconcile to a separately captured official total.</p>
      {source(row)}
    </section>;
  }
  if (table.id === 'fec_contribution_decisions') {
    return <section className="financial-profile" aria-label="Contribution selection evidence">
      <h2>Contribution selection evidence</h2>
      <p>{text(row.disposition)}: {text(row.disposition_reason)} · {money(row.amount)}</p>
      <p>{text(row.donor_label)} · native donor ID {text(row.donor_id)}. Employer label: {text(row.employer)}.</p>
      <p>Transaction date: {text(row.transaction_date_scope)}. Memo field: {text(row.memo_field_status)}.</p>
      {source(row)}
    </section>;
  }
  if (table.id === 'fec_election_results') {
    const scopeParts = [
      row.office ? text(row.office) : null,
      text(row.state),
      row.district ? `district ${text(row.district)}` : null,
      row.seat_term && row.seat_term !== 'not_applicable' ? `${text(row.seat_term)} term` : null,
      row.party ? text(row.party) : null,
    ].filter(Boolean);
    const voteUnit = row.vote_basis === 'electoral_vote' ? 'electoral votes' : 'votes';
    return <section className="financial-profile" aria-label="Official election result">
      <h2>Official election result</h2>
      <p>{text(row.candidate_name)} · {scopeParts.join(' · ')}</p>
      <p>{text(row.stage)} · {text(row.round)} · {text(row.vote_basis)}</p>
      <p><strong>{row.votes_status === 'exact' ? text(row.votes) : text(row.votes_raw)}</strong> {row.votes_status === 'exact' ? voteUnit : `(${text(row.votes_status)})`}</p>
      <p>{text(row.footnotes)}</p>
      <p>Source: {text(row.source_sheet)}, row {text(row.source_row)}, column {text(row.source_column)}.</p>
      {source(row)}
    </section>;
  }
  return null;
}
