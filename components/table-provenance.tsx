import { pretty, type Dataset } from '../lib/catalog';
export function TableProvenance({ table, catalog, compact = false }: { table: Dataset; catalog: Dataset[]; compact?: boolean }) {
  return <div className="table-provenance">
    <p className="table-source-links"><strong>Source{table.sources.length === 1 ? '' : 's'}</strong>{table.sources.length ? table.sources.map(source => <span key={source.id}>
      {source.url ? <a href={source.url} target="_blank" rel="noreferrer">{source.name} ↗</a> : source.name}
      {!compact && source.kind !== 'unknown' && <small>{source.kind.replaceAll('_', ' ')}</small>}
      {!compact && source.note && <span className="provenance-source-note">{source.note}</span>}
    </span>) : <span>Not yet documented</span>}</p>
    {!compact && table.modelGenerated && <p className="model-label">Model-generated content · Check against the source records.</p>}
    {!compact && table.transformation && <p>{table.transformation}</p>}
    {table.inputs.length > 0 && <p className="table-input-links"><strong>{compact ? 'Uses these tables' : 'Inputs'}</strong>{table.inputs.map(id => {
      const input = catalog.find(candidate => candidate.id === id);
      const separate = input?.recordsAvailable === false;
      return input ? <a key={id} href={separate ? input.members[0]?.url : `/?table=${encodeURIComponent(id)}&view=about`} target={separate ? '_blank' : undefined} rel={separate ? 'noreferrer' : undefined}>{input.label}{separate ? ' (Parquet) ↗' : ''}</a> : <span key={id}>{pretty(id)} <small>(not in this catalog)</small></span>;
    })}</p>}
  </div>;
}
