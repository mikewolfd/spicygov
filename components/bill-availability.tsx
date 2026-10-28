import { useState } from 'react';
import { count } from '../lib/catalog';
import type { BillAvailability } from '../lib/coverage-map';

export function BillAvailabilitySummary({ availability }: { availability: BillAvailability }) {
  const [congress, setCongress] = useState('all');
  const selected = availability.byCongress[congress] ?? availability;
  const percent = (n: number) => selected.total ? `${(100 * n / selected.total).toFixed(1)}%` : '—';
  return <section className="bill-availability" aria-label="Bills with policy areas and subjects">
    <label>Congress <select value={congress} onChange={event => setCongress(event.target.value)}>
      <option value="all">All Congresses</option>
      {Object.keys(availability.byCongress).sort((a, b) => Number(b) - Number(a)).map(key =>
        <option key={key} value={key}>{key === 'unknown' ? 'Congress not recorded' : `Congress ${key}`}</option>)}
    </select></label>
    <dl>
      <div><dt>With a policy area</dt><dd>{percent(selected.policyAreas)} <small>{count(selected.policyAreas)} bills</small></dd></div>
      <div><dt>With subjects</dt><dd>{percent(selected.subjects)} <small>{count(selected.subjects)} bills</small></dd></div>
    </dl>
    <p>Of {count(selected.total)} bills and resolutions in our collection{congress !== 'all' && congress !== 'unknown' ? ` for Congress ${congress}` : ''}.</p>
  </section>;
}
