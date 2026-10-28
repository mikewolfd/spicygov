import { publicationDate, supportingSection, type Dataset } from "./catalog";
import { catalogPurpose, catalogTitle } from "./catalog-copy";
import type { CatalogCollection, CatalogPeriod, CatalogFile } from "./source-catalog";
import {
  sourceMetadataMessage,
  publisherAttribution,
  type SourceEntry,
} from "./source-directory";

export type BrowserView = "available" | "catalog" | "attention";
export type BrowserDataState = "pending" | "unavailable" | "ready";
/** Gaps combines both inputs; a failed or pending input cannot prove an empty result. */
export function browserDataState(view: BrowserView, catalog: BrowserDataState, publications: BrowserDataState): BrowserDataState {
  const required = view === "catalog" ? [catalog] : view === "available" ? [publications] : [catalog,publications];
  return required.includes("unavailable") ? "unavailable" : required.includes("pending") ? "pending" : "ready";
}
export type BrowserLocation = {
  view: BrowserView;
  query: string;
  topic: string;
  availability: string;
  period: string;
  includeUnknown: boolean;
  page: number;
  table?: string;
  collection?: string;
};
export const pageSize = 20;
export const normalizeSearch = (value: string) =>
  value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();

/** Titles outrank publishers, which outrank incidental mentions in descriptions. */
export function searchRank(
  query: string,
  title: string,
  publisher = "",
  description = "",
): number {
  const q = normalizeSearch(query);
  if (!q) return 1;
  const name = normalizeSearch(title),
    source = normalizeSearch(publisher);
  if (name === q) return 100;
  if (name.startsWith(q)) return 80;
  if (name.includes(q)) return 60;
  if (source.includes(q)) return 40;
  const words = q.split(" "),
    text = normalizeSearch(`${title} ${publisher} ${description}`);
  return words.every((word) => text.includes(word)) ? 10 : 0;
}

