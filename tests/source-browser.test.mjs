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
