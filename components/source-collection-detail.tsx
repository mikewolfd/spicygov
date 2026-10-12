import { useEffect, useRef, useState } from "react";
import { count, publicationDate, type Dataset } from "../lib/catalog";
import {
  collectionTitle,
  readableCopy,
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
} from "../lib/source-catalog";
import { CoverageAccounting, RetainedPublications } from "./source-catalog";

export function SourceCollectionDetail({
  reader,
  manifest,
  collection,
  description,
  tables,
  onTable,
}: {
  reader: SourceCatalogReader;
  manifest: CatalogManifest;
  collection: CatalogCollection;
  description?: string;
  tables: Dataset[];
  onTable: (id: string) => void;
}) {
  const [detail, setDetail] = useState<CatalogDetail>(),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0);
  const [section, setSection] = useState("overview");
  const [page, setPage] = useState<CatalogFilePage>(),
    [pageIndex, setPageIndex] = useState(0),
    [visibleFiles, setVisibleFiles] = useState(50);
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
        setVisibleFiles(50);
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
    { id: "routes", label: "Dates & sources" },
    { id: "files", label: "Files" },
    { id: "evidence", label: "Technical evidence" },
  ];
  const destinations = detail?.tables ?? [];
  useEffect(() => {
    document.getElementById("detail-title")?.focus();
  }, []);
  return (
    <article className="source-detail" aria-labelledby="detail-title">
      <div className="detail-eyebrow">
        All sources <span>/</span>{" "}
        {collection.publisher || "Publisher not recorded"}
      </div>
      <header className="detail-heading">
        <h1 id="detail-title" tabIndex={-1}>
          {collectionTitle(collection)}
        </h1>
        <p className="availability-line">
          <span
            className={`availability-dot ${availability.id === "linked" ? "is-available" : ""}`}
          />
          {availability.label}
        </p>
      </header>
      <dl className="detail-facts">
        <div>
          <dt>Unique files saved</dt>
          <dd>
            {collection.holdings.objects
              ? count(collection.holdings.objects)
              : "Not confirmed"}
          </dd>
        </div>
        <div>
          <dt>Ways to get the data</dt>
          <dd>{count(collection.routeCount)}</dd>
        </div>
        <div>
          <dt>Catalog updated</dt>
          <dd>{publicationDate(manifest.generatedAt)}</dd>
        </div>
      </dl>
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
      {detail && (
        <div className="detail-panel" key={section}>
          {section === "overview" && (
            <>
              <section className="detail-section">
                <h2>About this source</h2>
                <p>
                  {readableCopy(
                    description ||
                      (collection.publisher
                        ? `This catalog entry records data from ${collection.publisher}.`
                        : "This entry records a known source and the files or download records we have for it."),
                  )}
                </p>
              </section>
              <section className="detail-section">
                <h2>What we’ve saved</h2>
                <p>
                  {collection.holdings.objects
                    ? `${count(collection.holdings.objects)} different files are saved for this source.`
                    : availability.id === "uncollected"
                      ? "This source is listed by its publisher; its data has not been downloaded."
                      : "We haven’t confirmed which original files are saved for this source."}{" "}
                  This does not tell us whether we have every available record.
                </p>
                {attention && <p className="context-note">{attention}.</p>}
                {!collection.holdings.missing && (
                  <p className="detail-caption">
                    We don’t yet know how many other files may be available.
                  </p>
                )}
              </section>
              <section className="detail-section">
                <h2>Where it’s used</h2>
                {destinations.length ? (
                  <ul className="destination-list">
                    {destinations.map((item) => {
                      const current = tables.find(
                        (table) => table.id === item.id,
                      );
                      const stale =
                        current &&
                        item.artifactDigest &&
                        current.artifactDigest &&
                        current.artifactDigest !== item.artifactDigest;
                      return (
                        <li key={`${item.family}-${item.id}`}>
                          <strong>
                            {current?.label || item.id.replaceAll("_", " ")}
                          </strong>
                          {item.coverageNote && (
                            <details>
                              <summary>Notes about this connection</summary>
                              <p>{item.coverageNote}</p>
                            </details>
                          )}
                          {stale && (
                            <p className="context-note">
                              This source connection describes an earlier
                              release.
                            </p>
                          )}
                          {(!item.artifactDigest ||
                            (current && !current.artifactDigest)) && (
                            <p className="detail-caption">
                              We haven’t checked whether this connection applies
                              to the latest release.
                            </p>
                          )}
                          {current ? (
                            <button
                              className="text-button"
                              onClick={() => onTable(current.id)}
                            >
                              View published data →
                            </button>
                          ) : (
                            <p>This dataset isn’t currently published.</p>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p>
                    This source hasn’t been connected to published data yet.
                  </p>
                )}
              </section>
              <section className="detail-section">
                <h2>Dates and older records</h2>
                <p>
                  A publisher may offer recent records through an online service
                  and older records as downloadable files. See the dates for
                  each source.
                </p>
                <button
                  className="text-button"
                  onClick={() => setSection("routes")}
                >
                  See dates and sources →
                </button>
              </section>
            </>
          )}
          {section === "routes" && (
            <>
              <h2>Dates & sources</h2>
              <p>
                For each source, we distinguish the dates the publisher offers
                from the dates we asked for and the records we’ve saved. A date
                range can still contain gaps.
              </p>
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
              {!!detail.relationships.length && (
                <details className="evidence-disclosure">
                  <summary>Overlap and relationships between routes</summary>
                  <ul className="plain-list">
                    {detail.relationships.map((item) => (
                      <li key={String(item.id)}>
                        <strong>
                          {String(item.kind).replaceAll("-", " ")}
                        </strong>
                        {!!item.scope && <p>{String(item.scope)}</p>}
                        {!!item.note && <p>{String(item.note)}</p>}
                        <small>
                          {detail.routes.find(
                            (route) => route.id === item.fromId,
                          )?.label || String(item.fromId)}{" "}
                          →{" "}
                          {detail.routes.find((route) => route.id === item.toId)
                            ?.label || String(item.toId)}
                        </small>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
          {section === "files" && (
            <>
              <h2>Source files</h2>
              <p>
                {count(detail.files.total)} file references are recorded.
                References can point to the same file; they are not a count of
                distinct downloads.
              </p>
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
                <p>No file inventory is available for this source.</p>
              )}
              {fileError && <p role="alert">{fileError}</p>}
              {page && (
                <>
                  <ul className="source-file-list">
                    {page.files.slice(0, visibleFiles).map((file) => (
                      <li key={file.id}>
                        <h3>{file.name}</h3>
                        <p>
                          {file.bytes !== undefined
                            ? `${count(file.bytes)} decoded bytes`
                            : "File size not recorded"}
                          {file.routeId && (
                            <>
                              {" "}
                              ·{" "}
                              {detail.routes.find(
                                (route) => route.id === file.routeId,
                              )?.label || "Recorded source route"}
                            </>
                          )}
                        </p>
                        <details>
                          <summary>File status & checksum</summary>
                          <p>Recorded state: {file.status}</p>
                          {file.sha256 && <code>{file.sha256}</code>}
                          <p>
                            File reference: <code>{file.id}</code>
                          </p>
                        </details>
                      </li>
                    ))}
                  </ul>
                  {visibleFiles < page.files.length && (
                    <button
                      className="text-button"
                      onClick={() => setVisibleFiles(visibleFiles + 50)}
                    >
                      Show more files on this page
                    </button>
                  )}
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
          {section === "evidence" && (
            <div className="technical-content">
              <h2>Technical evidence</h2>
              {collection.description && <p>{collection.description}</p>}
              <p>
                The exact catalog observations are retained here. An accepted
                check applies only to its stated scope.
              </p>
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
                <pre>{JSON.stringify(collection.periods, null, 2)}</pre>
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
    </article>
  );
}