export function collectionAvailability(
  item: CatalogCollection,
  tables: ReadonlySet<string>,
) {
  // A listed destination is a navigation link, never proof of current source lineage.
  if (item.tables.some((id) => tables.has(id)))
    return { id: "linked", label: "Has published data" };
  if (item.holdings.objects > 0) return { id: "held", label: "Files saved" };
  if (item.statuses.includes("external-by-choice"))
    return { id: "external", label: "Stored elsewhere" };
  if (item.statuses.includes("receipt-only"))
    return { id: "receipts", label: "Download records only" };
  if (item.holdings.missing > 0 || item.statuses.includes("missing-bytes"))
    return { id: "missing", label: "Files missing" };
  if (item.statuses.includes("known-not-acquired"))
    return { id: "uncollected", label: "Not downloaded" };
  return { id: "unknown", label: "Files not confirmed" };
}
export function collectionAttention(
  item: CatalogCollection,
): string | undefined {
  if (item.holdings.missing > 0)
    return `${item.holdings.missing.toLocaleString()} recorded files missing`;
  if (item.statuses.includes("missing-bytes")) return "Source files missing";
  if (item.statuses.includes("refused-source")) return "Saved source response was refused or reports an error";
  if (item.statuses.some(status => ["parse-error", "failed-response"].includes(status))) return "Saved source response could not be used as data";
  if (item.statuses.includes("incomplete-response")) return "Saved source response is incomplete";
  if (item.statuses.some(status => ["partial", "partial-source"].includes(status))) return "Saved source coverage is partial";
  if (item.statuses.includes("conflicting-receipt")) return "Saved receipt evidence disagrees";
  if (item.statuses.includes("conflicting-metadata")) return "Saved source descriptions disagree";
  if (item.statuses.includes("known-not-acquired")) return "Source not downloaded";
  return undefined;
}
function collectionInformation(item: CatalogCollection): string | undefined {
  if (item.statuses.includes("unclassified-source")) return "Saved file content has not been classified";
  if (item.statuses.includes("integration-unresolved"))
    return "Connection to published data needs checking";
  if (item.statuses.includes("receipt-only"))
    return "Download records saved; original files not confirmed";
  if (item.statuses.includes("inventory-unresolved"))
    return "Source files not linked to this entry";
  if (item.statuses.includes("published-with-baseline"))
    return "Some published records still depend on an earlier saved dataset";
  return undefined;
}
export function collectionDownload(item: CatalogCollection): string {
  if (item.holdings.objects > 0) return "Downloaded files available";
  if (item.statuses.includes("known-not-acquired")) return "Not downloaded";
  if (item.statuses.includes("external-by-choice")) return "Stored elsewhere";
  if (item.statuses.includes("receipt-only")) return "Download records only";
  return "Downloads not confirmed";
}
export function matchesCollectionAvailability(item: CatalogCollection, filter: string, tables: ReadonlySet<string>): boolean {
  if (!filter) return true;
  if (filter === "held") return item.holdings.objects > 0;
  if (filter === "uncollected") return item.statuses.includes("known-not-acquired");
  if (filter === "missing") return item.holdings.missing > 0 || item.statuses.includes("missing-bytes");
  if (filter === "review") return !!collectionAttention(item);
  return collectionAvailability(item, tables).id === filter;
}
export function collectionLimitation(item: CatalogCollection): string {
  return collectionAttention(item) || collectionInformation(item) || "Full source coverage has not been confirmed";
}
export function tableLimitation(entry: SourceEntry): string {
  return tableAttention(entry) || entry.review?.copy?.gaps[0] || sourceMetadataMessage(entry.table.metadataState) ||
    "Full source coverage has not been confirmed";
}
export function tableScope(entry: SourceEntry): string | undefined {
  return entry.review?.copy?.scope.trim() ||
    (entry.table.metadataState === "current" ? entry.table.coverage.trim() || undefined : undefined);
}
export function tableAttention(entry: SourceEntry): string | undefined {
  if (entry.table.rows === 0) return "No records published";
  if (entry.explorer && entry.table.metadataState === "incompatible") return "Source notes refer to different fields";
  if (entry.explorer && entry.table.metadataState === "unavailable") return "Current source descriptions could not be loaded";
  return undefined;
}
export function collectionTopic(
  item: CatalogCollection,
  tables: Dataset[],
): string {
  const topics = [
    ...new Set(
      tables
        .filter(
          (table) =>
            item.tables.includes(table.id) ||
            item.families.includes(table.family),
        )
        .map((table) => table.group),
    ),
  ];
  return topics.length === 1 ? topics[0] : "Other sources";
}
export function relatedCollections(
  table: Dataset,
  collections: CatalogCollection[],
) {
  return collections.filter((item) => item.tables.includes(table.id));
}
export function uniquePeriods(periods: CatalogPeriod[]): CatalogPeriod[] {
  return [
    ...new Map(
      periods.map((period) => [JSON.stringify(period), period]),
    ).values(),
  ];
}
export function periodSummary(item: CatalogCollection): string {
  if (item.periodSummary) {
    return item.periodSummary.observedRetained
      ? `${periodRange(item.periodSummary.observedRetained)} · saved records`
      : item.periodSummary.count ? "See dates in source details" : "Dates not confirmed";
  }
  const observed = uniquePeriods(item.periods ?? []).filter(
    (period) => period.kind === "observed-retained-scope" && period.start,
  );
  if (observed.length === 1)
    return `${periodRange(observed[0])} · saved records`;
  return item.periods?.length
    ? "See dates in source details"
    : "Dates not confirmed";
}
export function periodLabel(period: Partial<CatalogPeriod>): string {
  const basis = `${period.kind} ${period.basis}`;
  if (basis.includes("requested-scope")) return "Dates we asked for";
  if (period.kind === "documented-publisher-scope")
    return "Dates offered by the publisher";
  if (period.kind === "observed-retained-scope")
    return "Dates found in saved records";
  return period.kind?.replaceAll("-", " ").replace(/^./, (c) => c.toUpperCase()) || "Recorded scope";
}
export const deliveryLabels: Record<string, string> = {
  "query-api": "Online data service (API)",
  api: "Online data service (API)",
  bulk: "Bulk download",
  archive: "Historical archive",
  file: "Source file",
  feed: "Update feed",
  "web-page": "Web page",
  crawl: "Web collection",
};
export function tablePublisherAttribution(entry: SourceEntry) {
  const { sources, freshness } = publisherAttribution(entry);
  return { names: [...new Set(sources.map(source => source.name.trim()).filter(Boolean))], freshness };
}
export function tablePublisherNames(entry: SourceEntry): string[] {
  return tablePublisherAttribution(entry).names;
}
export function tablePublisher(entry: SourceEntry) {
  const names = tablePublisherNames(entry);
  return names.length > 1 ? "Multiple publishers" : names[0] || "Publisher not recorded";
}
export function recordEntries(entries: SourceEntry[]) {
  return entries.filter((entry) => !supportingSection(entry.table));
}

export function readBrowserLocation(search: string): BrowserLocation {
  const params = new URLSearchParams(search),
    view = params.get("view");
  return {
    view: view === "catalog" || view === "attention" ? view : "available",
    query: params.get("q") || "",
    topic: params.get("topic") || "",
    availability: params.get("availability") || "",
    period: params.get("period") || "",
    includeUnknown: params.get("unknown") !== "exclude",
    page: Math.max(
      1,
      Math.min(10000, Number.parseInt(params.get("page") || "1", 10) || 1),
    ),
    table: params.get("table") || undefined,
    collection: params.get("collection") || undefined,
  };
}
export function browserSearch(state: BrowserLocation): string {
  const p = new URLSearchParams();
  if (state.view !== "available") p.set("view", state.view);
  if (state.query) p.set("q", state.query);
  if (state.topic) p.set("topic", state.topic);
  if (state.availability) p.set("availability", state.availability);
  if (state.period) p.set("period", state.period);
  if (state.includeUnknown === false) p.set("unknown", "exclude");
  if (state.page > 1) p.set("page", String(state.page));
  if (state.table) p.set("table", state.table);
  else if (state.collection) p.set("collection", state.collection);
  return p.size ? `?${p}` : "";
}

