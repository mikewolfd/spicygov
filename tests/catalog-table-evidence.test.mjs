import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const built = await build({
  entryPoints: ["components/catalog-table-evidence.tsx"], bundle: true,
  platform: "node", format: "cjs", write: false,
  external: ["react", "react/jsx-runtime"],
});
const loaded = { exports: {} };
new Function("require", "module", "exports", built.outputFiles[0].text)(
  createRequire(import.meta.url), loaded, loaded.exports,
);
const generation = "sha256:" + "a".repeat(64);
const later = "sha256:" + "b".repeat(64);
const publication = {
  scope: "current", version: generation, status: "missing_provenance",
  sourceFiles: 8, matchedSourceFiles: 5, missingSourceFiles: 3,
  capturedSourceFiles: 5, inputClosureComplete: false,
  reasons: ["incomplete-build-input-provenance"], evidenceLinks: [],
};
const destination = {
  id: "table", family: "family", status: "publication-pinned",
  artifactDigest: generation, coverageNote: "Reviewed raw files cover 2020–2025.",
  publication,
};
function render(item = destination, current = { id: "table", artifactDigest: generation }) {
  return renderToStaticMarkup(createElement(loaded.exports.CatalogTableEvidence, {
    destination: item, current,
  }));
}
const visible = html => html.replace(/<details>[\s\S]*?<\/details>/g, "");

test("raw-file coverage and incomplete historical records remain separately visible", () => {
  const html = render();
  assert.match(visible(html), /Source coverage:.*Reviewed raw files cover 2020–2025/);
  assert.match(visible(html), /Past processing:.*Incomplete historical build records/);
  assert.doesNotMatch(visible(html), /exact historical file references|catalog-unmatched|3 .*missing/);
  assert.match(html, /<details><summary>How the published dataset was made<\/summary>/);
  assert.match(html, /3 exact historical file references have no accepted match/);
  assert.match(html, /catalog-unmatched references, not a count of missing raw files/);
});

test("missing source reviews and historical checks stay unknown", () => {
  const html = render({ ...destination, coverageNote: undefined, publication: undefined });
  assert.match(html, /Unknown; saved source coverage has not been reviewed/);
  assert.match(html, /Unknown; historical build records have not been checked/);
  assert.doesNotMatch(html, /complete|0 missing/);
});

test("generation drift qualifies the raw review and historical records independently", () => {
  const html = render(destination, { id: "table", artifactDigest: later });
  assert.match(html, /raw-file coverage review describes an earlier publication/);
  assert.match(html, /historical build records describe an earlier publication/);
  assert.ok(html.includes(generation));
  assert.ok(html.includes(later));
  assert.match(render(destination, { id: "table", publicationIdentity: later }), /raw-file coverage review describes an earlier publication/);
  assert.match(render(destination, { id: "table" }), /raw-file coverage review could not be compared/);
  assert.match(render(destination, { id: "table" }), /Current publication identity could not be compared/);
  assert.match(render({ ...destination, artifactDigest: undefined }), /raw-file coverage review could not be compared/);
});

test("conflicts and unmatched historical references have distinct attention messages", () => {
  const conflict = render({ ...destination, publication: { ...publication, status: "conflicting_evidence" } });
  assert.match(visible(conflict), /Historical build records conflict/);
  assert.doesNotMatch(visible(conflict), /Incomplete historical build records/);
  const unmatched = render({ ...destination, publication: { ...publication, status: "missing_local_files" } });
  assert.match(visible(unmatched), /Historical file references need review/);
  assert.doesNotMatch(visible(unmatched), /Missing local files|3 .*missing/);
});

test("verified historical records only describe the compared publication", () => {
  const checked = { ...destination, publication: { ...publication, status: "verified", inputClosureComplete: true } };
  assert.match(render(checked), /Build records complete for the checked publication/);
  for (const html of [render(checked, { id: "table", artifactDigest: later }), render(checked, { id: "table" }), render({ ...checked, publication: { ...checked.publication, scope: "historical" } })]) {
    assert.doesNotMatch(html, /Build records complete for the checked publication/);
    assert.match(html, /Build records complete for an earlier or unconfirmed publication/);
  }
});

test("coverage summaries require the complete reviewed wording", async () => {
  const fs = await import("node:fs/promises");
  const samNote = JSON.parse(await fs.readFile("content/catalog-coverage-copy.json", "utf8"));
  const [original, summary] = Object.entries(samNote).find(([note]) => note.startsWith("Retained SAM observations"));
  const html = render({ ...destination, coverageNote: original });
  assert.ok(visible(html).includes(summary));
  assert.doesNotMatch(visible(html), /named 15 journals/);
  assert.ok(html.includes(original));
  const revised = original + " Additional scope restriction.";
  assert.ok(visible(render({...destination,coverageNote:revised})).includes(revised));
});

test("short scorecard review preserves current custody and the separate older missing versions", async () => {
  const fs=await import("node:fs/promises");
  const copy=JSON.parse(await fs.readFile("content/catalog-coverage-copy.json","utf8"));
  const original=Object.keys(copy).find(note=>note.startsWith("Scorecard analysis derives"));
  const html=render({...destination,coverageNote:original});
  assert.match(visible(html),/selected source originals are saved in the central raw archive/);
  assert.match(visible(html),/older League of Conservation Voters selection still references 69 originals not located locally/);
  assert.match(visible(html),/newer captures are different versions/);
  assert.match(visible(html),/do not verify score interpretation or reproduce the published scores/);
  assert.ok(html.includes(original));
});

test("CFR filename year does not substitute for the sampled document edition", async () => {
  const fs=await import("node:fs/promises");
  const copy=JSON.parse(await fs.readFile("content/catalog-coverage-copy.json","utf8"));
  const original=Object.keys(copy).find(note=>note.startsWith("The named CFR-2025-title1-vol1"));
  const html=render({...destination,coverageNote:original});
  assert.match(visible(html),/Files named CFR-2025-title1-vol1 are saved/);
  assert.match(visible(html),/sampled XML prints a January 1, 2023 revision date/);
  assert.match(visible(html),/filename does not establish the requested 2025 edition; edition coverage remains unresolved/);
  assert.match(visible(html),/full annual XML for Title 14, volume 4 was not found/);
  assert.match(visible(html),/eCFR.*separate choices/);
  assert.doesNotMatch(visible(html),/The 2025 Title 1, volume 1 originals are saved/);
  assert.ok(html.includes(original));
});
