import descriptions from "./data/table_metadata.json";
import relationships from "./data/table_joins.json";
export const DATA_BASE = "https://data.spicygov.ai";
export type Row = Record<string, unknown>;
export type Filter = { column: string; value: string };
export type Member = { url: string; rows: number; byteSize: number };
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
  published: string;
  group: string;
};
export type Join = {
  child: string;
  child_columns: string[];
  parent: string;
  parent_columns: string[];
  kind: string;
  reason: string;
};
export const joins: Join[] = relationships.joins;
export const pretty = (s: string) =>
  s.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
export const count = (n: number) => new Intl.NumberFormat("en-US").format(n);
export const compact = (n: number) =>
  new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
export function groupFor(id: string) {
  if (
    [
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
  const meta = descriptions as Record<string, any>;
  const tables: Dataset[] = [];
  for (const family of Object.values(index.families) as any[])
    for (const [key, table] of Object.entries(family.tables) as [
      string,
      any,
    ][]) {
      const id = key.replace(/\.parquet$/, "");
      const m = meta[id] ?? {};
      tables.push({
        id,
        label: m.label ?? pretty(id),
        summary: m.summary ?? "",
        coverage: m.coverage ?? "",
        kind: m.kind ?? "published",
        quality: m.data_quality,
        rows: table.rows,
        bytes: table.byteSize,
        columns: table.columns.map(([name, type]: string[]) => ({
          name,
          type,
          description:
            m.columns?.find((c: any) => c.column_name === name)?.description ??
            "",
        })),
        members: (table.members ?? [{ key, ...table }]).map((member: any) => ({
          url: `${DATA_BASE}/${family.prefix}/${member.key}`,
          rows: member.rows,
          byteSize: member.byteSize,
        })),
        published: family.publishedAt,
        group: groupFor(id),
      });
    }
  return tables.sort((a, b) => a.label.localeCompare(b.label));
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
export function related(id: string) {
  return joins.filter((j) => j.child === id || j.parent === id);
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