/** Preserve uncertainty: an absent end date is not evidence of continuing coverage. */
export function periodRange(period: CatalogPeriod): string {
  const date = (value: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(value) ? publicationDate(value) : value;
  if (!period.start) {
    if (period.label?.includes("scope disagreement")) return "Publisher descriptions give different date ranges. See the original notes.";
    if (period.kind !== "unknown" && period.label?.trim() && !/^unknown$/i.test(period.label.trim())) return period.label;
    return "Exact dates aren’t recorded here. See the original notes.";
  }
  if (period.end === period.start) return date(period.start);
  return `${date(period.start)}${period.end ? ` – ${date(period.end)}` : " (end date unknown)"}`;
}

/** Keep the first view short; exact native labels remain in source history. */
export function periodPreview(period: CatalogPeriod): string {
  const value = periodRange(period);
  return value.length > 60 ? 'scope recorded; see source details' : value;
}

export function collectionHoldingsSummary(item: CatalogCollection): string {
  if (!item.holdings.objects && item.statuses.includes('inventory-unresolved')) return 'No files linked to this entry yet.';
  return `${item.holdings.objects.toLocaleString()} distinct files saved locally.`;
}

export function collectionTitle(item: CatalogCollection): string {
  const title = catalogTitle(item.id);
  if (title) return title;
  if (item.title.startsWith("Publication: ")) return item.title.slice(13).replaceAll("-", " ").replace(/^./, c => c.toUpperCase());
  if (/^(collection|proof|corpus):/.test(item.title))
    return "Source collection record";
  if (/^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(item.title))
    return item.title
      .replace(/[-_]source[-_]store$/, " source files")
      .replace(/[-_]/g, " ")
      .replace(/^./, (letter) => letter.toUpperCase());
  return item.title;
}

/** Only editorial prose is reworded. Original publisher labels and evidence stay intact. */
export function readableCopy(text: string): string {
  return text
    .replace(/\bAPI records\b/g, "online records")
    .replace(/\bAPIs\b/g, "online services")
    .replace(/\bAPI\b/g, "online service");
}

/** Explain the subject separately from the retained audit narrative. */
export function collectionDescription(item: CatalogCollection, fallback?: string): string {
  return catalogPurpose(item.id) || readableCopy(item.description || fallback ||
    (item.publisher ? `Data and documents from ${item.publisher}.` : "A known source of public records."));
}

/** Keep independent limitations visible even when another state takes priority. */
export function collectionLimitations(item: CatalogCollection): string[] {
  const notes = [collectionLimitation(item)];
  if (item.statuses.some(status => ["parse-error", "failed-response", "refused-source"].includes(status))) notes.push("Some saved responses contain errors or refusals; their presence does not establish usable data.");
  if (item.statuses.includes("external-by-choice") || item.id.includes("comments-mirror") || item.id === "publication:comments") notes.push("The wider source collection is kept elsewhere by choice; local files do not cover all comment bodies or attachments.");
  if (item.statuses.includes("partial")) notes.push("The saved source collection is partial.");
  if (item.tables.includes("sam_entities")) notes.push("Registration years describe registrations, not historical snapshots of the database.");
  if (item.description?.startsWith("A baseline preserves") || item.description?.startsWith("Source integrity is checked")) notes.push("Saved source files alone have not been shown to reproduce every published record.");
  return [...new Set(notes)];
}

export function fileAvailabilitySummary(file: CatalogFile): string {
  if (file.status === "missing-bytes" && !file.provenance) return "Referenced original bytes are missing locally.";
  const content: Record<string, string> = {
    "parse-error": "Saved response could not be read; usable content has not been confirmed.",
    "refused-source": "Saved response records a refusal or source error; it is not usable data.",
    "failed-response": "Saved response records a failed request; usable data is not confirmed.",
    "incomplete-response": "Saved response is incomplete; usable data is not confirmed.",
    "partial-source": "Saved source content is partial.",
    "unclassified-source": "Saved content has not been classified; usable data is not confirmed.",
    "conflicting-receipt": "Saved receipt evidence disagrees; the file’s origin needs review.",
    "conflicting-metadata": "Saved metadata records disagree; the source information needs review.",
  };
  const contentNote = content[file.status];
  let availability: string;
  switch (file.provenance?.availability) {
    case "local": availability = contentNote ? "Bytes saved locally." : "Saved locally; usable content has not been confirmed."; break;
    case "missing": availability = "Referenced file is missing locally."; break;
    case "external": availability = "File kept elsewhere by choice."; break;
    case "not-acquired": availability = "Known file; download not recorded."; break;
    default: availability = file.status === "held" ? "Recorded as saved; file availability is not checked in this export." : "File availability is unknown; see the recorded evidence.";
  }
  return contentNote ? `${contentNote} ${availability}` : availability;
}
