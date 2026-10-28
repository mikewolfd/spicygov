import { useEffect, useState } from "react";
import {
  count,
  publicationDate,
  tableCountUnit,
  type Dataset,
} from "../lib/catalog";
import {
  collectionSteps,
  parseGenerationDetails,
  publisherAttribution,
  reviewedGenerationLinks,
  type GenerationDetails,
  type SourceEntry,
} from "../lib/source-directory";
import { fetchJson, type EvidenceLink } from "../lib/publication-evidence";
import {
  loadObservationPreview,
  type ObservationPreview,
} from "../lib/source-observations";
import {
  parseCoverageMaps,
  coverageReading,
  textAvailabilityDetails,
  type CoverageMaps,
} from "../lib/coverage-map";
import {
  loadCoveragePublishers,
  type CoveragePublishers,
} from "../lib/coverage-publishers";
import {
  collectionTitle,
  readableCopy,
  relatedCollections,
  tableAttention,
  tablePublisher,
  tablePublisherAttribution,
} from "../lib/source-browser";
import type { CatalogCollection } from "../lib/source-catalog";
import { TableProvenance } from "./table-provenance";
import { TableCoverageMap } from "./coverage-map";
import type { TimeView } from "./time-coverage";

function Links({ links }: { links: EvidenceLink[] }) {
  return (
    <ul className="evidence-links">
      {links.map((link, i) => (
        <li key={`${link.url}-${i}`}>
          <a href={link.url} target="_blank" rel="noreferrer">
            {link.label} ↗
          </a>
        </li>
      ))}
    </ul>
  );
}

