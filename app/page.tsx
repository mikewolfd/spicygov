"use client";
import { useEffect, useRef, useState } from "react";
import {
  Database,
  Search,
  Table2,
  Network,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
  ExternalLink,
  X,
  Menu,
  Link2,
  Columns3,
  Download,
  RefreshCw,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
} from "lucide-react";
import { useCollection } from "@/lib/use-collection";
import { SharedBrowse } from "@/components/shared-browse";
import { TableProvenance } from "@/components/table-provenance";
import { useExplorerTools } from "@/lib/webmcp";
import { initial, readLocation, makeHref, type LocationState, type View } from '@/lib/explorer-location';
import type { RecordSort } from '@/lib/record-sort';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  publicationDate,
  tableMetadataMessage,
  defaultColumns,
  count,
  compact,
  display,
  related,
  joinTarget,
  connectionFilters,
  connectionLabel,
  noConnectionsMessage,
  pretty,
  type Dataset,
  type Row,
  type Filter,
  type Join,
} from "@/lib/catalog";
const datasetSections = [
  { name: "Congress", description: "Bills, members & votes" },
  { name: "Regulation", description: "Agencies, rules & comments" },
  { name: "Elections", description: "Campaigns & political money" },
  { name: "Law & courts", description: "Laws, codes & court records" },
];
function shortSummary(table: Dataset) {
  return (
    (table.summary.length > 160
      ? table.summary.slice(0, 157).replace(/\s+\S*$/, "") + "…"
      : table.summary || "Explore the published records and their fields.")
  );
}
export default function Explorer() {
  const [location, setLocation] = useState<LocationState>(initial),
    [search, setSearch] = useState("");
  const [rows, setRows] = useState<Row[]>([]),
    [positions, setPositions] = useState<number[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(true),
    [progress, setProgress] = useState(0),
    [next, setNext] = useState(0),
    [done, setDone] = useState(false);
  const [columns, setColumns] = useState<string[]>([]),
    [record, setRecord] = useState<Row | null>(null),
    [connectionField, setConnectionField] = useState<string | null>(null),
    [recordError, setRecordError] = useState(""),
    [recordBusy, setRecordBusy] = useState(false),
    [mobile, setMobile] = useState(false),
    [retry, setRetry] = useState(0);
  const [filterOpen, setFilterOpen] = useState(false),
    [filterColumn, setFilterColumn] = useState(""),
    [filterValue, setFilterValue] = useState("");
  const worker = useRef<Worker | null>(null),
    recordWorker = useRef<Worker | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { tables: catalog, joins, metadata, error: catalogError, warnings: publicationWarnings = [], publicationsPending } = useCollection(retry);
  const table = catalog.find((t) => t.id === location.id),
    connections = table ? related(table.id, joins) : [];
  const activeColumns = columns.length
    ? columns
    : table
      ? defaultColumns(table)
      : [];
  function navigate(state: LocationState) {
    if (
      state.id !== location.id ||
      JSON.stringify(state.filters) !== JSON.stringify(location.filters) ||
      JSON.stringify(state.sort) !== JSON.stringify(location.sort)
    )
      state = { ...state, trail: [] };
    window.history.pushState({}, "", makeHref(state));
    setLocation(state);
    if (state.id !== location.id) {
      setColumns([]);
      setSearch("");
      if (listRef.current) listRef.current.scrollTop = 0;
    }
    setRecord(null);
    setMobile(false);
    setError("");
  }
  function choose(id: string) {
    navigate({ id, filters: [], cursor: 0, view: "records" });
  }
  function sortBy(column: string) {
    const current = location.sort;
    const sort: RecordSort | undefined = current?.column !== column
      ? {column, direction: 'asc'}
      : current.direction === 'asc' ? {column, direction: 'desc'} : undefined;
    navigate({...location, sort, cursor: 0});
  }
  useEffect(() => {
    setLocation(readLocation());
    const pop = () => {
      setLocation(readLocation());
      setColumns([]);
      setRecord(null);
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  useEffect(() => {
    if (catalogError) { setError(catalogError); setBusy(false); }
  }, [catalogError]);
  useEffect(() => {
    if (!table) {
      if (catalog.length && !publicationsPending) {
        setBusy(false);
        setError(
          "This dataset is not in the current publication. Choose a dataset from the collection.",
        );
      }
      return;
    }
    if (table.recordsAvailable === false) {
      setBusy(false); setRows([]); setError('Records are paused until the physical fields match this data release. You can still download the published file or reload the catalog.'); return;
    }
    setBusy(true);
    setRows([]);
    setError("");
    setProgress(location.sort ? 0 : location.cursor);
    setDone(false);
    const w = new Worker(new URL('../lib/parquet.worker.ts', import.meta.url), { type: "module" });
    worker.current = w;
    w.onmessage = (e) => {
      const d = e.data;
      if (d.type === "progress") setProgress(d.scanned);
      if (d.type === "result") {
        setRows(d.rows);
        setPositions(d.positions);
        setNext(d.cursor);
        setDone(d.done);
        setBusy(false);
      }
      if (d.type === "error") {
        setError(`We couldn’t read this file. ${d.message}`);
        setBusy(false);
      }
    };
    w.onerror = () => {
      setError("The Parquet reader stopped. Try reloading this dataset.");
      setBusy(false);
    };
    w.postMessage({
      table,
      columns: activeColumns,
      filters: location.filters,
      cursor: location.cursor,
      sort: location.sort,
    });
    return () => {
      w.terminate();
      worker.current = null;
    };
  }, [
    // Descriptions arriving must not cancel or restart an in-progress file scan.
    table?.id,
    JSON.stringify(table?.members),
    table ? false : publicationsPending,
    table?.recordsAvailable,
    location.id,
    JSON.stringify(location.filters),
    location.cursor,
    location.sort?.column,
    location.sort?.direction,
    JSON.stringify(activeColumns),
    retry,
  ]);
  useEffect(() => () => recordWorker.current?.terminate(), []);
  function openRecord(row: Row, index: number, field?: string) {
    if (!table) return;
    setConnectionField(field ?? null);
    setRecord(row);
    setRecordError("");
    setRecordBusy(true);
    recordWorker.current?.terminate();
    const w = new Worker(new URL('../lib/parquet.worker.ts', import.meta.url), { type: "module" });
    recordWorker.current = w;
    w.onmessage = (e) => {
      if (e.data.type === "result") {
        setRecord(e.data.rows[0] ?? row);
        setRecordBusy(false);
        w.terminate();
      }
      if (e.data.type === "error") {
        setRecordError(
          "Could not load the remaining fields. Close this record and try again.",
        );
        setRecordBusy(false);
        w.terminate();
      }
    };
    w.onerror = () => {
      setRecordError(
        "The record reader stopped. Close this record and try again.",
      );
      setRecordBusy(false);
    };
    w.postMessage({
      table,
      columns: table.columns.map((c) => c.name),
      filters: [],
      cursor: positions[index],
      limit: 1,
    });
  }
  function follow(join: Join, row: Row) {
    const t = joinTarget(join, location.id);
    if (
      !catalog.some((d) => d.id === t.id) ||
      !connectionFilters(join, location.id, row)
    )
      return;
    recordWorker.current?.terminate();
    navigate({
      id: t.id,
      filters: connectionFilters(join, location.id, row)!,
      cursor: 0,
      view: "records",
      from: table?.label,
    });
  }
  function browse(id: string, filters: Filter[]) {
    recordWorker.current?.terminate();
    navigate({id, filters, cursor: 0, view: "records", from: table?.label});
  }
  function cancel() {
    worker.current?.terminate();
    setBusy(false);
    setError("Reading stopped. Retry to finish checking this dataset.");
    setDone(true);
  }
  useExplorerTools(
    catalog,
    {
      id: location.id,
      filters: location.filters,
      busy,
      error,
      rows,
      columns: activeColumns,
      sort: location.sort,
    },
    (id, filters) => navigate({ id, filters, cursor: 0, view: "records" }),
  );
  const matching = catalog.filter((t) =>
    (t.label + " " + t.id).toLowerCase().includes(search.toLowerCase()),
  );
  const sidebar = (
    <>
      <div className="sidebar-heading">
        <span>THE COLLECTION</span>
        <span>{catalog.length || "…"}</span>
      </div>
      <div className="search-wrap">
        <Search size={16} />
        <Input
          aria-label="Find a dataset"
          placeholder="Find a dataset…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <nav className="section-shortcuts" aria-label="Jump to dataset section">
        <span className="section-shortcuts-label">JUMP TO SECTION</span>
        <div>
          {datasetSections.map(({ name }, index) => (
            <button
              type="button"
              key={name}
              disabled={!matching.some((t) => t.group === name)}
              onClick={(event) => {
                const panel = event.currentTarget.closest(".sidebar, .mobile-sidebar");
                const list = panel?.querySelector<HTMLElement>(".dataset-list");
                const section = list?.querySelector<HTMLElement>(`[data-section="${index}"]`);
                if (!list || !section) return;
                const top = section.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
                section.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
                list.scrollTo({ top, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
              }}
            >{name}<span aria-hidden="true">↓</span></button>
          ))}
        </div>
      </nav>
      <div className="dataset-list" ref={listRef}>
        {datasetSections.map(
          ({ name: group, description }, index) => {
            const items = matching.filter((t) => t.group === group);
            return items.length ? (
              <section key={group} data-section={index} aria-label={group}>
                <div className="dataset-section-heading">
                  <h2 tabIndex={-1}>{group}<span>{items.length}</span></h2>
                  <p>{description}</p>
                </div>
                {items.map((t) => (
                  <button
                    aria-current={t.id === location.id ? "page" : undefined}
                    className={`dataset-item ${t.id === location.id ? "selected" : ""}`}
                    key={t.id}
                    onClick={() => choose(t.id)}
                  >
                    <span>{t.label}</span>
                    <small>{compact(t.rows)}</small>
                  </button>
                ))}
              </section>
            ) : null;
          },
        )}
        {catalog.length > 0 && !matching.length && (
          <p className="small-empty">No datasets match “{search}”.</p>
        )}
      </div>
      <div className="sidebar-foot">
        <Database size={15} /> Straight from the source.
      </div>
    </>
  );
  return (
    <div className="app-shell">
      <a href="#explorer" className="skip-link">
        Skip to records
      </a>
      <header className="topbar">
        <a className="wordmark" href="/">
          spicygov
          <span className="brand-star" aria-hidden="true">
            ✳
          </span>
        </a>
        <nav aria-label="Main">
          <span className="nav-active" aria-current="page">Explore</span>
          <a href="/sources/">Sources</a>
          <a href="/mcp/">MCP</a>
          <a href="https://docs.spicygov.ai" target="_blank" rel="noreferrer">
            Data docs <ExternalLink size={13} />
          </a>
        </nav>
        <span className="header-note">PUBLIC DATA. OPEN POSSIBILITIES.</span>
        <Button
          className="mobile-menu"
          variant="ghost"
          size="icon"
          aria-label="Browse datasets"
          onClick={() => setMobile(true)}
        >
          <Menu />
        </Button>
      </header>
      <div className="workspace">
        <aside className="sidebar" aria-label="Datasets">
          {sidebar}
        </aside>
        <main className="main-pane" id="explorer">
          {publicationWarnings.map(warning => <p className="metadata-status" role="status" key={warning}>{warning} <button onClick={() => setRetry(retry + 1)}>Reload catalog</button></p>)}
          <div className="breadcrumb">
            Collection <ChevronRight size={13} />
            {table?.group ?? "Congress"}
            {location.from && (
              <>
                <ChevronRight size={13} />
                <span>Via {location.from}</span>
              </>
            )}
          </div>
          <div className="page-heading">
            <div>
              <p className="eyebrow">FOLLOW THE PUBLIC RECORD</p>
              <h1>
                {table?.label ??
                  (catalog.length
                    ? "Dataset unavailable"
                    : "Congressional bills")}
              </h1>
            </div>
            <span className="table-glyph">
              <Table2 size={32} strokeWidth={1.3} />
            </span>
          </div>
          <p className="intro">
            {(table ? shortSummary(table) : undefined) ??
              (error
                ? "Choose another dataset to keep exploring."
                : "Loading the published collection…")}
          </p>
          {table?.recordsAvailable === false ? <p className="metadata-status" role="status">Physical fields could not be confirmed for this release. <button onClick={() => setRetry(retry + 1)}>Reload catalog</button></p> : table && tableMetadataMessage(table.metadataState) && <p className="metadata-status" role="status">{tableMetadataMessage(table.metadataState)} {table.metadataState === "unavailable" && <button onClick={() => setRetry(retry + 1)}>Try again</button>}</p>}
          <div className="table-meta">
            <span>{table ? count(table.rows) : "—"} records</span>
            <span>{table?.recordsAvailable === false ? "Fields unavailable" : `${table?.columns.length ?? "—"} fields`}</span>
            <span>{connections.length} connections</span>
            <span className="format-label">PARQUET</span>
          </div>
          <Tabs
            value={location.view}
            onValueChange={(v) => navigate({ ...location, view: v as View })}
            className="explorer-tabs"
          >
            <TabsList variant="line" className="view-tabs">
              <TabsTrigger value="records">
                <Table2 size={16} /> Records
              </TabsTrigger>
              <TabsTrigger value="connections">
                <Network size={16} /> Connections
              </TabsTrigger>
              <TabsTrigger value="about">
                <BookOpen size={16} /> About the data
              </TabsTrigger>
            </TabsList>
          </Tabs>
          {table && <SharedBrowse key={table.id} table={table} catalog={catalog} filters={location.filters} onOpen={browse} />}
          {location.view === "records" && (
            <>
              <div className="table-toolbar">
                <span className="table-name">{table?.id ?? location.id}</span>
                <div className="toolbar-actions">
                  <Popover open={filterOpen} onOpenChange={setFilterOpen}>
                    <PopoverTrigger asChild>
                      <Button variant="ghost" size="sm" disabled={!table}>
                        <SlidersHorizontal /> Filter
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="filter-popover" align="end">
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (!filterColumn || !filterValue) return;
                          navigate({
                            ...location,
                            filters: [
                              ...location.filters.filter(
                                (f) => f.column !== filterColumn,
                              ),
                              { column: filterColumn, value: filterValue },
                            ],
                            cursor: 0,
                          });
                          setFilterOpen(false);
                        }}
                      >
                        <label htmlFor="filter-field">Field</label>
                        <NativeSelect
                          id="filter-field"
                          value={filterColumn}
                          onChange={(e) => setFilterColumn(e.target.value)}
                          required
                        >
                          <option value="">Choose a field</option>
                          {table?.columns.map((c) => (
                            <option key={c.name} value={c.name}>
                              {c.name}
                            </option>
                          ))}
                        </NativeSelect>
                        <label htmlFor="filter-value">Equals</label>
                        <Input
                          id="filter-value"
                          value={filterValue}
                          onChange={(e) => setFilterValue(e.target.value)}
                          placeholder="Exact value"
                          required
                        />
                        <Button type="submit">Apply filter</Button>
                      </form>
                    </PopoverContent>
                  </Popover>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="ghost" size="sm" disabled={!table}>
                        <Columns3 /> Fields
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="field-popover">
                      <p className="popover-title">Visible fields</p>
                      {table?.columns.map((c) => (
                        <label key={c.name} className="field-option">
                          <Checkbox
                            checked={activeColumns.includes(c.name)}
                            disabled={
                              activeColumns.length === 1 &&
                              activeColumns.includes(c.name)
                            }
                            onCheckedChange={(checked) =>
                              setColumns(
                                checked
                                  ? [...activeColumns, c.name]
                                  : activeColumns.filter((n) => n !== c.name),
                              )
                            }
                          />
                          <span>{c.name}</span>
                        </label>
                      ))}
                    </PopoverContent>
                  </Popover>
                </div>
              </div>
              {location.sort && (
                <div className="sort-status">
                  <span>Sorted by <strong>{location.sort.column}</strong> · {location.sort.direction === 'asc' ? 'Ascending' : 'Descending'} · Missing values last</span>
                  <button onClick={() => navigate({...location, sort: undefined, cursor: 0})} aria-label="Clear sort">Clear <X size={13} /></button>
                </div>
              )}
              {!!location.filters.length && (
                <div className="filter-chips">
                  {location.filters.map((f) => (
                    <button
                      key={f.column}
                      title="Remove filter"
                      onClick={() =>
                        navigate({
                          ...location,
                          filters: location.filters.filter((x) => x !== f),
                          cursor: 0,
                        })
                      }
                    >
                      <span>
                        {f.column} = <b>{f.value}</b>
                      </span>
                      <X size={13} />
                    </button>
                  ))}
                </div>
              )}
              <div className="data-scroll" aria-busy={busy}>
                <table className="data-table">
                  <caption className="sr-only">
                    {table?.label} records. Open a record to see every field and
                    related datasets.
                  </caption>
                  <thead>
                    <tr>
                      <th className="row-num" scope="col">
                        #
                      </th>
                      {activeColumns.map((c) => (
                        <th
                          key={c}
                          scope="col"
                          aria-sort={location.sort?.column === c ? location.sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}
                          title={
                            table?.columns.find((x) => x.name === c)
                              ?.description
                          }
                        >
                          <button
                            className="column-sort"
                            aria-label={location.sort?.column === c && location.sort.direction === 'desc' ? `Restore original order for ${c}` : `Sort ${c} ${location.sort?.column === c ? 'descending' : 'ascending'}`}
                            onClick={() => sortBy(c)}
                          >
                            {c}
                            {location.sort?.column === c ? location.sort.direction === 'asc' ? <ArrowUp size={13} aria-hidden="true" /> : <ArrowDown size={13} aria-hidden="true" /> : <ArrowUpDown size={13} aria-hidden="true" />}
                          </button>
                          {connections.some((j) =>
                            joinTarget(j, location.id).local.includes(c),
                          ) && <Link2 size={12} className="column-link" />}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={positions[i]} onClick={() => openRecord(r, i)}>
                        <td className="row-num">
                          <button
                            aria-label={`Open record ${positions[i] + 1}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              openRecord(r, i);
                            }}
                          >
                            {count(positions[i] + 1)}
                          </button>
                        </td>
                        {activeColumns.map((c) => {
                          const links = connections.filter(
                            (j) =>
                              joinTarget(j, location.id).local.includes(c) &&
                              connectionFilters(j, location.id, r) !== null,
                          );
                          return (
                            <td key={c}>
                              {links.length ? (
                                <button
                                  className="cell-link"
                                  title="Explore this field’s connections"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openRecord(r, i, c);
                                  }}
                                >
                                  {display(r[c])}
                                  <Link2 size={12} />
                                </button>
                              ) : (
                                <span
                                  className={
                                    c.endsWith("_id") ? "identifier" : ""
                                  }
                                >
                                  {display(r[c])}
                                </span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {busy && (
                  <div className="loading-state" role="status">
                    <span className="loader" />
                    <span>
                      {location.sort
                        ? `Sorting ${location.filters.length ? 'matching' : 'all'} records · ${count(progress)} of ${table ? count(table.rows) : '…'} rows checked`
                        : location.filters.length
                        ? `Finding matches · ${count(progress)} of ${table ? count(table.rows) : "…"} rows checked`
                        : "Reading Parquet…"}
                    </span>
                    <Button variant="ghost" size="sm" onClick={cancel}>
                      Stop
                    </Button>
                  </div>
                )}
                {error && (
                  <div role="alert" className="error-state">
                    <p>{error}</p>
                    <Button
                      variant="outline"
                      onClick={() => setRetry((n) => n + 1)}
                    >
                      <RefreshCw /> Retry
                    </Button>
                  </div>
                )}
                {!busy && !error && !rows.length && (
                  <div className="empty-state">
                    <Search size={28} />
                    <h2>
                      {table?.rows === 0
                        ? "No records published yet"
                        : "No matching records"}
                    </h2>
                    <p>
                      {table?.rows === 0
                        ? "This dataset is published with an empty table."
                        : "The selected values did not match any records in this publication."}
                    </p>
                    {!!location.filters.length && (
                      <Button
                        variant="outline"
                        onClick={() =>
                          navigate({
                            ...location,
                            filters: [],
                            cursor: 0,
                            from: undefined,
                          })
                        }
                      >
                        Clear filters
                      </Button>
                    )}
                  </div>
                )}
              </div>
              <footer className="table-footer">
                <span aria-live="polite">
                  {busy
                    ? "Reading…"
                    : `${count(rows.length)} ${location.filters.length ? "matching " : ""}records${done ? " · End of results" : ""}`}
                </span>
                <div className="pagination">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || location.cursor === 0}
                    onClick={() =>
                      navigate({
                        ...location,
                        cursor: location.trail?.at(-1) ?? 0,
                        trail: location.trail?.slice(0, -1) ?? [],
                      })
                    }
                  >
                    <ChevronLeft /> Previous
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || done || !!error}
                    onClick={() =>
                      navigate({
                        ...location,
                        cursor: next,
                        trail: [...(location.trail ?? []), location.cursor],
                      })
                    }
                  >
                    Next <ChevronRight />
                  </Button>
                </div>
              </footer>
            </>
          )}
          {location.view === "connections" && (
            <div className="details-scroll">
              <div className="section-intro">
                <h2>See where this data leads.</h2>
                <p>
                  Choose a dataset, or open a record to follow its matching
                  values.
                </p>
              </div>
              <div className="connection-list">
                {connections.map((j, i) => {
                  const t = joinTarget(j, location.id),
                    target = catalog.find((d) => d.id === t.id);
                  return (
                    <div className="connection-row" key={i}>
                      <Network size={20} />
                      <div>
                        <button disabled={!target} onClick={() => choose(t.id)}>
                          {connectionLabel(j, target?.label ?? pretty(t.id))}
                        </button>
                        <p>
                          <code>{t.local.join(" + ")}</code>
                          <span> joins </span>
                          <code>{t.remote.join(" + ")}</code>
                        </p>
                        {j.reason && (
                          <details>
                            <summary>What this link means</summary>
                            <p>{j.reason}</p>
                          </details>
                        )}
                        {!target && <p>Not in the current publication</p>}
                      </div>
                      <span className="relation-type">
                        {j.kind === "complete"
                          ? "Declared join"
                          : j.kind === "empty"
                            ? "No key baseline"
                            : j.kind === "scope"
                              ? "Some targets missing"
                              : j.kind === "unmeasured" ? "Awaiting key check" : "By design"}
                      </span>
                    </div>
                  );
                })}
                {!connections.length && noConnectionsMessage(table) && (
                  <p className="small-empty">{noConnectionsMessage(table)}</p>
                )}
                {table?.connectionNotes.map((note, i) => <p key={i} className="small-empty">{note}</p>)}
              </div>
            </div>
          )}
          {location.view === "about" && table && (
            <div className="details-scroll">
              <div className="about-top">
                <div>
                  <h2>What’s in this dataset</h2>
                  <p>{table.summary || "A description is not yet available for this table."}</p>
                </div>
                <div className="publication-info">
                  <span>Published</span>
                  <strong>
                    {publicationDate(table.published)}
                  </strong>
                  <span>
                    {table.members.length}{" "}
                    {table.members.length === 1 ? "file" : "files"} ·{" "}
                    {(table.bytes / 1024 / 1024).toFixed(1)} MB
                  </span>
                </div>
              </div>
              <TableProvenance table={table} catalog={catalog} />
              {table.rows === 0 && <p className="empty-publication">No rows in this publication. {table.emptyReason || "No reason is documented."}</p>}
              <details className="coverage-note">
                <summary>
                  Coverage & limitations <span>{table.kind}</span>
                </summary>
                <p>
                  {table.coverage ||
                    "No additional coverage description is available."}
                </p>
                {table.quality && <p>{table.quality}</p>}
              </details>
              <details className="coverage-note">
                <summary>
                  <Download size={15} /> Parquet files
                </summary>
                <ul className="file-links">
                  {table.members.map((m, i) => (
                    <li key={m.url}>
                      <a href={m.url} target="_blank" rel="noreferrer">
                        {table.members.length === 1
                          ? `${table.id}.parquet`
                          : `Part ${i + 1}`}
                        <ExternalLink size={13} />
                      </a>
                      <span>{count(m.rows)} records</span>
                    </li>
                  ))}
                </ul>
              </details>
              <h2 className="fields-heading">The fields</h2>
              <div className="schema-list">
                {table.columns.map((c) => (
                  <div key={c.name}>
                    <code>{c.name}</code>
                    <span>{c.type}</span>
                    <p>
                      {c.description || "No field description is available."}
                    </p>
                  </div>
                ))}
              </div>
              <p className="metadata-note">
                Records, descriptions, sources and declared connections load from the current publication.
                {metadata.generatedAt && ` Metadata updated ${publicationDate(metadata.generatedAt)}.`}
                {" "}Publication dates describe when files were published, not the dates covered by their records.
              </p>
            </div>
          )}
        </main>
      </div>
      <Sheet open={mobile} onOpenChange={setMobile}>
        <SheetContent side="left" className="mobile-sidebar">
          <SheetHeader>
            <SheetTitle>Browse datasets</SheetTitle>
            <SheetDescription>Explore the public collection.</SheetDescription>
          </SheetHeader>
          {sidebar}
        </SheetContent>
      </Sheet>
      <Sheet
        open={record !== null}
        onOpenChange={(open) => {
          if (!open) {
            recordWorker.current?.terminate();
            setRecord(null);
          }
        }}
      >
        <SheetContent className="record-sheet">
          <SheetHeader>
            <p className="eyebrow">PUBLIC RECORD</p>
            <SheetTitle>{table?.label}</SheetTitle>
            <SheetDescription>
              Follow the linked fields to keep exploring.
            </SheetDescription>
          </SheetHeader>
          <div className="record-scroll">
            {recordBusy && (
              <p className="record-loading" role="status">
                Loading remaining fields…
              </p>
            )}
            {recordError && <p className="error-state">{recordError}</p>}
            {record &&
              connections.some((j) =>
                connectionFilters(j, location.id, record) !== null,
              ) && (
                <details
                  className="record-connections"
                  open={!!connectionField}
                >
                  <summary>
                    Connected records
                    {connectionField ? ` · ${connectionField}` : ""}
                  </summary>
                  <div className="record-join-list">
                    {connections
                      .filter(
                        (j) =>
                          (!connectionField ||
                            joinTarget(j, location.id).local.includes(
                              connectionField,
                            )) &&
                          connectionFilters(j, location.id, record) !== null,
                      )
                      .map((j, i) => {
                        const t = joinTarget(j, location.id),
                          target = catalog.find((d) => d.id === t.id);
                        return (
                          <button
                            key={i}
                            disabled={!target}
                            onClick={() => follow(j, record)}
                            title={j.reason || `Join on ${t.local.join(", ")}`}
                          >
                            <Network size={16} />
                            <span>
                              {connectionLabel(j, target?.label ?? pretty(t.id))}
                              <small>
                                {t.local
                                  .map((k) => `${k}: ${display(record[k])}`)
                                  .join(" · ")}
                              </small>
                            </span>
                            <ChevronRight size={16} />
                          </button>
                        );
                      })}
                  </div>
                </details>
              )}
            {table && record && !recordBusy && <SharedBrowse key={table.id} table={table} catalog={catalog} filters={location.filters} row={record} onOpen={browse} />}
            <dl className="record-fields">
              {table?.columns
                .filter((c) => record && c.name in record)
                .map((c) => (
                  <div key={c.name}>
                    <dt>
                      {c.name}
                      <span>{c.type}</span>
                    </dt>
                    <dd>
                      {/^https?:\/\//.test(display(record![c.name])) ? (
                        <a
                          target="_blank"
                          rel="noreferrer"
                          href={display(record![c.name])}
                        >
                          {display(record![c.name])}
                          <ExternalLink size={13} />
                        </a>
                      ) : (
                        display(record![c.name])
                      )}
                    </dd>
                  </div>
                ))}
            </dl>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
