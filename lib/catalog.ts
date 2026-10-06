import { usableNavigation, type Navigation } from './navigation';
import { loadingMetadata, parseMetadata, validDate, type Source, type Join, type MetadataBundle, type MetadataStatus, type TableMetadataState } from "./metadata";
import { DATA_BASE, generationEvidence, type PublicationEvidence } from './publication-evidence';
import { bindExtraTables, extraMetadataMatches } from './separate-publications';
export { publicationDate, tableMetadataMessage, metadataMessage } from "./metadata";
export type { Join, MetadataStatus } from "./metadata";
export { DATA_BASE } from './publication-evidence';
export type Row = Record<string, unknown>;
export type Filter = { column: string; value: string; values?: string[] };
export type Member = { url: string; rows: number; byteSize: number; sha256?: string; etag?: string };
export type CoverageInput = { id: string; url: string; rows: number; byteSize: number; sha256: string; etag: string };
export type Dataset = {
  id: string;
  label: string;
  summary: string;
  coverage: string;
  kind: string;
  quality?: string;
  rows: number;
  bytes: number;
  columns: { name: string; type: string; description: string }[];
  members: Member[];
  coverageInputs?: CoverageInput[];
  published?: string;
  artifactDigest?: string;
  publication?: PublicationEvidence;
  publicationIdentity?: string;
  recordsAvailable?: boolean;
  metadataState: TableMetadataState;
  sources: Source[];
  inputs: string[];
  transformation?: string;
  modelGenerated: boolean;
  emptyReason?: string;
  joinAudit?: { status: string; reason: string };
  connectionNotes: string[];
  receiptIdentity?: string[];
  receiptContainers?: Record<string, string[]>;
  group: string;
  family: string;
};
export const pretty = (s: string) =>
  s.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
export const count = (n: number) => new Intl.NumberFormat("en-US").format(n);
export const compact = (n: number) =>
  new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
