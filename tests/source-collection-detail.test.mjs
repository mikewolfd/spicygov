import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";

const built = await build({
  entryPoints: ["components/source-collection-detail.tsx"],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  external: ["react", "react/jsx-runtime"],
});
const loaded = { exports: {} };
new Function("require", "module", "exports", built.outputFiles[0].text)(
  createRequire(import.meta.url), loaded, loaded.exports,
);
const collection = {
  id: "family:bill-family", title: "Bill family", tables: ["congress_bills"],
  statuses: ["held", "publication-pinned"], periods: [],
  holdings: { objects: 1, aliases: 1, decodedBytes: 10, missing: 0 },
};
const render = (publicationState, tables = []) => renderToStaticMarkup(
  createElement(loaded.exports.SourceCollectionDetail, {
    reader: {}, manifest: {}, collection, tables, publicationState, onTable() {},
  }),
);

test('quarter summary is tied to the current published table and names empty quarters', () => {
  const hash = 'sha256:' + 'a'.repeat(64);
  const table = { id: 'federal_register', family: 'federal-register', rows: 2, artifactDigest: hash,
    columns: [{ name: 'publication_date', type: 'VARCHAR' }],
    members: [{ sha256: hash, rows: 2, byteSize: 100 }] };
  const map = { family: table.family, rows: 2, artifactDigest: hash,
    fingerprint: JSON.stringify([[hash, 2, 100]]), inputsFingerprint: '[]',
    schema: [['publication_date', 'VARCHAR']], dimensions: [{ id: 'federal-register-publication-dates',
      granularity: 'month', buckets: { '2024-01': 1, '2024-07': 1 }, latestDate: '2024-07-18', unplacedRows: 0 }] };
  const renderSummary = (dataset, coverage) => renderToStaticMarkup(createElement(
    loaded.exports.FederalRegisterQuarterSummary, { table: dataset, maps: { tables: { federal_register: coverage } } },
  ));
  const current = renderSummary(table, map);
  assert.match(current, /Published records: 2024 Q1, 2024 Q3/);
  assert.match(current, /No dated published records: 2024 Q2/);
  assert.match(current, /Latest record: Jul 18, 2024/);
  assert.match(current, /Saved source files have not been checked by quarter/);
  const stale = renderSummary({ ...table, rows: 3 }, map);
  assert.match(stale, /have not been checked for this release/);
  assert.doesNotMatch(stale, /2024 Q2/);
});

test('source quarter evidence is shown only for its catalog generation', async () => {
  const source = JSON.parse(await readFile('content/federal-register-source-periods.json', 'utf8'));
  const renderSummary = generation => renderToStaticMarkup(createElement(
    loaded.exports.FederalRegisterQuarterSummary, { generation },
  ));
  const current = renderSummary(source.generation);
  assert.match(current, /Saved source files with indexed dates: 1994 Q1–2026 Q3/);
  assert.match(current, /Latest indexed source date: Sep 2, 2026/);
  assert.match(current, /Unindexed source dates are unverified/);
  assert.doesNotMatch(renderSummary('sha256:' + 'b'.repeat(64)), /Saved source files with indexed dates/);
});

test("collection details distinguish unavailable publication information from confirmed absence", () => {
  assert.match(render("pending"), /Loading datasets/);
  assert.match(render("unavailable"), /Published datasets could not be checked/);
  for (const state of ["pending", "unavailable"]) {
    assert.doesNotMatch(render(state), /No published data/);
  }
  assert.match(render("ready"), /No published data/);
  const known = [{ id: "congress_bills", rows: 1 }];
  assert.match(render("pending", known), /Explore data/);
  assert.match(render("ready", known), /Explore data/);
});

