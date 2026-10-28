import { sourceCoverageTags } from "../lib/coverage-tags";
import { useEffect, useRef, useState } from "react";
import { count, publicationDate, type Dataset } from "../lib/catalog";
import {
  collectionTitle,
  collectionDescription,
  collectionLimitations,
  collectionHoldingsSummary,
  periodPreview,
  collectionAvailability,
  collectionAttention,
  deliveryLabels,
  periodLabel,
  periodRange,
  uniquePeriods,
} from "../lib/source-browser";
import {
  SourceCatalogReader,
  type CatalogCollection,
  type CatalogDetail,
  type CatalogManifest,
  type CatalogFilePage,
  type CatalogPeriod,
} from "../lib/source-catalog";
import { CoverageAccounting, RetainedPublications } from "./source-catalog";
import { CatalogTableEvidence } from "./catalog-table-evidence";
import { CatalogFileList } from "./catalog-file-list";
import { CatalogRetainedFiles } from "./catalog-retained-files";
import { sourcePeriodGroups } from "../lib/source-periods";

export function SourceRelationships({
  detail,
  collections,
}: {
  detail: Pick<CatalogDetail, "relationships" | "routes">;
  collections: CatalogCollection[];
}) {
  if (!detail.relationships.length) return null;
  function endpoint(id: unknown) {
    const related = collections.find((item) => item.id === id);
    return related ? (
      <a href={`/sources/?view=catalog&collection=${encodeURIComponent(related.id)}`}>
        {collectionTitle(related)}
      </a>
    ) : detail.routes.find((route) => route.id === id)?.label || String(id);
  }
  return (
    <details className="evidence-disclosure">
      <summary>Related sources and routes</summary>
      <ul className="plain-list">
        {detail.relationships.map((item) => (
          <li key={String(item.id)}>
            <strong>{String(item.kind).replaceAll("-", " ")}</strong>
            {!!item.scope && <p>{String(item.scope)}</p>}
            {!!item.note && <p>{String(item.note)}</p>}
            <small>{endpoint(item.fromId)} → {endpoint(item.toId)}</small>
          </li>
        ))}
      </ul>
    </details>
  );
}


export function SourcePeriodOverview({ periods, collection }: {
  periods: CatalogPeriod[];
  collection?: Pick<CatalogCollection, "id" | "families">;
}) {
  const groups = sourcePeriodGroups(periods, collection);
  const [selectedId, setSelectedId] = useState("");
  const selected = groups.find(group => group.id === selectedId) ?? groups[0];
  const observed = selected?.periods[0].kind === "observed-retained-scope" && selected.periods.some(period => period.start);
  const values = selected?.periods ?? [];
  return <>
    <h2>{observed ? 'Dates in the saved records' : 'Recorded data periods'}</h2>
    {groups.length > 1 && <label className="source-period-choice"><span>Period view</span><select aria-label="Period view" value={selected.id} onChange={event => setSelectedId(event.target.value)}>{groups.map(group => <option key={group.id} value={group.id}>{group.label}</option>)}</select></label>}
    {observed ? <>
      <ul className="plain-list">{values.slice(0, 3).map((period, index) => <li key={index}>{periodPreview(period)}</li>)}</ul>
      {values.length > 3 && <p>{values.length} recorded date scopes; see source history for all of them.</p>}
      <p className="detail-caption">Saved records · Gaps may exist; published dates may differ.</p>
    </> : selected ? <>
      <dl className="source-periods"><div><dt>{selected.label}</dt><dd>{values.slice(0, 3).map(periodPreview).join(' · ')}{values.length > 3 && ` … ${values.length} recorded periods`}</dd></div></dl>
      <p className="detail-caption">Recorded source scope · May be requested or partial.</p>
    </> : <p>We haven’t confirmed the dates in the saved records.</p>}
  </>;
}

