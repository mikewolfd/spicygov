import { publicationDate, supportingSection, type Dataset } from "./catalog";
import type { CatalogCollection, CatalogPeriod } from "./source-catalog";
import {
  sourceMetadataNeedsAttention,
  type SourceEntry,
} from "./source-directory";

export type BrowserView = "available" | "catalog" | "attention";
export type BrowserLocation = {
  view: BrowserView;
  query: string;
  topic: string;
  availability: string;
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
  if (item.statuses.includes("parse-error")) return "Source could not be read";
  if (item.statuses.includes("integration-unresolved"))
    return "Connection to published data needs checking";
  if (item.statuses.includes("receipt-only"))
    return "Download records saved; original files not confirmed";
  if (item.statuses.includes("known-not-acquired"))
    return "Source not downloaded";
  return undefined;
}
export function tableAttention(entry: SourceEntry): string | undefined {
  if (entry.table.rows === 0) return "No records published";
  if (sourceMetadataNeedsAttention(entry)) return "Source notes need checking";
  if (!entry.review) return "Dates and coverage need checking";
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
  const observed = uniquePeriods(item.periods).filter(
    (period) => period.kind === "observed-retained-scope" && period.start,
  );
  if (observed.length === 1)
    return `${periodRange(observed[0])} · saved records`;
  return item.periods.length
    ? "See dates in source details"
    : "Dates not confirmed";
}
export function periodLabel(period: CatalogPeriod): string {
  const basis = `${period.kind} ${period.basis}`;
  if (basis.includes("requested-scope")) return "Dates we asked for";
  if (period.kind === "documented-publisher-scope")
    return "Dates offered by the publisher";
  if (period.kind === "observed-retained-scope")
    return "Dates found in saved records";
  return period.kind.replaceAll("-", " ").replace(/^./, (c) => c.toUpperCase());
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
export function tablePublisher(entry: SourceEntry) {
  return (
    entry.table.sources[0]?.name ||
    entry.review?.sources[0]?.name ||
    entry.source.name ||
    "Publisher not recorded"
  );
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
  if (state.page > 1) p.set("page", String(state.page));
  if (state.table) p.set("table", state.table);
  else if (state.collection) p.set("collection", state.collection);
  return p.size ? `?${p}` : "";
}

/** Preserve uncertainty: an absent end date is not evidence of continuing coverage. */
export function periodRange(period: CatalogPeriod): string {
  const date = (value: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(value) ? publicationDate(value) : value;
  if (!period.start)
    return period.label.includes("scope disagreement")
      ? "Publisher descriptions give different date ranges. See the original notes."
      : "Exact dates aren’t recorded here. See the original notes.";
  if (period.end === period.start) return date(period.start);
  return `${date(period.start)}${period.end ? ` – ${date(period.end)}` : " (end date unknown)"}`;
}

export function collectionTitle(item: CatalogCollection): string {
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