export function groupFor(id: string) {
  if (id.startsWith("scorecard")) return "Congress";
  if (
    [
      "diff_summaries",
      "financial_changes",
      "section_classifications",
      "section_diffs",
      "section_diff_items",
      "public_activity_events",
      "crs_reports",
      "press_releases",
      "report_sections",
      "record_issues",
      "treaties",
      "nominations",
      "house_activity_reports",
      "house_communications",
    ].includes(id)
  )
    return "Congress";
  if (/^(laws|law_|table3)/.test(id)) return "Law & courts";
  if (
    /^(bill|congress|member|committee|amendment|cbo|roll_call|vote|hearing)/.test(
      id,
    )
  )
    return "Congress";
  if (/^(fec|campaign|candidate|election)/.test(id)) return "Elections";
  if (/^(us_code|usc|cfr|ecfr|public_law|statute|court|supreme)/.test(id))
    return "Law & courts";
  return "Regulation";
}
export async function loadCatalog(signal?: AbortSignal): Promise<Dataset[]> {
  const response = await fetch(`${DATA_BASE}/publication.v2.json`, {
    signal,
    cache: "no-store",
  });
  if (!response.ok)
    throw new Error(
      `The data catalog could not be reached (${response.status}).`,
    );
  const index = (await response.json()) as {
    version: number;
    families: Record<string, any>;
  };
  if (index.version !== 2 || !index.families)
    throw new Error("The published catalog has an unsupported format.");
  const tables: Dataset[] = [];
  for (const [familyId, family] of Object.entries(index.families) as [string, any][])
    for (const [key, table] of Object.entries(family.tables) as [
      string,
      any,
    ][]) {
      const id = key.replace(/\.parquet$/, "");
      tables.push({
        id,
        family: familyId,
        label: pretty(id), summary: "", coverage: "", kind: "published",
        metadataState: "loading", sources: [], inputs: [], modelGenerated: false, connectionNotes: [], artifactDigest: family.artifactDigest,
        publication: generationEvidence(family.prefix, family.etlReceipts, id),
        rows: table.rows,
        bytes: table.byteSize,
        columns: table.columns.map(([name, type]: string[]) => ({
          name,
          type,
          description: "",
        })),
        members: (table.members ?? [{ key, ...table }]).map((member: any) => ({
          url: `${DATA_BASE}/${family.prefix}/${member.key}`,
          rows: member.rows,
          byteSize: member.byteSize,
          sha256: member.sha256,
        })),
        published: validDate(family.publishedAt),
        group: groupFor(id),
      });
    }
  return tables.sort((a, b) => a.label.localeCompare(b.label));
}
export type Collection = { tables: Dataset[]; joins: Join[]; navigation?: Navigation[]; metadata: MetadataStatus; warnings?: string[]; publicationsPending?: boolean };
export function applyMetadata(tables: Dataset[], bundle: MetadataBundle): Collection {
  const status: MetadataStatus = { ...loadingMetadata, state: "current", generatedAt: bundle.generatedAt };
  const enriched = tables.map((table): Dataset => {
    table = { ...table, connectionNotes: [] };
    const metadata = bundle.tables[table.id];
    if (!metadata) {
      status.missingTables++;
      return { ...table, metadataState: "missing" };
    }
    const separate = table.publication?.kind === 'rulemaking' || table.publication?.kind === 'comments';
    if (metadata.family !== table.family || JSON.stringify(metadata.publicationSchema) !== JSON.stringify(table.columns.map(c => [c.name, c.type])) || separate && !extraMetadataMatches(table, bundle)) {
      status.staleTables++;
      return { ...table, ...(separate ? {recordsAvailable: false, columns: []} : {}), metadataState: "incompatible" };
    }
    const older = separate ? false : !table.artifactDigest || bundle.publication.families[table.family] !== table.artifactDigest;
    if (older) status.staleTables++;
    const undocumented = metadata.metadataStatus === "unknown" || metadata.sourceStatus === "unknown";
    if (undocumented) status.undocumentedTables++;
    return {
      ...table, label: metadata.label || table.label, summary: metadata.summary ?? "", coverage: metadata.coverage ?? "",
      kind: metadata.kind ?? "published", quality: metadata.data_quality, sources: metadata.sources, inputs: metadata.inputs,
      receiptIdentity: metadata.receiptIdentity, receiptContainers: metadata.receiptContainers,
      transformation: metadata.transformation, modelGenerated: metadata.modelGenerated, emptyReason: metadata.emptyReason, joinAudit: metadata.joinAudit,
      metadataState: older ? "older-publication" : undocumented ? "undocumented" : "current",
      columns: table.columns.map(column => ({ ...column, description: metadata.columns?.find(c => c.column_name === column.name)?.description ?? "" })),
    };
  });
  const lookup = new Map(enriched.map(table => [table.id, table]));
  const joins = bundle.joins.filter((join): join is Join => {
    let reason = "This connection has invalid or incomplete keys.";
    const arraysValid = join && typeof join.child === "string" && typeof join.parent === "string" && Array.isArray(join.child_columns) && Array.isArray(join.parent_columns) && join.child_columns.length > 0 && join.child_columns.length === join.parent_columns.length && [...join.child_columns, ...join.parent_columns].every(c => typeof c === "string") && new Set(join.child_columns).size === join.child_columns.length && new Set(join.parent_columns).size === join.parent_columns.length;
    if (arraysValid) {
      const child = lookup.get(join.child), parent = lookup.get(join.parent);
      if (!child || !parent) reason = `Connection to ${pretty(!child ? join.child : join.parent)} is unavailable: that table is not published.`;
      else if ([child, parent].some(t => ["missing", "incompatible"].includes(t.metadataState))) reason = `Connection between ${child.label} and ${parent.label} is paused until metadata matches both tables.`;
      else if (!join.child_columns.every(key => child.columns.some(c => c.name === key)) || !join.parent_columns.every(key => parent.columns.some(c => c.name === key))) reason = `Connection between ${child.label} and ${parent.label} refers to fields that are no longer published.`;
      else return true;
    }
    status.rejectedJoins++;
    for (const id of new Set([join?.child, join?.parent])) {
      const table = lookup.get(id);
      if (table && !table.connectionNotes.includes(reason)) table.connectionNotes.push(reason);
    }
    return false;
  }).map(join => ({ ...join, kind: typeof join.kind === "string" ? join.kind : "declared", reason: typeof join.reason === "string" ? join.reason : "" }));
  for (const omitted of bundle.omittedJoins ?? []) {
    status.omittedJoins++;
    for (const id of new Set([omitted.child, omitted.parent])) {
      const table = lookup.get(id);
      if (!table) continue;
      const target = omitted.child === id ? omitted.parent : omitted.child;
      const reason = lookup.has(target) ? omitted.reason : "That table is not published.";
      const note = `Connection to ${pretty(target)} is unavailable. ${reason}`;
      if (!table.connectionNotes.includes(note)) table.connectionNotes.push(note);
    }
  }
  if (status.missingTables || status.staleTables || status.undocumentedTables || status.rejectedJoins) status.state = "partial";
  return { tables: enriched.sort((a, b) => a.label.localeCompare(b.label)), joins, navigation: usableNavigation(bundle.navigation ?? [], enriched), metadata: status };
}
export async function loadCollection(signal?: AbortSignal, onCatalog?: (collection: Collection) => void): Promise<Collection> {
  // Begin both requests together. Records can load as soon as the catalog arrives.
  const metadata = fetch(`${DATA_BASE}/explorer-metadata.v1.json`, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000), cache: "no-store",
  }).then(async response => {
    if (!response.ok) throw new Error(`Metadata could not be reached (${response.status}).`);
    return parseMetadata(await response.json());
  }).catch(() => null);
  const separate = import('./source-directory').then(({loadOtherPublications}) => loadOtherPublications(signal)).catch(() => ({tables: [] as Dataset[], warnings: ['Separately published files could not be checked. Reload the catalog to try again.']}));
  const tables = await loadCatalog(signal);
  if (signal?.aborted) throw signal.reason;
  onCatalog?.({ tables, joins: [], metadata: loadingMetadata, publicationsPending: true });
  const [bundle, others] = await Promise.all([metadata, separate]);
  if (signal?.aborted) throw signal.reason;
  const extra = await bindExtraTables(others.tables.filter(table => !tables.some(main => main.id === table.id)), bundle);
  if (signal?.aborted) throw signal.reason;
  const combined = [...tables, ...extra];
  const collection = bundle ? applyMetadata(combined, bundle) : {tables: combined.map(table => ({...table, metadataState: 'unavailable' as const})), joins: [], metadata: {...loadingMetadata, state: 'unavailable' as const}};
  return {...collection, warnings: others.warnings, publicationsPending: false};
}
export function display(value: unknown): string {
  if (value == null) return "—";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object")
    return JSON.stringify(value, (_, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
  return String(value);
}
export function joinTarget(join: Join, id: string) {
  return join.child === id && join.direction !== 'incoming'
    ? { id: join.parent, local: join.child_columns, remote: join.parent_columns }
    : { id: join.child, local: join.parent_columns, remote: join.child_columns };
}
export function connectionLabel(join: Join, targetLabel: string): string {
  if (join.child !== join.parent) return targetLabel;
  if (join.child === 'amendments') return join.direction === 'incoming' ? 'Amendments modifying this amendment' : 'Amendment being amended';
  if (join.child === 'committees') return join.direction === 'incoming' ? 'Committees under this committee' : 'Parent committee';
  return join.direction === 'incoming' ? 'Records referencing this record' : 'Referenced record';
}
export function connectionFilters(join: Join, id: string, row: Row): Filter[] | null {
  if (id !== join.child && id !== join.parent) return null;
  const target = joinTarget(join, id);
  if (target.local.some(key => row[key] == null || row[key] === '' || !['string', 'number', 'bigint', 'boolean'].includes(typeof row[key]))) return null;
  return target.remote.map((column, i) => ({ column, value: display(row[target.local[i]]) }));
}
export function noConnectionsMessage(table?: Dataset): string | undefined {
  if (table?.connectionNotes.length) return undefined; // Show the specific unavailable-parent notes instead.
  if (table && ["loading", "missing", "incompatible", "unavailable"].includes(table.metadataState)) return "Connections are unavailable until this table’s metadata is ready.";
  return table?.joinAudit?.status !== "connected" && table?.joinAudit?.reason || "No supported connections are declared for this dataset.";
}
export function related(id: string, joins: Join[]) {
  return joins.flatMap(j => j.child === id && j.parent === id ? [{...j, direction: undefined}, {...j, direction: 'incoming' as const}] : j.child === id || j.parent === id ? [j] : []);
}
export function defaultColumns(table: Dataset): string[] {
  const preferred: Record<string, string[]> = {
    congress_bills: [
      "bill_id",
      "title",
      "origin_chamber",
      "introduced_date",
      "sponsor_full_name",
      "sponsor_bioguide_id",
    ],
    amendments: ["amendment_id", "purpose", "chamber", "amended_bill_id", "amended_amendment_id", "sponsor_bioguide_id"],
    members: [
      "bioguide_id",
      "name_first",
      "name_last",
      "current_term_state",
      "current_term_party",
      "roster",
    ],
    dockets: ["docket_id", "title", "agency_code", "docket_type", "rin"],
    federal_register: [
      "document_number",
      "title",
      "document_type",
      "publication_date",
      "agency_slugs",
    ],
  };
  return (
    preferred[table.id] ?? table.columns.slice(0, 6).map((c) => c.name)
  ).filter((n) => table.columns.some((c) => c.name === n));
}