test("unrecognized collections retain catalog descriptions before fallback copy", () => {
  const renderDescription = (source, description) => renderToStaticMarkup(
    createElement(loaded.exports.SourceCollectionDetail, {
      reader: {}, manifest: {}, collection: source, description, tables: [],
      publicationState: "ready", onTable() {},
    }),
  );
  const unrecognized = { ...collection, id: "family:other-records" };
  const explicit = renderDescription({ ...unrecognized,
    description: "Local original comment files are retained; the wider mirror remains external.",
  }, "Table summary describes published records.");
  assert.match(explicit, /Local original comment files are retained; the wider mirror remains external/);
  assert.doesNotMatch(explicit, /Table summary describes published records/);
  assert.match(renderDescription(unrecognized, "Table summary describes published records."), /Table summary describes published records/);
  assert.match(renderDescription({ ...unrecognized, publisher: "Public records publisher" }), /Data and documents from Public records publisher/);
  assert.match(renderDescription(unrecognized), /A known source of public records/);
});

test("source relationships link exact catalog collections and preserve route labels and scope limits", () => {
  const source = { ...collection, id: "family:comments-mirror", title: "Retained public comments" };
  const publication = { ...collection, id: "publication:comments", title: "Comments publication" };
  const detail = {
    routes: [{ id: "mirror-route", label: "External mirror" }],
    relationships: [
      { id: "related", kind: "related-source-inventory", fromId: source.id, toId: publication.id,
        scope: "Selected retained comment files.", note: "Exact historical table inputs are not established." },
      { id: "routes", kind: "separate-captures", fromId: "mirror-route", toId: "unresolved-source" },
    ],
  };
  const html = renderToStaticMarkup(createElement(loaded.exports.SourceRelationships, {
    detail, collections: [source, publication],
  }));
  assert.match(html, /href="\/sources\/\?view=catalog&amp;collection=family%3Acomments-mirror"/);
  assert.match(html, /href="\/sources\/\?view=catalog&amp;collection=publication%3Acomments"/);
  assert.match(html, /Public comment source files/);
  assert.match(html, /Public comment data/);
  assert.match(html, /Selected retained comment files/);
  assert.match(html, /Exact historical table inputs are not established/);
  assert.match(html, /External mirror → unresolved-source/);
  assert.doesNotMatch(html, /collection=(?:mirror-route|unresolved-source)/);
});

test("known subjects lead with purpose and general processing limits leave the header", () => {
  const source = { ...collection, id: "family:sam-entities", tables: ["sam_entities"],
    description: "A baseline preserves table facts that the retained original-source history does not establish." };
  const html = renderToStaticMarkup(createElement(loaded.exports.SourceCollectionDetail, {
    reader: {}, manifest: {}, collection: source, tables: [], publicationState: "ready", onTable() {},
  }));
  assert.match(html, /System for Award Management/);
  assert.doesNotMatch(html, /Registration years describe registrations, not historical snapshots/);
  assert.doesNotMatch(html, /Saved source files alone have not been shown to reproduce every published record/);
  assert.doesNotMatch(html, /A baseline preserves/);
});

test("the detail view shows files, datasets and process notes without a disclosure", () => {
  const source = { ...collection, id: "family:other-records", publisher: "Example publisher", tables: ["records"],
    statuses: ["partial-source"], description: "Acquisition metadata describes a partial crawl." };
  const html = renderToStaticMarkup(createElement(loaded.exports.SourceCollectionDetail, {
    reader: {}, manifest: {}, collection: source,
    tables: [{ id: "records", label: "Useful records", rows: 42 }],
    publicationState: "ready", onTable() {},
  }));
  const [front, details] = html.split('<section class="source-details" aria-label="Details">');
  assert.match(front, /Example publisher/);
  assert.match(front, /1 saved file/);
  assert.match(front, /Explore data/);
  assert.match(front, /<a href="\/\?table=records">Useful records<\/a>/);
  assert.match(front, /42 records/);
  assert.doesNotMatch(front, /Saved source coverage is partial|Acquisition metadata|Has published data|Source details/);
  assert.match(details, /Acquisition metadata describes a partial crawl/);
  assert.match(details, /Saved source coverage is partial/);
  assert.match(details, /aria-label="Source details"/);
  assert.match(details, /Sources &amp; history/);
  assert.match(details, /Technical evidence/);
  assert.doesNotMatch(html, /<details class="source-details"/);
});

