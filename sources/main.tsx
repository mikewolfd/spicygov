import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  count,
  publicationDate,
  supportingSection,
  tableCountUnit,
} from "../lib/catalog";
import { useCollection } from "../lib/use-collection";
import { useSourceDirectory } from "../lib/use-source-directory";
import { sourceEntries, type SourceEntry } from "../lib/source-directory";
import {
  SourceCatalogReader,
  type CatalogManifest,
  type CatalogCollection,
} from "../lib/source-catalog";
import {
  collectionTitle,
  readableCopy,
  browserSearch,
  readBrowserLocation,
  searchRank,
  collectionAvailability,
  matchesCollectionAvailability,
  collectionAttention,
  collectionLimitation,
  collectionTopic,
  periodSummary,
  tableAttention,
  tableLimitation,
  tablePublisher,
  recordEntries,
  pageSize,
  type BrowserLocation,
  type BrowserView,
} from "../lib/source-browser";
import "../app/globals.css";
import "./style.css";

const TableDetail = lazy(() =>
  import("../components/source-table-detail").then((module) => ({
    default: module.SourceTableDetail,
  })),
);
const CollectionDetail = lazy(() =>
  import("../components/source-collection-detail").then((module) => ({
    default: module.SourceCollectionDetail,
  })),
);
type Result = {
  id: string;
  title: string;
  publisher: string;
  summary: string;
  topic: string;
  rank: number;
  attention?: string;
  entry?: SourceEntry;
  collection?: CatalogCollection;
};
const views: { id: BrowserView; label: string; description: string }[] = [
  {
    id: "available",
    label: "Available data",
    description: "Published datasets you can explore or download.",
  },
  {
    id: "catalog",
    label: "All known sources",
    description: "All known sources, including data we haven’t added yet.",
  },
  {
    id: "attention",
    label: "Gaps",
    description:
      "Missing files, sources not yet downloaded, and notes that need checking.",
  },
];

