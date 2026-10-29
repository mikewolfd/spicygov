import { useId, useState } from "react";
import type { CatalogFile, CatalogRoute } from "../lib/source-catalog";
import { fileAvailabilitySummary, periodLabel } from "../lib/source-browser";
import { CatalogFileEvidence, catalogFileMirrorLocation } from "./catalog-file-evidence";
import { archiveKeyListed, mirrorInventoryDate, type ArchiveMirror } from '../lib/archive-mirror';

/** Search is deliberately limited to metadata already loaded for this file page. */
export function matchingCatalogFiles(files: CatalogFile[], query: string): CatalogFile[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return terms.length ? files.filter(file => {
    const text = [file.name, file.sourceId, file.sourceVersion, file.status,
      ...(file.periods ?? []).flatMap(period => [period.label, period.start, period.end]),
      ...(file.metadataConflicts ?? [])].filter(Boolean).join(" ").toLocaleLowerCase();
    return terms.every(term => text.includes(term));
  }) : files;
}

function fileConflictSummary(file: CatalogFile): string | undefined {
  const conflicts = (file.metadataConflicts ?? []).filter(field =>
    !field.endsWith("-withheld") && !["receipt-reference-unavailable", "capture-time-invalid-or-unsupported", "transport"].includes(field));
  if (!conflicts.length) return;
  if (conflicts.some(field => ["periods", "acquired_at", "capture-time-conflict"].includes(field))) return "Recorded dates disagree. Check the source evidence.";
  return "Source details disagree. Check the source evidence.";
}

export function CatalogFileList({ files, routes = [], mirror }: { files: CatalogFile[]; routes?: CatalogRoute[]; mirror?: ArchiveMirror }) {
  const [query, setQuery] = useState("");
  const [visible, setVisible] = useState(50);
  const searchId = useId();
  const matching = matchingCatalogFiles(files, query);
  return <div className="catalog-file-browser">
    <label htmlFor={searchId}>Search this loaded page</label>
    <input id={searchId} type="search" value={query} placeholder="File name, source, or year…"
      onChange={event => { setQuery(event.target.value); setVisible(50); }} />
    <p className="detail-caption" aria-live="polite">{matching.length.toLocaleString()} of {files.length.toLocaleString()} file references on this page. Search covers this page only.</p>
    <p className="detail-caption">{mirror ? `Public archive inventory checked ${mirrorInventoryDate(mirror)}.` : 'Files are saved locally. Public copies may lag behind this catalog.'}</p>
    <ul className="source-file-list catalog-files">{matching.slice(0, visible).map(file => {
      const download = catalogFileMirrorLocation(file);
      const listed = archiveKeyListed(mirror,file.contentKey);
      const conflict = fileConflictSummary(file);
      const route = routes.find(item => item.id === file.routeId);
      const periods = (file.periods ?? []).filter(period => period.kind !== "unknown").map(period => {
        const range = [...new Set([period.start, period.end].filter(Boolean))].join(" – ");
        const value = [period.label, range && range !== period.label ? range : undefined].filter(Boolean).join(": ");
        return value ? `${periodLabel(period)}: ${value}` : "";
      }).filter(Boolean);
      return <li key={file.id}>
        <h3>{file.name}</h3>
        {periods.length > 0 && <p>{periods.slice(0,3).join(" · ")}{periods.length > 3 && ` · +${periods.length - 3} in details`}</p>}
        {route && <p>{route.label}</p>}
        {!(file.status === "held" && file.provenance?.availability === "local") && <p>{fileAvailabilitySummary(file)}</p>}
        {conflict && <p className="context-note" role="alert">{conflict}</p>}
        {download && <a className="text-button" href={download} title={listed ? 'Listed in the checked archive inventory' : 'Public availability has not been checked'} target="_blank" rel="noreferrer">{listed ? 'Open archive copy' : 'Try public copy'}{file.contentKey?.endsWith(".gz") ? " (.gz)" : ""} ↗</a>}
        <CatalogFileEvidence file={file} mirror={mirror} />
      </li>;
    })}</ul>
    {!matching.length && <p>No files on this page match your search.</p>}
    {visible < matching.length && <button className="text-button" onClick={() => setVisible(visible + 50)}>Show more files on this page</button>}
  </div>;
}