function ReleaseEvidence({
  entry,
  tables,
}: {
  entry: SourceEntry;
  tables: Dataset[];
}) {
  const { table } = entry,
    publication = table.publication;
  const [details, setDetails] = useState<GenerationDetails>();
  const [preview, setPreview] = useState<ObservationPreview>();
  const [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  async function load() {
    if (!publication || publication.kind !== "generation") return;
    setLoading(true);
    setError("");
    try {
      const next = parseGenerationDetails(
        await fetchJson(publication.recordUrl),
        table,
      );
      setDetails(next);
      const log = next.links.find(
        (link) => link.label === "Source observation journal",
      );
      if (log) {
        try {
          setPreview(await loadObservationPreview(log.url));
        } catch {
          setError(
            "The publication record loaded, but its source log could not be read.",
          );
        }
      }
    } catch {
      setError(
        "The recorded inputs could not be loaded or do not match this release.",
      );
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="technical-content">
      <p>
        {publication?.nativeReceipts
          ? "Record receipts link these records to saved source material or processing steps. They do not establish source completeness."
          : "No record receipts are listed for this table. Its collection notes do not establish each record’s origin."}
      </p>
      {publication?.kind === "comments" && (
        <p>
          This download can change after publication. Its export records file
          size, row count and checksum, but does not provide a source receipt
          for each comment.
        </p>
      )}
      {publication?.kind === "rulemaking" && (
        <p>
          This dataset is calculated from other data. Its publication records
          the output files; the collection notes explain the matching limits.
        </p>
      )}
      <Links
        links={[
          ...(publication
            ? [
                {
                  label: "Publication record (JSON)",
                  url: publication.recordUrl,
                },
              ]
            : []),
          ...(publication?.nativeReceipts
            ? [
                {
                  label: "Record receipts (Parquet)",
                  url: publication.nativeReceipts.url,
                },
              ]
            : []),
          ...(details?.links ?? reviewedGenerationLinks(entry)),
        ]}
      />
      {publication?.kind === "generation" && (
        <button
          className="text-button"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading
            ? "Reading saved inputs…"
            : details
              ? "Reload saved inputs"
              : "Inspect saved inputs and source log"}
        </button>
      )}
      {error && (
        <p role="alert">
          {error}{" "}
          <button className="text-button" onClick={() => void load()}>
            Try again
          </button>
        </p>
      )}
      {!!details?.parents.length && (
        <>
          <h3>Built using</h3>
          <ul>
            {details.parents.map((parent) => (
              <li key={parent.table}>
                {tables.find((item) => item.id === parent.table)?.label ??
                  parent.table}{" "}
                — a saved version; the current table may be newer.
              </li>
            ))}
          </ul>
        </>
      )}
      {details?.carriedForward && (
        <p>
          Earlier records were carried into this release. Publication does not
          mean they were collected again.
        </p>
      )}
      {preview?.inherited && (
        <p>
          These request examples do not describe the full history of inherited
          records.
        </p>
      )}
      {!!preview?.observations.length && (
        <>
          <h3>Source request examples</h3>
          <p>
            Examples from this release’s log, shared by its tables. They do not
            identify which request produced an individual row.
          </p>
          <ul className="evidence-observations">
            {preview.observations.map((item, i) => (
              <li key={i}>
                <strong>{item.source}</strong>
                <p>{item.purpose ?? "Request purpose not recorded"}</p>
                <p>
                  {item.observedAt
                    ? publicationDate(item.observedAt)
                    : "Date not recorded"}{" "}
                  ·{" "}
                  {item.saved === true
                    ? "Response saved"
                    : item.saved === false
                      ? "Response not saved"
                      : "Saved content unknown"}
                </p>
                <details>
                  <summary>Request details</summary>
                  <p>Endpoint: {item.endpoint}</p>
                  {item.selection && <p>Filters: {item.selection}</p>}
                  <p>Response status: {item.status ?? "Unknown"}</p>
                  {item.lastObservedAt && (
                    <p>Last observation: {item.lastObservedAt}</p>
                  )}
                  {item.examples && <p>{item.examples} examples</p>}
                </details>
              </li>
            ))}
          </ul>
        </>
      )}
      {preview?.partial && (
        <p>This is a limited preview, not the full source log.</p>
      )}
      <dl className="technical-facts">
        <div>
          <dt>Table identifier</dt>
          <dd>
            <code>{table.id}</code>
          </dd>
        </div>
        {table.artifactDigest && (
          <div>
            <dt>Published artifact</dt>
            <dd>
              <code>{table.artifactDigest}</code>
            </dd>
          </div>
        )}
        {!!details?.identityFields.length && (
          <div>
            <dt>Record identifiers</dt>
            <dd>{details.identityFields.join(", ")}</dd>
          </div>
        )}
      </dl>
      {!!entry.review?.evidence.length && (
        <details>
          <summary>Implementation references</summary>
          <Links links={entry.review.evidence} />
        </details>
      )}
      <p className="detail-caption">
        This page reads publication metadata; it does not verify file checksums
        or individual receipts.
      </p>
    </div>
  );
}

export function SourceTableDetail({
  entry,
  tables,
  collections,
  onCollection,
  catalogState,
  onRetryCatalog,
}: {
  entry: SourceEntry;
  tables: Dataset[];
  collections: CatalogCollection[];
  catalogState: "pending" | "unavailable" | "ready";
  onRetryCatalog?: () => void;
  onCollection: (id: string) => void;
}) {
  const { table, review } = entry;
  const [section, setSection] = useState("overview");
  const [maps, setMaps] = useState<CoverageMaps>(),
    [publishers, setPublishers] = useState<CoveragePublishers>();
  const [coverageError, setCoverageError] = useState(""),
    [retry, setRetry] = useState(0);
  const [time, setTime] = useState<TimeView>({
    year: new Date().getFullYear(),
    mode: "years",
  });
  useEffect(() => {
    const controller = new AbortController();
    setCoverageError("");
    void fetchJson("/coverage-maps.v1.json", controller.signal)
      .then(parseCoverageMaps)
      .then((value) => {
        if (!controller.signal.aborted) setMaps(value);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setCoverageError("Coverage counts could not be loaded.");
      });
    return () => controller.abort();
  }, [table, retry]);
  useEffect(() => {
    document.getElementById("detail-title")?.focus();
  }, []);
  useEffect(() => {
    if (section !== "coverage" || !maps) return;
    const controller = new AbortController();
    void loadCoveragePublishers([table], maps, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setPublishers(value); })
      .catch(() => { /* Recorded identifiers remain available if names cannot load. */ });
    return () => controller.abort();
  }, [table, maps, section]);
  const sources = relatedCollections(table, collections);
  const attention = tableAttention(entry);
  const coverage = coverageReading(table, maps);
  const attribution = tablePublisherAttribution(entry);
  const recordedSources = publisherAttribution(entry).sources;
  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "coverage", label: "Coverage by period" },
    { id: "sources", label: "Sources & history" },
    { id: "files", label: "Files" },
    { id: "evidence", label: "Technical evidence" },
  ];
  return (
    <article className="source-detail" aria-labelledby="detail-title">
      <div className="detail-eyebrow">
        {table.group} <span>/</span> Published data
      </div>
      <header className="detail-heading">
        <h1 id="detail-title" tabIndex={-1}>
          {table.label}
        </h1>
        <p>
          {readableCopy(
            review?.copy?.summary ||
              "Explore the available records and check the source dates and limitations below.",
          )}
        </p>
        <div className="detail-actions">
          {entry.explorer ? (
            <a
              className="primary-action"
              href={`/?table=${encodeURIComponent(table.id)}`}
            >
              Explore records <span aria-hidden="true">↗</span>
            </a>
          ) : (
            table.members[0] && (
              <a className="primary-action" href={table.members[0].url}>
                Download data (Parquet) ↗
              </a>
            )
          )}
          <span>{tablePublisher(entry)}{attribution.freshness === "earlier-release" && <small> · Earlier source notes</small>}{attribution.freshness === "unverified" && <small> · Recorded source notes</small>}</span>
        </div>
      </header>
      <dl className="detail-facts">
        <div>
          <dt>Records</dt>
          <dd>
            {count(table.rows)} {tableCountUnit(table)}
          </dd>
        </div>
        <div>
          <dt>Published</dt>
          <dd>
            {table.published
              ? publicationDate(table.published)
              : "Date not recorded"}
          </dd>
        </div>
        <div>
          <dt>Access</dt>
          <dd>
            {table.rows === 0
              ? "Empty table"
              : entry.explorer
                ? "Search and download"
                : "Download only"}
          </dd>
        </div>
      </dl>
      <nav className="detail-tabs" aria-label="Table details">
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
      <div className="detail-panel" key={section}>
        {section === "overview" && (
          <>
            {table.modelGenerated && <p className="context-note">AI-generated content. Check it against the original records.</p>}
            <section className="detail-section">
              <h2>Data dates</h2>
              {coverageError ? <p role="alert">{coverageError} <button className="text-button" onClick={() => setRetry(retry + 1)}>Try again</button></p>
                : !maps ? <p role="status">Checking recorded coverage…</p>
                : coverage ? <>
                  <p className="measurement-label">{coverage.release}</p>
                  <p><strong>{coverage.range || "Date range not measured"}</strong></p>
                  {coverage.range && <p className="detail-caption">{coverage.dimension.label} · Gaps may exist.</p>}
                </> : <p>Date range not measured.</p>}
              <button className="text-button" onClick={() => setSection("coverage")}>See counts by period →</button>
            </section>
            {(attention || !!review?.copy?.gaps.length) && <section className="detail-section">
              <h2>Before you use it</h2>
              {attention && <p className="context-note">{attention}</p>}
              {!!review?.copy?.gaps.length && <ul className="plain-list">
                {review.copy.gaps.map(gap => <li key={gap}>{readableCopy(gap)}</li>)}
              </ul>}
            </section>}
          </>
        )}
        {section === "coverage" && (
          <>
            <h2>Records by period</h2>
            <p>Select a period to see the measured record count.</p>
            <div className="coverage-controls">
              <label>
                View
                <select
                  value={time.mode}
                  onChange={(e) =>
                    setTime({
                      ...time,
                      mode: e.target.value as TimeView["mode"],
                    })
                  }
                >
                  <option value="years">Years</option>
                  <option value="months">Months</option>
                </select>
              </label>
              <label>
                {time.mode === "years" ? "Years ending in" : "Year"}
                <input
                  aria-label="Coverage year"
                  type="number"
                  min={1}
                  max={9999}
                  value={time.year}
                  onChange={(e) => {
                    const year = Number(e.target.value);
                    if (Number.isInteger(year) && year >= 1 && year <= 9999)
                      setTime({ ...time, year });
                  }}
                />
              </label>
            </div>
            {coverageError ? (
              <p role="alert">
                {coverageError}{" "}
                <button onClick={() => setRetry(retry + 1)}>Try again</button>
              </p>
            ) : !maps ? (
              <p role="status">Loading coverage…</p>
            ) : (
              <>
                <TableCoverageMap
                  table={table}
                  maps={maps}
                  view={time}
                  publishers={publishers}
                  onRetry={() => setRetry(retry + 1)}
                />
                {textAvailabilityDetails(table, maps).map((item) => (
                  <p key={item.label}>
                    {item.label}: {count(item.withText)} with text ·{" "}
                    {count(item.notSaved)} not saved · {count(item.blank)}{" "}
                    blank.
                  </p>
                ))}
              </>
            )}
          </>
        )}
        {section === "sources" && (
          <>
            <h2>Sources & history</h2>
            <details className="evidence-disclosure">
              <summary>Collection notes</summary>
              {review?.methods.length ? (
                <dl className="collection-methods">
                  {collectionSteps(review.methods).map((step) => (
                    <div key={step.label}>
                      <dt>{step.label}</dt>
                      <dd>{step.values.join(" · ")}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p>We haven’t added collection notes for this dataset yet.</p>
              )}
              <p className="detail-caption">Source notes may predate the current release.</p>
            </details>
            {sources.length ? (
              <ul className="linked-sources">
                {sources.map((item) => (
                  <li key={item.id}>
                    <button onClick={() => onCollection(item.id)}>
                      <span>
                        <strong>{collectionTitle(item)}</strong>
                        <small>
                          {item.publisher || "Publisher not recorded"} ·{" "}
                          {item.routeCount}{" "}
                          {item.routeCount === 1 ? "source" : "sources"}
                        </small>
                      </span>
                      <span aria-hidden="true">→</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <SourceCatalogStatus state={catalogState} onRetry={onRetryCatalog} />
            )}
            <details className="evidence-disclosure">
              <summary>Published source notes and input tables</summary>
              {attribution.freshness === "earlier-release" && <p>These publisher names were recorded in earlier source notes.</p>}
              {attribution.freshness === "unverified" && <p>Recorded publisher sources.</p>}
              <TableProvenance table={{ ...table, sources: recordedSources }} catalog={tables} />
            </details>
            {!!tables.filter(
              (item) => item.family === table.family && item.id !== table.id,
            ).length && (
              <details className="evidence-disclosure">
                <summary>Related published tables</summary>
                <Links
                  links={tables
                    .filter(
                      (item) =>
                        item.family === table.family && item.id !== table.id,
                    )
                    .map((item) => ({
                      label: item.label,
                      url: `/sources/?table=${encodeURIComponent(item.id)}`,
                    }))}
                />
              </details>
            )}
          </>
        )}
        {section === "files" && (
          <>
            <h2>Download data</h2>
            <p>Current release · Parquet format. Original files are listed under Sources & history.</p>
            <ul className="source-file-list">{table.members.map((member, index) => (
              <li key={member.url}>
                <a href={member.url}>Download {table.members.length === 1 ? "dataset" : `part ${index + 1}`} ↗</a>
                <p>{count(member.rows)} {tableCountUnit(table)}</p>
              </li>
            ))}</ul>
          </>
        )}
        {section === "evidence" && (
          <ReleaseEvidence entry={entry} tables={tables} />
        )}
      </div>
    </article>
  );
}

export function SourceCatalogStatus({ state, onRetry }: { state: "pending" | "unavailable" | "ready"; onRetry?: () => void }) {
  return state === "pending" ? <p role="status">Loading linked sources…</p>
    : state === "unavailable" ? <p role="alert">Linked sources could not be loaded. {onRetry && <button className="text-button" onClick={onRetry}>Retry catalog</button>}</p>
      : <p>No source is linked in this catalog.</p>;
}