function SourcesPage() {
  const [location, setLocation] = useState(() =>
    readBrowserLocation(window.location.search),
  );
  const [retry, setRetry] = useState(0),
    [catalogRetry, setCatalogRetry] = useState(0);
  const [manifest, setManifest] = useState<CatalogManifest>(),
    [catalogError, setCatalogError] = useState("");
  const reader = useMemo(
    () =>
      new SourceCatalogReader(
        import.meta.env.VITE_SOURCE_CATALOG_URL ||
          "/source-catalog/manifest.json",
      ),
    [],
  );
  const {
    tables,
    error,
    warnings: publicationWarnings = [],
    publicationsPending,
  } = useCollection(retry);
  const {
    review,
    warnings: reviewWarnings,
    pending: reviewPending,
  } = useSourceDirectory(retry);
  const entries = useMemo(
    () => sourceEntries(tables, [], review),
    [tables, review],
  );
  const records = useMemo(() => recordEntries(entries), [entries]);
  const tableIds = useMemo(
    () => new Set(tables.map((table) => table.id)),
    [tables],
  );
  const listFocus = useRef<string | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    setCatalogError("");
    void reader
      .manifest(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setManifest(value);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setCatalogError(
            "The source catalog could not be loaded. Published data is still available.",
          );
      });
    return () => controller.abort();
  }, [reader, catalogRetry]);
  useEffect(() => {
    const onPop = () =>
      setLocation(readBrowserLocation(window.location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const selectedTable = location.table
    ? entries.find((entry) => entry.table.id === location.table)
    : undefined;
  const selectedCollection = location.collection
    ? manifest?.collections.find((item) => item.id === location.collection)
    : undefined;
  const selected = location.table || location.collection;
  useEffect(() => {
    if (selectedTable || selectedCollection) {
      document.getElementById("detail-title")?.focus();
      window.scrollTo({ top: 0, behavior: "instant" });
    }
  }, [selectedTable?.table.id, selectedCollection?.id]);
  function navigate(change: Partial<BrowserLocation>, replace = false) {
    const next = { ...location, ...change };
    window.history[replace ? "replaceState" : "pushState"](
      {},
      "",
      `/sources/${browserSearch(next)}`,
    );
    setLocation(next);
  }
  function filter(change: Partial<BrowserLocation>, replace = false) {
    navigate(
      { ...change, page: 1, table: undefined, collection: undefined },
      replace,
    );
  }
  function openResult(result: Result) {
    listFocus.current = result.id;
    navigate({
      table: result.entry?.table.id,
      collection: result.collection?.id,
    });
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  function back() {
    navigate({ table: undefined, collection: undefined });
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLButtonElement>(
          `[data-result-id="${CSS.escape(listFocus.current || "")}"]`,
        )
        ?.focus(),
    );
  }
  const collectionResults = useMemo<Result[]>(
    () =>
      (manifest?.collections ?? []).map((item) => ({
        id: item.id,
        title: collectionTitle(item),
        publisher: item.publisher || "Publisher not recorded",
        summary: periodSummary(item),
        topic: collectionTopic(item, tables),
        rank: searchRank(
          location.query,
          collectionTitle(item),
          item.publisher,
          `${item.description || ""} ${item.families.join(" ")} ${item.tables.join(" ")} ${item.id}`,
        ),
        attention: collectionAttention(item),
        collection: item,
      })),
    [manifest, tables, location.query],
  );
  const tableResults = useMemo<Result[]>(
    () =>
      entries.map((entry) => ({
        id: entry.table.id,
        title: entry.table.label,
        publisher: tablePublisher(entry),
        summary: entry.review?.copy?.summary || entry.table.summary,
        topic: entry.table.group,
        rank: searchRank(
          location.query,
          entry.table.label,
          tablePublisher(entry),
          `${entry.table.id} ${entry.table.family} ${entry.review?.copy?.summary || entry.table.summary} ${entry.review?.sources.map((source) => source.name).join(" ") || ""}`,
        ),
        attention: tableAttention(entry),
        entry,
      })),
    [entries, location.query],
  );
  const counts = {
    available:
      !entries.length && !error
        ? undefined
        : records.filter((entry) => entry.table.rows > 0).length,
    catalog: manifest?.collections.length,
    attention:
      !manifest || publicationsPending
        ? undefined
        : tableResults.filter(
            (item) => !supportingSection(item.entry!.table) && item.attention,
          ).length + collectionResults.filter((item) => item.attention).length,
  };
  const resultPool =
    location.view === "catalog"
      ? collectionResults
      : location.view === "attention"
        ? [
            ...tableResults.filter(
              (item) => !supportingSection(item.entry!.table) && item.attention,
            ),
            ...collectionResults.filter((item) => item.attention),
          ]
        : tableResults.filter((item) =>
            location.availability === "supporting"
              ? !!supportingSection(item.entry!.table)
              : !supportingSection(item.entry!.table) &&
                (location.availability === "empty"
                  ? item.entry!.table.rows === 0
                  : item.entry!.table.rows > 0),
          );
  const topics = [...new Set(resultPool.map((item) => item.topic))]
    .filter(Boolean)
    .sort();
  const results = resultPool
    .filter(
      (item) =>
        item.rank > 0 &&
        (!location.topic || location.topic === item.topic) &&
        (!location.availability ||
          location.availability === "supporting" ||
          (location.availability === "review"
            ? !!item.attention
            : item.collection
            ? matchesCollectionAvailability(item.collection, location.availability, tableIds)
            : location.availability === "download"
              ? !item.entry!.explorer
              : location.availability === "empty"
                ? item.entry!.table.rows === 0
                : true)),
    )
    .sort(
      (a, b) =>
        b.rank - a.rank ||
        Number(
          !!b.entry || !!b.collection?.tables.some((id) => tableIds.has(id)),
        ) -
          Number(
            !!a.entry || !!a.collection?.tables.some((id) => tableIds.has(id)),
          ) ||
        a.title.localeCompare(b.title),
    );
  const pages = Math.max(1, Math.ceil(results.length / pageSize)),
    page = Math.min(location.page, pages);
  const visible = results.slice((page - 1) * pageSize, page * pageSize);
  const catalogMatches = collectionResults.filter(
    (item) => item.rank > 0,
  ).length;
  const warnings = [...publicationWarnings, ...reviewWarnings];
  const busy =
    location.view === "catalog"
      ? !manifest && !catalogError
      : !entries.length && !error;
  const detailPending = location.table
    ? publicationsPending || (!entries.length && !error)
    : !manifest && !catalogError;
  return (
    <div className="sources-page">
      <a href="#sources" className="skip-link">
        Skip to sources
      </a>
      <header className="topbar">
        <a className="wordmark" href="/">
          spicygov
          <span className="brand-star" aria-hidden="true">
            ✳
          </span>
        </a>
        <nav aria-label="Main">
          <a href="/">Explore</a>
          <span className="nav-active" aria-current="page">
            Sources
          </span>
          <a href="/mcp/">MCP</a>
          <a href="https://docs.spicygov.ai">Data docs</a>
        </nav>
      </header>
      <main
        id="sources"
        className={`sources-content ${selected ? "is-detail" : ""}`}
      >
        {selected ? (
          <>
            <button className="back-to-results" onClick={back}>
              ← Back to results
              {location.query && <span> for “{location.query}”</span>}
            </button>
            <Suspense
              fallback={
                <p className="loading-state" role="status">
                  Opening details…
                </p>
              }
            >
              {selectedTable ? (
                <TableDetail
                  key={`${selectedTable.table.id}-${selectedTable.table.artifactDigest || selectedTable.table.publication?.sha256 || ""}`}
                  entry={selectedTable}
                  tables={tables}
                  collections={manifest?.collections || []}
                  onCollection={(id) =>
                    navigate({ table: undefined, collection: id })
                  }
                />
              ) : selectedCollection && manifest ? (
                <CollectionDetail
                  key={`${manifest.generation}-${selectedCollection.id}`}
                  reader={reader}
                  manifest={manifest}
                  collection={selectedCollection}
                  description={
                    entries.find((entry) =>
                      selectedCollection.tables.includes(entry.table.id),
                    )?.review?.copy?.summary
                  }
                  tables={tables}
                  onTable={(id) =>
                    navigate({ table: id, collection: undefined })
                  }
                />
              ) : (
                <div className="empty-state">
                  <h1>
                    {detailPending
                      ? "Loading source…"
                      : "This item is not in the current catalog"}
                  </h1>
                  <p>
                    {detailPending
                      ? "Checking the selected catalog and publications."
                      : "Return to the results to choose an available source or table."}
                  </p>
                </div>
              )}
            </Suspense>
          </>
        ) : (
          <>
            <header className="directory-heading">
              <div>
                <span className="page-kicker">DATA DIRECTORY</span>
                <h1>Sources</h1>
              </div>
              <p>
                Find the data you need. <br />
                See where it comes from and what’s missing.
              </p>
            </header>
            <div className="directory-search">
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <circle cx="10.5" cy="10.5" r="6.5" />
                <path d="m16 16 5 5" />
              </svg>
              <label className="sr-only" htmlFor="source-search">
                Search sources and data
              </label>
              <input
                id="source-search"
                type="search"
                placeholder="Search a dataset, source, or publisher…"
                value={location.query}
                onChange={(event) =>
                  filter({ query: event.target.value }, true)
                }
              />
              {location.query && (
                <button
                  aria-label="Clear search"
                  onClick={() => filter({ query: "" }, true)}
                >
                  ×
                </button>
              )}
            </div>
            <nav className="directory-views" aria-label="Browse sources">
              {views.map((view) => (
                <button
                  key={view.id}
                  aria-current={view.id === location.view ? "page" : undefined}
                  onClick={() =>
                    filter({ view: view.id, topic: "", availability: "" })
                  }
                >
                  {view.label}
                  <span>
                    {counts[view.id] === undefined
                      ? "…"
                      : count(counts[view.id]!)}
                  </span>
                </button>
              ))}
            </nav>
            <div className="directory-toolbar">
              <p>
                {views.find((view) => view.id === location.view)!.description}
              </p>
              <div className="directory-filters">
                <label>
                  <span className="sr-only">Topic</span>
                  <select
                    aria-label="Topic"
                    value={location.topic}
                    onChange={(event) => filter({ topic: event.target.value })}
                  >
                    <option value="">All topics</option>
                    {topics.map((topic) => (
                      <option key={topic}>{topic}</option>
                    ))}
                  </select>
                </label>
                {location.view !== "attention" && (
                  <label>
                    <span className="sr-only">Availability</span>
                    <select
                      aria-label="Availability"
                      value={location.availability}
                      onChange={(event) =>
                        filter({ availability: event.target.value })
                      }
                    >
                      <option value="">All availability</option>
                      {location.view === "catalog" ? (
                        <>
                          <option value="linked">Published</option>
                          <option value="held">Downloaded</option>
                          <option value="uncollected">Not downloaded</option>
                          <option value="review">Needs review</option>
                          <option value="missing">Files missing</option>
                          <option value="receipts">
                            Download records only
                          </option>
                          <option value="external">Stored elsewhere</option>
                          <option value="unknown">Files not confirmed</option>
                        </>
                      ) : (
                        <>
                          <option value="download">Download only</option>
                          <option value="empty">No published records</option>
                          <option value="supporting">Supporting data</option>
                        </>
                      )}
                    </select>
                  </label>
                )}
                {(location.topic || location.availability) && (
                  <button
                    className="text-button"
                    onClick={() => filter({ topic: "", availability: "" })}
                  >
                    Reset filters
                  </button>
                )}
              </div>
            </div>
            <div className="results-summary">
              <p aria-live="polite">
                {busy
                  ? "Loading…"
                  : `${count(results.length)} ${location.view === "available" ? "datasets" : location.view === "catalog" ? "sources" : "items"}`}
                {location.query && <> matching “{location.query}”</>}
              </p>
              <span>
                {location.view === "catalog" && manifest
                  ? `Catalog input snapshot: ${publicationDate(manifest.generatedAt)}`
                  : publicationsPending || reviewPending
                    ? "Checking publications…"
                    : "Current publications"}
              </span>
            </div>
            {location.view === "catalog" ? (
              <p className="directory-notices">
                Saved files and processing evidence describe this input snapshot.
                Published datasets use the current publication index separately.
              </p>
            ) : null}
            {(error || catalogError || warnings.length > 0) && (
              <div className="directory-notices">
                {error && (
                  <p role="alert">
                    Published data could not be loaded.{" "}
                    <button onClick={() => setRetry(retry + 1)}>
                      Retry publications
                    </button>
                  </p>
                )}
                {catalogError && (
                  <p role="alert">
                    {catalogError}{" "}
                    <button onClick={() => setCatalogRetry(catalogRetry + 1)}>
                      Retry catalog
                    </button>
                  </p>
                )}
                {warnings.length > 0 && (
                  <details>
                    <summary>Some descriptions are unavailable</summary>
                    {warnings.map((warning) => (
                      <p key={warning}>{warning}</p>
                    ))}
                    <button onClick={() => setRetry(retry + 1)}>
                      Retry descriptions
                    </button>
                  </details>
                )}
              </div>
            )}
            <div
              className="directory-list"
              aria-label="Search results"
              aria-busy={busy}
            >
              <div className="directory-columns" aria-hidden="true">
                <span>
                  {location.view === "available"
                    ? "Dataset & publisher"
                    : "Source & publisher"}
                </span>
                <span>
                  {location.view === "available"
                    ? "What it covers"
                    : "Availability"}
                </span>
                <span>
                  {location.view === "available" ? "Records" : "Files saved"}
                </span>
                <span />
              </div>
              {visible.map((result) => {
                const availability = result.collection
                  ? collectionAvailability(result.collection, tableIds)
                  : undefined;
                return (
                  <div
                    className="directory-row"
                    key={`${result.entry ? "table" : "source"}-${result.id}`}
                  >
                    <a
                      className="result-open"
                      data-result-id={result.id}
                      href={`/sources/${browserSearch({ ...location, table: result.entry?.table.id, collection: result.collection?.id })}`}
                      onClick={(event) => {
                        if (
                          event.button ||
                          event.metaKey ||
                          event.ctrlKey ||
                          event.shiftKey ||
                          event.altKey
                        )
                          return;
                        event.preventDefault();
                        openResult(result);
                      }}
                    >
                      <span className="result-name">
                        <strong>{result.title}</strong>
                        <span className="result-publisher">
                          {result.publisher}
                        </span>
                        {location.query && result.rank === 10 && (
                          <span className="result-match">
                            Mentioned in source description
                          </span>
                        )}
                      </span>
                      <span className="result-state">
                        {result.entry ? (
                          <>
                            <span className="scope-preview">
                              {readableCopy(
                                result.entry.review?.copy?.scope ||
                                  "Dates and coverage are not yet described.",
                              )}
                            </span>
                          </>
                        ) : (
                          <>
                            <span
                              className={`availability-dot ${availability!.id === "linked" ? "is-available" : ""}`}
                            />
                            {availability!.label}
                            <small>{result.summary}</small>
                          </>
                        )}
                        <span className="result-attention">
                          {readableCopy(result.entry
                            ? tableLimitation(result.entry)
                            : collectionLimitation(result.collection!))}
                        </span>
                      </span>
                      <span className="result-count">
                        {result.entry ? (
                          <>
                            <strong>{count(result.entry.table.rows)}</strong>
                            <small>{tableCountUnit(result.entry.table)}</small>
                            <small>
                              {result.entry.table.rows === 0
                                ? "No records yet"
                                : result.entry.explorer
                                  ? "Ready to explore"
                                  : "Download only"}
                            </small>
                          </>
                        ) : (
                          <>
                            <strong>
                              {result.collection!.holdings.objects
                                ? count(result.collection!.holdings.objects)
                                : "—"}
                            </strong>
                            <small>
                              {result.collection!.holdings.objects
                                ? result.collection!.holdings.objects === 1
                                  ? "unique file saved"
                                  : "unique files saved"
                                : "Files not confirmed"}
                            </small>
                          </>
                        )}
                      </span>
                      <span className="result-arrow">
                        View details <span aria-hidden="true">→</span>
                      </span>
                    </a>
                  </div>
                );
              })}
            </div>
            {!busy && !results.length && (
              <div className="empty-state">
                <h2>
                  No matching{" "}
                  {location.view === "available" ? "datasets" : "sources"}
                </h2>
                <p>Try a source name, publisher, or a broader term.</p>
                {location.view === "available" &&
                  location.query &&
                  catalogMatches > 0 && (
                    <button
                      className="secondary-action"
                      onClick={() =>
                        filter({ view: "catalog", topic: "", availability: "" })
                      }
                    >
                      See {count(catalogMatches)} matches in all known sources →
                    </button>
                  )}
                {(location.query ||
                  location.topic ||
                  location.availability) && (
                  <button
                    className="text-button"
                    onClick={() =>
                      filter({ query: "", topic: "", availability: "" })
                    }
                  >
                    Clear search and filters
                  </button>
                )}
              </div>
            )}
            {pages > 1 && (
              <nav className="result-pagination" aria-label="Result pages">
                <button
                  disabled={page === 1}
                  onClick={() => {
                    navigate({ page: page - 1 });
                    document.getElementById("source-search")?.focus();
                    window.scrollTo({ top: 0, behavior: "instant" });
                  }}
                >
                  ← Previous
                </button>
                <span>
                  Page {page} of {pages}
                </span>
                <button
                  disabled={page === pages}
                  onClick={() => {
                    navigate({ page: page + 1 });
                    document.getElementById("source-search")?.focus();
                    window.scrollTo({ top: 0, behavior: "instant" });
                  }}
                >
                  Next →
                </button>
              </nav>
            )}
            <footer className="directory-footer">
              <p>
                A source may offer more than we’ve collected. Open an item to
                see its dates, known gaps, and original sources.
              </p>
              <a href="https://docs.spicygov.ai">Data documentation ↗</a>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}
const root = createRoot(document.getElementById("root")!);
root.render(<SourcesPage />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
