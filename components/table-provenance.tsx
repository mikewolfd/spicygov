import { pretty, type Dataset } from '../lib/catalog';
export function TableProvenance({ table, catalog }: { table: Dataset; catalog: Dataset[] }) {
  return <div className="table-provenance">
    <p className="table-source-links"><strong>Source{table.sources.length === 1 ? '' : 's'}</strong>{table.sources.length ? table.sources.map(source => <span key={source.id}>
      {source.url ? <a href={source.url} target="_blank" rel="noreferrer">{source.name} ↗</a> : source.name}
      {source.kind !== 'unknown' && <small>{source.kind.replaceAll('_', ' ')}</small>}
      {source.note && <span className="provenance-source-note">{source.note}</span>}
    </span>) : <span>Not yet documented</span>}</p>
    {table.modelGenerated && <p className="model-label">Model-generated content · Check against the source records.</p>}
    {table.transformation && <p>{table.transformation}</p>}
    {table.inputs.length > 0 && <p className="table-input-links"><strong>Inputs</strong>{table.inputs.map(id => {
      const input = catalog.find(candidate => candidate.id === id);
      return input ? <a key={id} href={`/?table=${encodeURIComponent(id)}&view=about`}>{input.label}</a> : <span key={id}>{pretty(id)} <small>(not published)</small></span>;
    })}</p>}
  </div>;
}
