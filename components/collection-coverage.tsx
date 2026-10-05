import { useState } from 'react';
import { count, type Dataset } from '../lib/catalog';
import { currentCollectionEvidence, collectionOutcomeLabels } from '../lib/collection-coverage';
import { currentTimeCoverage, type TimeInventory } from '../lib/time-coverage';

export function CollectionCoverage({ table, inventory, year }: { table: Dataset; inventory?: TimeInventory; year: number }) {
  const [selected, setSelected] = useState('');
  const raw = inventory?.tables[table.id]?.collectionEvidence;
  const evidence = currentCollectionEvidence(table, currentTimeCoverage(table, inventory)?.collectionEvidence);
  if (!raw) return null;
  if (!evidence) return <p className="table-note">Collection links need recounting for this release.</p>;
  if (evidence.status === 'unknown') return <p className="table-note">{evidence.reason ?? 'The retained collection input could not be matched.'}</p>;
  const cycles = Array.from({length: Math.min(12, year)}, (_, i) => String(Math.max(1, year - 11) + i).padStart(4, '0'));
  const hasCycles = Object.keys(evidence.cycleRows ?? {}).length > 0;
  return <div className="table-collections">
    {evidence.queryResults && <div className="request-checks"><p className="time-caption"><strong>Request checks</strong></p>
      <ul>{evidence.queryResults.map((result, i) => <li key={i}><strong>{count(result.records)} records</strong> · {result.reason}<span className="table-note">{result.status === 'refused_native_observation_not_qualified_empty_success' ? 'Unqualified result; an empty response does not establish no source records.' : result.status.replaceAll('_', ' ')}</span></li>)}</ul>
    </div>}
    {hasCycles && <><p className="time-caption"><strong>Source cycles</strong> · ● Rows present · — No rows carrying this cycle</p>
      <div className="time-grid">{cycles.map(cycle => {
        const rows = evidence.cycleRows?.[cycle] ?? 0, text = `Source cycle ${cycle}: ${count(rows)} rows`;
        return <button type="button" key={cycle} className={`time-cell time-${rows > 0 ? 'present' : 'empty'}`} title={text} aria-label={text} onClick={() => setSelected(`${year}|${text}`)}><span>{cycle}</span><i aria-hidden="true">{rows > 0 ? '●' : '—'}</i></button>;
      })}</div>
      {selected.startsWith(`${year}|`) && <p className="time-selection" role="status">{selected.split('|')[1]}</p>}
      <p className="time-caption">Cycles label the collected source scope; record dates can fall outside them.{(evidence.unscopedRows ?? 0) > 0 && ` ${count(evidence.unscopedRows ?? 0)} rows have no recorded cycle.`}</p>
    </>}
    {!hasCycles && <p className="time-caption">No source cycle is recorded on these rows.</p>}
    <p className="time-caption"><strong>Collection links</strong> · {count(evidence.matchedRows ?? 0)} of {count(table.rows)} rows match {count(evidence.collections ?? 0)} retained collection records.</p>
    {(evidence.unmatchedRows ?? 0) > 0 && <p className="table-note">{count(evidence.unmatchedRows ?? 0)} rows have no matching collection in the recorded input.</p>}
    <details><summary>Inputs and collection results</summary>
      <p>Matched using this table’s retained release. Results describe the collections referenced by its rows; empty or refused requests that produced no rows need separate evidence.</p>
      <dl className="collection-breakdown">{Object.entries(evidence.outcomes ?? {}).map(([outcome, n]) => <div key={outcome}><dt>{collectionOutcomeLabels[outcome]?.[0] ?? outcome.replaceAll('_', ' ')}</dt><dd>{count(n)}</dd></div>)}</dl>
      <p>Retained source families:</p><ul>{Object.entries(evidence.sources ?? {}).map(([source, value]) => <li key={source}>{source.replace(/^fec[_-]/, '').replaceAll('_', ' ').replaceAll('-', ' ')} · {count(value.collections)} collections · {count(value.rows)} rows</li>)}</ul>
    </details>
  </div>;
}