test("external holdings remain visible and unavailable publication checks do not look like absent data", () => {
  const html = renderToStaticMarkup(createElement(loaded.exports.SourceCollectionDetail, {
    reader: {}, manifest: {}, collection: { ...collection, statuses: ["external-by-choice"],
      holdings: { ...collection.holdings, objects: 0 } },
    tables: [], publicationState: "unavailable", onTable() {},
  }));
  const front = html.split('<section class="source-details" aria-label="Details">')[0];
  assert.match(front, /0 saved files/);
  assert.match(front, /Source files are stored elsewhere/);
  assert.match(front, /Published datasets could not be checked/);
  assert.doesNotMatch(front, /No published data|Files not confirmed|Publisher not recorded/);
});

test("period overview shows discrete election cycles while qualifying source scope", () => {
  const html = renderToStaticMarkup(createElement(loaded.exports.SourcePeriodOverview, {
    periods:[{kind:"election-cycle",label:"2024",basis:"explicit-retained-scope"},{kind:"election-cycle",label:"2026",basis:"explicit-retained-scope"}],
  }));
  assert.match(html,/Recorded data periods/);
  assert.match(html,/Election cycle<\/dt><dd>2024 · 2026/);
  assert.match(html,/May be requested or partial/);
  assert.doesNotMatch(html,/complete saved or published coverage/);
  assert.doesNotMatch(html,/dates in the saved records|Exact dates aren’t recorded/);
});

test("period overview keeps requested, observed and unknown periods distinct", () => {
  const renderPeriods = periods => renderToStaticMarkup(createElement(loaded.exports.SourcePeriodOverview,{periods}));
  assert.match(renderPeriods([{kind:"requested-scope",label:"2024",basis:"requested-scope"}]),/Dates we asked for/);
  assert.match(renderPeriods([{kind:"observed-retained-scope",label:"Saved record dates",start:"1994",end:"1995",basis:"census"}]),/Dates in the saved records/);
  assert.match(renderPeriods([{kind:"unknown",label:"Unknown",basis:"no-period"}]),/haven’t confirmed/);
});

test("period overview stays bounded without turning discrete cycles into a continuous range", () => {
  const periods=Array.from({length:24},(_,i)=>({kind:"election-cycle",label:String(1980+i*2),basis:"explicit-retained-scope"}));
  const html=renderToStaticMarkup(createElement(loaded.exports.SourcePeriodOverview,{periods}));
  assert.match(html,/1980 · 1982 · 1984 … 24 recorded periods/);
  assert.doesNotMatch(html,/1980[–-]2026|>2026</);
});

const renderPeriods = (periods, id, families = []) => renderToStaticMarkup(
  createElement(loaded.exports.SourcePeriodOverview, {
    periods, collection: id ? { id, families } : undefined,
  }),
);

test("legislative sources default to Congress while retaining every alternative period view", () => {
  const html = renderPeriods([
    { kind: "issue-date", label: "2026-10-01", basis: "native scope" },
    { kind: "observed-retained-scope", label: "Saved dates", start: "1994", end: "2026", basis: "census" },
    { kind: "requested-scope", label: "2024", basis: "requested-scope" },
    { kind: "documented-publisher-scope", label: "1973 onward", start: "1973", basis: "publisher" },
    { kind: "congress", label: "119", basis: "Retained per-file mapping; completeness unknown" },
  ], "family:bill-family", ["bill-family"]);
  assert.match(html, /<option value="congress:Congress" selected="">Congress<\/option>/);
  assert.match(html, /<dt>Congress<\/dt><dd>119<\/dd>/);
  assert.match(html, /Issue date<\/option>/);
  assert.match(html, /Dates found in saved records<\/option>/);
  assert.match(html, /Dates we asked for<\/option>/);
  assert.match(html, /Dates offered by the publisher<\/option>/);
  assert.match(html, /May be requested or partial/);
  assert.doesNotMatch(html, /<dd>1994 – 2026|Dates in the saved records<\/h2>/);
});

