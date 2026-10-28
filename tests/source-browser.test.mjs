import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const output = await build({
  entryPoints: ["lib/source-browser.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const browser = await import(
  `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].contents).toString("base64")}`
);
const collection = (overrides = {}) => ({
  id: "source",
  title: "Federal Register documents",
  publisher: "Federal Register",
  statuses: [],
  tables: [],
  families: [],
  holdings: { objects: 0, aliases: 0, decodedBytes: 0, missing: 0 },
  periods: [],
  ...overrides,
});
test("source scope uses current admitted descriptions without inventing date coverage", () => {
  const entry = {
    explorer: true,
    table: { rows: 157, metadataState: "current", coverage: "Selected retained comment files; broader publisher coverage is not implied." },
  };
  assert.equal(browser.tableScope(entry), entry.table.coverage);
  assert.equal(browser.tableAttention(entry), undefined);
  assert.equal(browser.tableScope({ ...entry, review: { copy: { scope: "Reviewed selected scope." } } }), "Reviewed selected scope.");
  assert.equal(browser.tableScope({ ...entry, review: {} }), entry.table.coverage);
  for (const metadataState of ["loading", "missing", "incompatible", "older-publication", "undocumented", "unavailable"]) {
    const stale = { ...entry, table: { ...entry.table, metadataState } };
    assert.equal(browser.tableScope(stale), undefined, metadataState);
    assert.equal(!!browser.tableAttention(stale), ["incompatible", "unavailable"].includes(metadataState), metadataState);
  }
  const undescribed = { ...entry, table: { ...entry.table, coverage: "  " } };
  assert.equal(browser.tableScope(undescribed), undefined);
  assert.equal(browser.tableAttention(undescribed), undefined);
  assert.equal(browser.tableAttention({ ...entry, table: { ...entry.table, rows: 0 } }), "No records published");
});
test("a source title wins over an incidental mention in a different publisher’s description", () => {
  const direct = browser.searchRank(
    "federal register",
    "Federal Register documents",
    "Office of the Federal Register",
  );
  const indirect = browser.searchRank(
    "federal register",
    "Search.gov analytics",
    "GSA",
    "Queries include the Federal Register",
  );
  assert.ok(direct > indirect);
  assert.ok(indirect > 0);
  assert.equal(
    browser.searchRank("federal_register", "Federal Register documents"),
    direct,
  );
  assert.equal(
    browser.searchRank("unrelated", "Federal Register documents"),
    0,
  );
});
test("missing counts and saved files never imply complete coverage or current lineage", () => {
  const unknown = collection();
  assert.equal(
    browser.collectionAvailability(unknown, new Set()).id,
    "unknown",
  );
  const uncollected = collection({ statuses: ["known-not-acquired"] });
  assert.equal(
    browser.collectionAvailability(uncollected, new Set()).id,
    "uncollected",
  );
  assert.equal(
    browser.collectionAttention(uncollected),
    "Source not downloaded",
  );
  const partiallyHeld = collection({
    holdings: { objects: 12, aliases: 15, decodedBytes: 100, missing: 2 },
  });
  assert.equal(
    browser.collectionAvailability(partiallyHeld, new Set()).id,
    "held",
  );
  assert.match(browser.collectionAttention(partiallyHeld), /2.*missing/);
  const linked = collection({
    tables: ["records"],
    statuses: ["known-not-acquired"],
  });
  assert.equal(
    browser.collectionAvailability(linked, new Set(["records"])).id,
    "linked",
  );
  assert.equal(browser.collectionAttention(linked), "Source not downloaded");
});
test("requested or publisher dates cannot become observed coverage", () => {
  const requested = {
    kind: "requested-scope",
    label: "Requested 1900–2026",
    start: "1900",
    end: "2026",
    basis: "requested-scope",
  };
  const offered = {
    ...requested,
    kind: "documented-publisher-scope",
    basis: "Publisher documentation",
  };
  const observed = {
    ...requested,
    kind: "observed-retained-scope",
    start: "1994",
    basis: "Saved records",
  };
  assert.equal(
    browser.periodSummary(collection({ periods: [requested, offered] })),
    "See dates in source details",
  );
  assert.match(
    browser.periodSummary(
      collection({ periods: [requested, observed, observed] }),
    ),
    /^1994/,
  );
  assert.equal(
    browser.uniquePeriods([requested, offered, observed, observed]).length,
    3,
  );
  assert.notEqual(browser.periodLabel(requested), browser.periodLabel(offered));
  assert.notEqual(browser.periodLabel(offered), browser.periodLabel(observed));
});
test("source navigation requires an explicit table connection, not just a shared family", () => {
  const table = { id: "current", family: "shared" };
  const direct = collection({ id: "direct", tables: ["current"] });
  const similar = collection({
    id: "similar",
    tables: ["old"],
    families: ["shared"],
  });
  assert.deepEqual(browser.relatedCollections(table, [direct, similar]), [
    direct,
  ]);
});
test("a shared detail URL preserves search, filters, and result page", () => {
  const state = {
    view: "catalog",
    query: "Older rules & notices",
    topic: "Regulation",
    availability: "held",
    period: "2024",
    includeUnknown: false,
    page: 3,
    collection: "family:federal-register",
  };
  assert.deepEqual(browser.readBrowserLocation(browser.browserSearch(state)), {
    ...state,
    table: undefined,
  });
  assert.equal(browser.readBrowserLocation("?page=-9&view=invalid").page, 1);
  assert.equal(browser.readBrowserLocation("?page=200000").page, 10000);
});

test("a missing end date and conflicting publisher notes remain explicit", () => {
  assert.match(
    browser.periodRange({ start: "1994-01-01" }),
    /Jan 1, 1994.*end date unknown/,
  );
  assert.match(
    browser.periodRange({
      label: "1995 or 2000; scope disagreement preserved",
    }),
    /different date ranges/,
  );
  assert.equal(
    browser.periodRange({ start: "2026-04-13", end: "2026-04-13" }),
    "Apr 13, 2026",
  );
});

test("download status stays separate from a published destination and unknown missing counts", () => {
  const linked = collection({tables: ['records'], statuses: ['known-not-acquired']});
  assert.equal(browser.collectionAvailability(linked, new Set(['records'])).id, 'linked');
  assert.equal(browser.collectionDownload(linked), 'Not downloaded');
  assert.equal(browser.collectionLimitation(linked), 'Source not downloaded');
  const held = collection({statuses: ['published-with-baseline'], holdings: {objects: 10, missing: 0}});
  assert.equal(browser.collectionDownload(held), 'Downloaded files available');
  assert.match(browser.collectionLimitation(held), /earlier saved dataset/);
  assert.match(browser.collectionLimitation(collection()), /not been confirmed/);
});

test('download and missing-file filters still find sources that have published destinations', () => {
  const item = collection({tables: ['records'], holdings: {objects: 10, missing: 2}});
  const tables = new Set(['records']);
  for (const filter of ['held', 'missing', 'review', 'linked']) {
    assert.equal(browser.matchesCollectionAvailability(item, filter, tables), true, filter);
  }
  assert.equal(browser.matchesCollectionAvailability(item, 'uncollected', tables), false);
});


const source = (name, id = name) => ({ id, name, kind: "official", note: "" });
const publication = "sha256:" + "a".repeat(64);
const publisherEntry = (table = {}, review) => ({
  table: { sources: [], metadataState: "current", artifactDigest: publication, ...table },
  review,
  source: source("Calculated from other tables"),
});

test("publisher labels summarize every current name rather than the first source", () => {
  const publishers = [source("AFSCME"), source("League of Conservation Voters")];
  assert.equal(browser.tablePublisher(publisherEntry({ sources: publishers })), "Multiple publishers");
  assert.equal(browser.tablePublisher(publisherEntry({ sources: publishers.toReversed() })), "Multiple publishers");
  assert.equal(browser.tablePublisher(publisherEntry({ sources: [source("AFSCME")] })), "AFSCME");
  assert.equal(browser.tablePublisher(publisherEntry({ sources: [source(" AFSCME ", "route-a"), source("AFSCME", "route-b")] })), "AFSCME");
});

test("publisher labels keep current source descriptions ahead of reviewed fallback names", () => {
  const reviewed = { artifactDigest: publication, sources: [source("Reviewed publisher")] };
  assert.equal(browser.tablePublisher(publisherEntry({ sources: [source("Current publisher")] }, reviewed)), "Current publisher");
  assert.equal(browser.tablePublisher(publisherEntry({}, reviewed)), "Reviewed publisher");
  assert.equal(browser.tablePublisher(publisherEntry({}, { ...reviewed, sources: [source("First"), source("Second")] })), "Multiple publishers");
});

test("publisher labels preserve recorded attribution with explicit freshness and reject generic source-group captions", () => {
  const reviewed = { artifactDigest: "sha256:" + "b".repeat(64), sources: [source("Earlier publisher")] };
  assert.equal(browser.tablePublisher(publisherEntry({}, reviewed)), "Earlier publisher");
  assert.equal(browser.tablePublisherAttribution(publisherEntry({}, reviewed)).freshness, "earlier-release");
  assert.equal(browser.tablePublisher(publisherEntry({ artifactDigest: undefined }, { sources: [source("Unpinned publisher")] })), "Unpinned publisher");
  assert.equal(browser.tablePublisherAttribution(publisherEntry({ artifactDigest: undefined }, { sources: [source("Unpinned publisher")] })).freshness, "unverified");
  assert.equal(browser.tablePublisher(publisherEntry()), "Publisher not recorded");
  assert.equal(browser.tablePublisher(publisherEntry({ sources: [source("  ")] })), "Publisher not recorded");
  for (const metadataState of ["loading", "missing", "incompatible", "older-publication", "unavailable"]) {
    const entry = publisherEntry({ metadataState, sources: [source("Earlier metadata publisher")] });
    assert.equal(browser.tablePublisher(entry), "Earlier metadata publisher", metadataState);
    assert.equal(browser.tablePublisherAttribution(entry).freshness, ["incompatible", "older-publication"].includes(metadataState) ? "earlier-release" : "unverified", metadataState);
  }
});


test("publisher search retains every eligible name when the caption summarizes multiple publishers", () => {
  const entry = publisherEntry({ sources: [source("21Wilberforce"), source("AFSCME"), source(" AFSCME ", "second-route")] });
  const names = browser.tablePublisherNames(entry);
  assert.deepEqual(names, ["21Wilberforce", "AFSCME"]);
  for (const query of names) {
    assert.equal(browser.searchRank(query, "Scorecards", names.join(" ")), 40);
  }
  const stale = publisherEntry({}, { artifactDigest: "sha256:" + "b".repeat(64), sources: [source("Earlier publisher")] });
  assert.deepEqual(browser.tablePublisherNames(stale), ["Earlier publisher"]);
  assert.equal(browser.searchRank("Earlier publisher", "Scorecards", browser.tablePublisherNames(stale).join(" ")), 40);
  assert.equal(browser.tablePublisherAttribution(stale).freshness, "earlier-release");
});

test("generation-matched incomplete descriptions retain their supplied publisher names", () => {
  const entry = publisherEntry({ metadataState: "undocumented", sources: [source("Recorded publisher")] });
  assert.deepEqual(browser.tablePublisherNames(entry), ["Recorded publisher"]);
  assert.equal(browser.tablePublisher(entry), "Recorded publisher");
});


test("v2 bounded period summaries preserve list dates and scope uncertainty", () => {
  const observed = {kind:"observed-retained-scope",label:"Saved records",start:"1994",end:"1995",basis:"Saved rows"};
  const legacy=collection({periods:[observed,observed]});
  const slim=collection({periods:undefined,periodSummary:{count:2000,observedRetained:observed}});
  assert.equal(browser.periodSummary(slim),browser.periodSummary(legacy));
  assert.equal(browser.periodSummary(collection({periods:undefined,periodSummary:{count:2000}})),"See dates in source details");
  assert.equal(browser.periodSummary(collection({periods:undefined,periodSummary:{count:0}})),"Dates not confirmed");
});
test("unlinked inventory does not turn linked publication entries into uncollected sources", () => {
  const item=collection({statuses:["inventory-unresolved"],tables:["records"]});
  assert.equal(browser.collectionAvailability(item,new Set(["records"])).id,"linked");
  assert.equal(browser.collectionAttention(item),undefined);
  assert.equal(browser.collectionLimitation(item),"Source files not linked to this entry");
  assert.equal(browser.collectionDownload(item),"Downloads not confirmed");
  assert.equal(browser.matchesCollectionAvailability(item,"uncollected",new Set(["records"])),false);
  assert.equal(browser.matchesCollectionAvailability(item,"review",new Set(["records"])),false);
  const external=collection({statuses:["external-by-choice"],tables:["records"]});
  assert.equal(browser.collectionAvailability(external,new Set()).id,"external");
  assert.equal(browser.collectionDownload(external),"Stored elsewhere");
  assert.equal(browser.matchesCollectionAvailability(external,"uncollected",new Set(["records"])),false);
});

test("collection purpose and evidence limits answer different questions", () => {
  const sam = collection({id:"family:sam-entities",tables:["sam_entities"],description:"A baseline preserves table facts that the retained original-source history does not establish."});
  assert.match(browser.collectionDescription(sam), /Organizations registered in the System for Award Management/);
  assert.doesNotMatch(browser.collectionDescription(sam), /baseline|provenance/);
  assert.match(browser.collectionLimitations(sam).join(" "), /historical snapshots/);
  assert.match(browser.collectionLimitations(sam).join(" "), /reproduce every published record/);
  assert.match(browser.collectionDescription(collection({id:"family:cfr-sections"})), /looking up federal agency rules/);
  assert.match(browser.collectionDescription(collection({id:"family:comments-mirror"})), /kept elsewhere by choice/);
});

test("saved errors, missing files, external files and unknown availability stay distinct", () => {
  const summarize = (status, availability) => browser.fileAvailabilitySummary({status,provenance:availability ? {availability} : undefined});
  assert.match(summarize("parse-error","local"), /could not be read; usable content has not been confirmed/);
  assert.match(summarize("held","missing"), /missing locally/);
  assert.match(summarize("held","external"), /kept elsewhere by choice/);
  assert.match(summarize("held","not-acquired"), /download not recorded/);
  assert.match(summarize("held"), /availability is not checked/);
  assert.match(summarize("other"), /availability is unknown/);
});

test("retention never promotes saved refusals or unchecked JSON into usable data", () => {
  for (const status of ["refused-source", "failed-response", "incomplete-response", "unclassified-source"]) {
    const message = browser.fileAvailabilitySummary({status,provenance:{availability:"local"}});
    assert.match(message,/Saved/);
    assert.match(message,/not usable data|usable data is not confirmed/);
    assert.match(message,/Bytes saved locally/);
  }
  const held=browser.fileAvailabilitySummary({status:"held",provenance:{availability:"local"}});
  assert.match(held,/usable content has not been confirmed/);
  assert.match(browser.collectionAttention(collection({statuses:["refused-source"]})), /refused|error/);
});

test("older missing-byte rows remain missing when provenance metadata is absent", () => {
  assert.match(browser.fileAvailabilitySummary({status:"missing-bytes"}), /missing locally/);
});

test("conflicting receipts and metadata remain separate from byte availability", () => {
  for (const [status, wording] of [
    ["conflicting-receipt", /receipt evidence disagrees; the file’s origin needs review/],
    ["conflicting-metadata", /metadata records disagree; the source information needs review/],
  ]) {
    const local = browser.fileAvailabilitySummary({status,provenance:{availability:"local"}});
    assert.match(local, wording);
    assert.match(local, /Bytes saved locally/);
    const missing = browser.fileAvailabilitySummary({status,provenance:{availability:"missing"}});
    assert.match(missing, wording);
    assert.match(missing, /missing locally/);
    assert.doesNotMatch(missing, /Bytes saved locally/);
    const unknown = browser.fileAvailabilitySummary({status});
    assert.match(unknown, wording);
    assert.match(unknown, /availability is unknown/);
  }
});

test("native election-cycle and edition labels remain visible without invented dates", () => {
  assert.equal(browser.periodRange({kind:"election-cycle",label:"2024",basis:"explicit-retained-scope"}),"2024");
  assert.equal(browser.periodRange({kind:"edition",label:"2025 edition",basis:"publisher-label"}),"2025 edition");
  assert.match(browser.periodRange({kind:"unknown",label:"Unknown",basis:"no-period"}), /Exact dates aren’t recorded/);
});

test("unlinked inventory counts do not imply source originals are absent", () => {
  assert.equal(browser.collectionHoldingsSummary(collection({statuses:["inventory-unresolved"]})),"No files linked to this entry yet.");
  assert.equal(browser.collectionHoldingsSummary(collection({holdings:{objects:4}})),"4 distinct files saved locally.");
});


test("information-only catalog states do not become gaps, while concrete problems remain visible", () => {
  for (const status of ["inventory-unresolved", "integration-unresolved", "unclassified-source", "receipt-only", "published-with-baseline", "external-by-choice"]) {
    const item = collection({statuses:[status]});
    assert.equal(browser.collectionAttention(item), undefined, status);
    assert.equal(browser.matchesCollectionAvailability(item, "review", new Set()), false, status);
    assert.ok(browser.collectionLimitation(item), status);
  }
  for (const status of ["missing-bytes", "refused-source", "parse-error", "failed-response", "partial", "partial-source", "incomplete-response", "conflicting-receipt", "conflicting-metadata", "known-not-acquired"]) {
    const item = collection({statuses:["inventory-unresolved", status]});
    assert.ok(browser.collectionAttention(item), status);
    assert.equal(browser.matchesCollectionAvailability(item, "review", new Set()), true, status);
    assert.equal(browser.collectionLimitation(item), browser.collectionAttention(item), status);
  }
});

test("empty-result readiness requires every input used by the selected view", () => {
  for (const catalog of ["pending","unavailable","ready"]) {
    for (const publications of ["pending","unavailable","ready"]) {
      assert.equal(browser.browserDataState("catalog",catalog,publications),catalog);
      assert.equal(browser.browserDataState("available",catalog,publications),publications);
      const expected=[catalog,publications].includes("unavailable") ? "unavailable"
        : [catalog,publications].includes("pending") ? "pending" : "ready";
      assert.equal(browser.browserDataState("attention",catalog,publications),expected);
    }
  }
});

test("partial source coverage is distinct from an incomplete response", () => {
  assert.equal(browser.collectionAttention(collection({statuses:["partial"]})),"Saved source coverage is partial");
  assert.equal(browser.collectionAttention(collection({statuses:["incomplete-response"]})),"Saved source response is incomplete");
});

test("a current reviewed publisher outranks older metadata without promoting older source coverage", () => {
  const entry = publisherEntry({metadataState:"older-publication", sources:[source("Earlier publisher")], coverage:"Old scope"}, {artifactDigest:publication, sources:[source("Current reviewed publisher")]});
  assert.deepEqual(browser.tablePublisherAttribution(entry), {names:["Current reviewed publisher"],freshness:"current"});
  assert.equal(browser.tableScope(entry), undefined);
  assert.equal(browser.tableAttention(entry), undefined);
});
