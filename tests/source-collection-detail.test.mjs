import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

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

test("collection details distinguish unavailable publication information from confirmed absence", () => {
  assert.match(render("pending"), /Checking published datasets/);
  assert.match(render("unavailable"), /Published dataset availability is unknown/);
  for (const state of ["pending", "unavailable"]) {
    assert.doesNotMatch(render(state), /No published dataset linked here/);
  }
  assert.match(render("ready"), /No published dataset linked here/);
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
  assert.match(html, /Retained public comments/);
  assert.match(html, /Comments publication/);
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