export function SourceCollectionDetail({
  reader,
  manifest,
  collection,
  description,
  tables,
  publicationState,
  onTable,
}: {
  reader: SourceCatalogReader;
  manifest: CatalogManifest;
  collection: CatalogCollection;
  description?: string;
  tables: Dataset[];
  publicationState: "pending" | "unavailable" | "ready";
  onTable: (id: string) => void;
}) {
  const [detail, setDetail] = useState<CatalogDetail>(),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0);
  const [section, setSection] = useState("overview");
  const [page, setPage] = useState<CatalogFilePage>(),
    [pageIndex, setPageIndex] = useState(0);
  const [fileLoading, setFileLoading] = useState(false),
    [fileError, setFileError] = useState("");
  const fileRequest = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setDetail(undefined);
    void reader
      .detail(manifest, collection, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setDetail(value);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError(
            "The source details could not be loaded or no longer match this catalog.",
          );
      });
    return () => {
      controller.abort();
      fileRequest.current?.abort();
    };
  }, [reader, manifest, collection, retry]);
  async function loadFiles(index: number) {
    if (!detail) return;
    fileRequest.current?.abort();
    const controller = new AbortController();
    fileRequest.current = controller;
    setFileLoading(true);
    setFileError("");
    try {
      const result = await reader.files(
        manifest,
        detail,
        index,
        controller.signal,
      );
      if (!controller.signal.aborted) {
        setPage(result);
        setPageIndex(index);
      }
    } catch {
      if (!controller.signal.aborted)
        setFileError(
          "This file page could not be loaded. The previous page, if any, is still shown.",
        );
    } finally {
      if (!controller.signal.aborted) setFileLoading(false);
    }
  }
  const availability = collectionAvailability(
    collection,
    new Set(tables.map((table) => table.id)),
  );
  const attention = collectionAttention(collection);
  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "routes", label: "Sources & history" },
    { id: "files", label: "Files" },
    { id: "evidence", label: "Technical evidence" },
  ];
  const destinations = detail?.tables ?? [];
  const published = tables.filter((table) => collection.tables.includes(table.id) && table.rows > 0);
  useEffect(() => {
    document.getElementById("detail-title")?.focus();
  }, []);
  return (
    <article className="source-detail" aria-labelledby="detail-title">
      {collection.publisher && <div className="detail-eyebrow">{collection.publisher}</div>}
      <header className="detail-heading">
        <h1 id="detail-title" tabIndex={-1}>
          {collectionTitle(collection)}
        </h1>
        <p className="detail-caption">{count(collection.holdings.objects)} saved {collection.holdings.objects === 1 ? "file" : "files"}</p>
        {collection.statuses.includes("external-by-choice") && <p className="detail-caption">{collection.holdings.objects ? "More source files are stored elsewhere." : "Source files are stored elsewhere."}</p>}
        {detail && <div className="coverage-tags">{sourceCoverageTags(detail.collection.periods, collection).map(tag => <span className="coverage-tag" key={tag.label} title={tag.detail}>{tag.label}</span>)}</div>}
        <div className="detail-actions">
          {published.length === 1 ? (
            <a className="primary-action" href={published[0].recordsAvailable !== false
              ? `/?table=${encodeURIComponent(published[0].id)}`
              : `/sources/?table=${encodeURIComponent(published[0].id)}`}>{published[0].recordsAvailable !== false ? "Explore data →" : "View downloads →"}</a>
          ) : published.length > 1 ? (
            <a className="primary-action" href="#source-datasets" onClick={() => setSection("overview")}>Choose a dataset ↓</a>
          ) : <span>{publicationState === "ready"
            ? "No published data"
            : publicationState === "pending"
              ? "Loading datasets…"
              : "Published datasets could not be checked."}</span>}
        </div>
      </header>
      {error && (
        <p className="load-error" role="alert">
          {error}{" "}
          <button onClick={() => setRetry(retry + 1)}>Retry details</button>
        </p>
      )}
      {!detail && !error && (
        <p role="status" className="loading-state">
          Loading source details…
        </p>
      )}
      {!!published.length && <section className="detail-section">
        <h2 id="source-datasets">Datasets</h2>
        <ul className="destination-list">{published.map(table => <li key={table.id}>
          <a href={table.recordsAvailable !== false ? `/?table=${encodeURIComponent(table.id)}` : `/sources/?table=${encodeURIComponent(table.id)}`}>{table.label}</a>
          <p>{count(table.rows)} records</p>
        </li>)}</ul>
      </section>}
      <details className="source-details">
        <summary>Details</summary>
        <p>{collectionDescription(collection, description)}</p>
        <p className="detail-caption">{!collection.publisher && "Publisher not recorded · "}{availability.label} · {collectionHoldingsSummary(collection)}</p>
        {attention && <p className="context-note">{attention}</p>}
        <nav className="detail-tabs" aria-label="Source details">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              aria-current={section === tab.id ? "page" : undefined}
              onClick={() => setSection(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      {detail && (
        <div className="detail-panel" key={section}>
          {section === "overview" && (
            <>
              <section className="detail-section">
                <SourcePeriodOverview key={detail.collection.id} periods={detail.collection.periods} collection={detail.collection} />
                {collection.tables.includes("sam_entities") && <p className="context-note">Registration years describe registrations, not historical database snapshots.</p>}
                <button className="text-button" onClick={() => setSection("routes")}>Source dates & history →</button>
              </section>
              <section className="detail-section">
                <h2>Published dataset details</h2>
                {destinations.length ? (
                  <ul className="destination-list">
                    {destinations.map((item) => {
                      const current = tables.find(
                        (table) => table.id === item.id,
                      );
                      return (
                        <li key={`${item.family}-${item.id}`}>
                          <strong>
                            {current?.label || item.id.replaceAll("_", " ")}
                          </strong>
                          {current && <p>{count(current.rows)} records{current.published ? ` · Published ${publicationDate(current.published)}` : ""}</p>}
                          <CatalogTableEvidence destination={item} current={current} />
                          {current ? (
                            <button
                              className="text-button"
                              onClick={() => onTable(current.id)}
                            >
                              View published data →
                            </button>
                          ) : (
                            <p>{publicationState === "ready"
                              ? "This dataset isn’t currently published."
                              : publicationState === "pending"
                                ? "Checking whether this dataset is published…"
                                : "We couldn’t check whether this dataset is currently published."}</p>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p>
                    No published dataset is linked to this source entry.
                  </p>
                )}
              </section>
            </>
          )}
          {section === "routes" && (
            <>
              <h2>Sources & history</h2>
              <p>Publisher dates, requested dates, and saved records may differ.</p>
              {detail.routes.length ? (
                <div className="route-list">
                  {detail.routes.map((route) => (
                    <section className="route-item" key={route.id}>
                      <div className="route-kind">
                        {deliveryLabels[route.deliveryMethod] ||
                          route.deliveryMethod.replaceAll("-", " ")}
                        {["legacy", "retired"].includes(route.lifecycle) &&
                          " · Historical source"}
                      </div>
                      <h3>
                        {route.accessUrl ? (
                          <a
                            href={route.accessUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {route.label} ↗
                          </a>
                        ) : (
                          route.label
                        )}
                      </h3>

                      {route.periods.length ? (
                        <dl className="source-periods">
                          {uniquePeriods(route.periods).map((period, i) => (
                            <div key={i}>
                              <dt>{periodLabel(period)}</dt>
                              <dd>
                                <strong>{periodRange(period)}</strong>
                                <details>
                                  <summary>Original date notes</summary>
                                  <p>{period.label}</p>
                                  <p>{period.basis}</p>
                                </details>
                              </dd>
                            </div>
                          ))}
                        </dl>
                      ) : (
                        <p className="detail-caption">
                          Dates are not yet recorded for this source.
                        </p>
                      )}
                      <details className="route-technical">
                        <summary>Technical source details</summary>
                        {route.note && <p>{route.note}</p>}
                        <dl className="technical-facts">
                          <div>
                            <dt>Identifier</dt>
                            <dd>
                              <code>{route.id}</code>
                            </dd>
                          </div>
                          <div>
                            <dt>Lifecycle</dt>
                            <dd>{route.lifecycle}</dd>
                          </div>
                          <div>
                            <dt>Custodian</dt>
                            <dd>{route.custodian}</dd>
                          </div>
                          <div>
                            <dt>Content behavior</dt>
                            <dd>{route.contentBehavior}</dd>
                          </div>
                          <div>
                            <dt>Qualification</dt>
                            <dd>{route.status || "Not recorded"}</dd>
                          </div>
                        </dl>
                      </details>
                    </section>
                  ))}
                </div>
              ) : (
                <p>We haven’t recorded how to get this data yet.</p>
              )}
              <SourceRelationships detail={detail} collections={manifest.collections} />
            </>
          )}
          {section === "files" && (
            <>
              <h2>Source files</h2>
              <p>{collectionHoldingsSummary(collection)} · Catalog updated {publicationDate(manifest.generatedAt)}</p>
              <p>{count(detail.files.total)} file references · Some may refer to the same original.</p>
              {detail.files.pages.length ? (
                <button
                  className="secondary-action"
                  disabled={fileLoading}
                  onClick={() => void loadFiles(page ? pageIndex : 0)}
                >
                  {fileLoading
                    ? "Loading files…"
                    : page
                      ? "Reload file page"
                      : "Browse files"}
                </button>
              ) : (
                <p>{detail.retainedFiles?.total
                  ? 'Other file references are listed under “Files that need attention” below.'
                  : 'No direct file inventory is listed.'}</p>
              )}
              {!detail.files.pages.length && <SourceRelationships detail={detail} collections={manifest.collections} />}
              {fileError && <p role="alert">{fileError}</p>}
              {page && (
                <>
                  <CatalogFileList key={pageIndex} files={page.files} routes={detail.routes} />
                  <nav className="result-pagination" aria-label="File pages">
                    <button
                      disabled={fileLoading || pageIndex === 0}
                      onClick={() => void loadFiles(pageIndex - 1)}
                    >
                      ← Previous
                    </button>
                    <span aria-live="polite">
                      Page {pageIndex + 1} of {detail.files.pages.length}
                    </span>
                    <button
                      disabled={
                        fileLoading ||
                        pageIndex + 1 === detail.files.pages.length
                      }
                      onClick={() => void loadFiles(pageIndex + 1)}
                    >
                      Next →
                    </button>
                  </nav>
                </>
              )}
            </>
          )}
          {section === "files" && <CatalogRetainedFiles key={`${manifest.generation}-${detail.collection.id}`} reader={reader} manifest={manifest} detail={detail} />}
          {section === "evidence" && (
            <div className="technical-content">
              <h2>Technical evidence</h2>
              {collection.description && <p>{collection.description}</p>}
              <ul className="plain-list">{collectionLimitations(collection).map(note => <li key={note}>{note}</li>)}</ul>
              {detail.coverage && (
                <details className="evidence-disclosure">
                  <summary>Coverage accounting</summary>
                  <CoverageAccounting coverage={detail.coverage} />
                </details>
              )}
              {!!detail.publicationObservations?.length && (
                <details className="evidence-disclosure">
                  <summary>Captured publications</summary>
                  <RetainedPublications
                    observations={detail.publicationObservations}
                  />
                </details>
              )}
              {!!detail.planned.length && (
                <details className="evidence-disclosure">
                  <summary>Source choices & planned work</summary>
                  <ul className="plain-list">
                    {detail.planned.map((item) => (
                      <li key={String(item.id)}>
                        <strong>
                          {String(item.table || item.family || item.id)}
                        </strong>
                        <p>{String(item.reason || "No reason recorded")}</p>
                        <p>Recorded status: {String(item.status)}</p>
                        {!!item.routeId && (
                          <p>
                            Route:{" "}
                            {detail.routes.find(
                              (route) => route.id === item.routeId,
                            )?.label || String(item.routeId)}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {!!detail.observations.length && (
                <details className="evidence-disclosure">
                  <summary>Acquisition observations</summary>
                  <pre>{JSON.stringify(detail.observations, null, 2)}</pre>
                </details>
              )}
              <details className="evidence-disclosure">
                <summary>Original source title and date notes</summary>
                <p>{collection.title}</p>
                <pre>{JSON.stringify(detail.collection.periods, null, 2)}</pre>
              </details>
              <dl className="technical-facts">
                <div>
                  <dt>Collection identifier</dt>
                  <dd>
                    <code>{collection.id}</code>
                  </dd>
                </div>
                <div>
                  <dt>Catalog generation</dt>
                  <dd>
                    <code>{manifest.generation}</code>
                  </dd>
                </div>
                <div>
                  <dt>Recorded states</dt>
                  <dd>{collection.statuses.join(" · ")}</dd>
                </div>
              </dl>
            </div>
          )}
        </div>
      )}
      </details>
    </article>
  );
}