test("election sources prefer native cycles over requested cycles and calendar dates", () => {
  const html = renderPeriods([
    { kind: "requested-election-cycle", label: "2024", basis: "requested-scope" },
    { kind: "observed-retained-scope", label: "Saved dates", start: "2025", end: "2026", basis: "census" },
    { kind: "election-cycle", label: "2026", basis: "native scope" },
  ], "family:fec-query", ["fec-query"]);
  assert.match(html, /<option value="election-cycle:Election cycle" selected="">Election cycle<\/option>/);
  assert.match(html, /<dt>Election cycle<\/dt><dd>2026<\/dd>/);
  assert.match(html, /Dates we asked for<\/option>/);
  assert.doesNotMatch(html, /<dd>2024|2024 – 2026/);
});

test("CFR editions keep their requested qualification instead of claiming observed editions", () => {
  const html = renderPeriods([
    { kind: "requested-issue-date", label: "2026-08-18", basis: "native/requested scope; completeness unknown" },
    { kind: "observed-retained-scope", label: "2025/2026 edition labels", basis: "analysis" },
    { kind: "requested-edition", label: "2023", basis: "native/requested scope; completeness unknown" },
    { kind: "documented-publisher-scope", label: "eCFR since 2017", start: "2017", basis: "publisher" },
  ], "family:cfr-sections", ["cfr-sections"]);
  assert.match(html, /<option value="requested-edition:Requested edition" selected="">Requested edition<\/option>/);
  assert.match(html, /<dt>Requested edition<\/dt><dd>2023<\/dd>/);
  assert.match(html, /Requested issue date<\/option>/);
  assert.match(html, /May be requested or partial/);
  assert.doesNotMatch(html, /Dates in the saved records|Saved records ·/);
});

test("agenda edition defaults use recorded edition values without inventing coverage", () => {
  const html = renderPeriods([
    { kind: "documented-publisher-scope", label: "Publisher history", basis: "publisher" },
    { kind: "declared-period", label: "202410", basis: "native/requested scope; completeness unknown" },
    { kind: "declared-period", label: "202510", basis: "native/requested scope; completeness unknown" },
    { kind: "observed-retained-scope", label: "Selected native editions", basis: "replay" },
  ], "family:unified-agenda", ["unified-agenda"]);
  assert.match(html, /<dt>Declared agenda edition<\/dt><dd>202410 · 202510<\/dd>/);
  assert.match(html, /May be requested or partial/);
  assert.doesNotMatch(html, /202410 – 202510|202410-202510/);
});

test("date-based sources prefer the measured saved-record range over publisher and request scopes", () => {
  const html = renderPeriods([
    { kind: "publication-date", label: "2003-02-03", basis: "native/requested scope; completeness unknown" },
    { kind: "requested-publication-range", label: "2022-02-03/2022-05-03", basis: "requested-scope" },
    { kind: "documented-publisher-scope", label: "API documents from 1994 forward", start: "1994-01-01", basis: "publisher" },
    { kind: "observed-retained-scope", label: "Retained dated records", start: "1994-01-03", end: "2026-10-09", basis: "analysis.json FR census" },
  ], "family:federal-register", ["federal-register"]);
  assert.match(html, /<option value="observed-retained-scope:Dates found in saved records" selected="">/);
  assert.match(html, /Dates in the saved records<\/h2>/);
  assert.match(html, /Jan 3, 1994 – Oct 9, 2026/);
  assert.match(html, /Saved records · Gaps may exist; published dates may differ/);
  assert.match(html, /Publication date<\/option>/);
  assert.match(html, /Dates we asked for<\/option>/);
  assert.doesNotMatch(html, /Jan 1, 1994 –|complete coverage/);
});

test("unknown sources retain usable recorded groups and do not invent periods", () => {
  const unknown = renderPeriods([{ kind: "unknown", label: "Unknown", basis: "no-period" }], "family:future-source");
  assert.match(unknown, /haven’t confirmed the dates/);
  assert.doesNotMatch(unknown, /<select|<dd>/);
  const known = renderPeriods([{ kind: "native-season", label: "Spring 2026", basis: "publisher" }], "family:future-source");
  assert.match(known, /<dt>Native season<\/dt><dd>Spring 2026<\/dd>/);
  assert.doesNotMatch(known, /<select/);
});
