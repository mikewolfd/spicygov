import type { ReactNode } from 'react';
import type { Dataset, Filter, Row } from '../lib/catalog';
import { display, pretty } from '../lib/catalog';
import { makeHref } from '../lib/explorer-location';
import { completeIdentity } from '../lib/record-lookup';
import { targetKeys, type Connection, type Navigation } from '../lib/navigation';
import { LOBBYING_TABLES } from '../lib/lobbying-navigation';

type Props = {
  table: Dataset; row: Row; catalog: Dataset[]; bodyNavigation?: Navigation;
  onOpen: (id: string, filters: Filter[], connection?: Connection, detail?: boolean) => void;
};
const scalar = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 || typeof value === 'bigint' ||
  typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : undefined;
const stated = (value: unknown) => value == null ? 'Not stated (null)' : value === '' ? 'Empty source text' : display(value);
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Filing disclosures only: source IDs and positions are not resolved people. */
export function LobbyingProfile({ table, row, catalog, bodyNavigation, onOpen }: Props) {
  if (!LOBBYING_TABLES.includes(table.id)) return null;
  if (table.metadataState !== 'current') return <section className="lobbying-profile" aria-label="Lobbying disclosure">
    <h2>Lobbying disclosure</h2><p role="status">The disclosure definition is unavailable for this publication. See the raw fields below.</p>
  </section>;
  const filing = table.id === 'lobbying_filings', activity = table.id === 'lobbying_activities';
  function link(id: string, values: Row, label: string, detail = false): ReactNode {
    const target = catalog.find(t => t.id === id);
    const filters = Object.entries(values).map(([column, value]) => ({ column, value: scalar(value) }));
    if (!target || target.metadataState !== 'current' || target.recordsAvailable === false ||
      filters.some(f => f.value === undefined || !target.columns.some(c => c.name === f.column))) {
      return <span>{label}: unavailable; a source key or published field is missing.</span>;
    }
    const checked = filters as Filter[];
    const exact = detail && completeIdentity(target, checked);
    return <a href={makeHref({ id, filters: checked, cursor: 0, view: 'records', detail: exact })}
      onClick={e => { if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) { e.preventDefault(); onOpen(id, checked, undefined, exact); } }}>{label}</a>;
  }
  function bodies() {
    const values = row.government_entities;
    return <section aria-label="Contacted bodies">
      <h3>Reported contacted bodies</h3>
      {!Array.isArray(values) ? <p>{values == null ? 'Contacted-body list not stated (null).' : 'Contacted-body list has an unsupported shape; see the raw fields.'}</p>
        : !values.length ? <p>The source lists no contacted bodies.</p>
          : <ol>{values.map((value, index) => {
            const body = object(value) ? value : {};
            const target = bodyNavigation?.targets[0];
            const keys = target && targetKeys(target, body, row);
            const connection = bodyNavigation && keys && target?.available ? { id: bodyNavigation.id, target: 0, values: keys } : undefined;
            return <li key={index}>
              <span>Source position {index}: {stated(body.name)} · LDA body ID {stated(body.id)}</span>
              {connection ? <a href={makeHref({ id: 'lobbying_activities', filters: [], connection, cursor: 0, view: 'records' })}
                onClick={e => { if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) { e.preventDefault(); onOpen('lobbying_activities', [], connection); } }}>Activities listing body {keys![0]}</a>
                : <small>Body lookup unavailable: no supported body ID or selected activity fields.</small>}
              {!object(value) && <small>Unresolved source occurrence: {stated(value)}</small>}
            </li>;
          })}</ol>}
      <p className="lobbying-profile-note">Repeated source entries remain visible. Each lookup returns matching activity rows once, not one row per body or lobbyist. A listed body does not identify an individual contacted official.</p>
    </section>;
  }
  return <section className="lobbying-profile" aria-label="Lobbying disclosure">
    <h2>{filing ? 'Client and filing disclosure' : activity ? 'Lobbying activity disclosure' : 'Lobbyist occurrence and reported public role'}</h2>
    {filing ? <>
      <p><strong>Client: {stated(row.client_name)}</strong> · Client record ID: {stated(row.client_id)}</p>
      <p>Registrant / firm: {stated(row.registrant_name)} · Registrant ID: {stated(row.registrant_id)}</p>
      <p>Reported period: {typeof row.filing_period === 'string' && row.filing_period ? pretty(row.filing_period) : stated(row.filing_period)} {stated(row.filing_year)} · Filing type: {stated(row.filing_type)}</p>
      <p>Posted: {stated(row.dt_posted)}</p>
      <nav aria-label="Filing relationships">
        {link('lobbying_filings', { registrant_id: row.registrant_id, client_id: row.client_id }, 'Client filing history within this registrant')}
        {link('lobbying_filings', { registrant_id: row.registrant_id }, 'Registrant filing history')}
        {link('lobbying_activities', { filing_uuid: row.filing_uuid }, 'Activity records for this filing')}
        {link('lobbying_activity_lobbyists', { filing_uuid: row.filing_uuid }, 'Lobbyist occurrences for this filing')}
      </nav>
      <p className="lobbying-profile-note">Client IDs belong to the reporting registrant. Matching names across firms do not establish the same client. History keeps separate filings and amendments; it does not select a current relationship or combine financial amounts.</p>
      <h3>Reported activities</h3>
      {!Array.isArray(row.lobbying_activities) ? <p>Activity list unavailable; see the activity records and raw fields.</p>
        : !row.lobbying_activities.length ? <p>The source lists no activities.</p>
          : <ol>{row.lobbying_activities.map((value, index) => <li key={index}>
            {object(value) ? <>
              <p>Source position {index}: {stated(value.general_issue_code_display)} · {stated(value.general_issue_code)}</p>
              <p className="source-passage">{stated(value.description)}</p>
              {link('lobbying_activities', { filing_uuid: row.filing_uuid, activity_index: index }, `Open activity ${index}`, true)}
            </> : <p>Unresolved source occurrence at position {index}: {stated(value)}</p>}
          </li>)}</ol>}
      {bodies()}
    </> : <>
      <nav aria-label="Filing context">
        {link('lobbying_filings', { filing_uuid: row.filing_uuid }, 'Supporting filing and registrant', true)}
        {!activity && link('lobbying_activities', { filing_uuid: row.filing_uuid, activity_index: row.activity_index }, 'Supporting activity and contacted bodies', true)}
      </nav>
      {activity ? <>
        <p>Issue: {stated(row.general_issue_code_display)} · {stated(row.general_issue_code)}</p>
        <p className="source-passage">{stated(row.description)}</p>
        <nav aria-label="Activity relationships">
          {link('lobbying_activities', { general_issue_code: row.general_issue_code }, 'Activities with this exact issue code')}
          {link('lobbying_activity_lobbyists', { filing_uuid: row.filing_uuid, activity_index: row.activity_index }, 'Lobbyist occurrences for this activity')}
        </nav>
        {bodies()}
      </> : <>
        <p><strong>{['prefix', 'first_name', 'nickname', 'middle_name', 'last_name', 'suffix'].map(k => scalar(row[k])).filter(Boolean).join(' ') || 'Name not stated'}</strong> · Lobbyist record ID: {stated(row.lobbyist_id)}</p>
        <h3>Reported former public role</h3>
        <p className="source-passage">{stated(row.covered_position)}</p>
        <p className="lobbying-profile-note">Role text is shown as reported in this activity. Missing text does not mean no former role. It does not establish employment dates, current employment, improper influence or a conflict of interest.</p>
        {link('lobbying_activity_lobbyists', { filing_uuid: row.filing_uuid, lobbyist_id: row.lobbyist_id }, 'Occurrences of this lobbyist record within this filing')}
        <p className="lobbying-profile-note">Lobbyist IDs are registrant-local records, not person identities. This link stays within the filing; repeated names or IDs are not merged across firms.</p>
      </>}
    </>}
    <details><summary>Publication scope and evidence</summary>
      <p>Filing: {stated(row.filing_uuid)}{!filing && <> · Activity position: {stated(row.activity_index)}</>}{!filing && !activity && <> · Lobbyist position: {stated(row.lobbyist_index)}</>}</p>
      <p>{table.coverage || 'Coverage dates are not established for this publication.'}</p>
      <p className="lobbying-profile-note">This is a selected, dated publication, not live coverage. Source posting dates remain as reported, including possible anomalies.</p>
      <p>Selected generation: {stated(table.artifactDigest)}</p>
      {table.published && <p>Publication time: {table.published}. This is not the filing’s reporting period.</p>}
      {table.publication?.recordUrl && <a href={table.publication.recordUrl} target="_blank" rel="noreferrer">Selected publication evidence</a>}
      <p className="lobbying-profile-note">The supporting filing is the published native record; an original document URL is not supplied here. Exact-record lookup reports missing or ambiguous matches. History and body searches are bounded and may require Next; an incomplete search is not evidence of absence.</p>
    </details>
  </section>;
}
