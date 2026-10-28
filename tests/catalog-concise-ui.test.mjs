import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

async function component(path) {
  const built = await build({ entryPoints: [path], bundle: true, platform: "node", format: "cjs",
    write: false, loader: { ".css": "empty" }, external: ["react", "react/jsx-runtime"] });
  const loaded = { exports: {} };
  new Function("require", "module", "exports", built.outputFiles[0].text)(createRequire(import.meta.url), loaded, loaded.exports);
  return loaded.exports;
}
const { SourceCatalogStatus } = await component("components/source-table-detail.tsx");
const { CatalogFileList, matchingCatalogFiles } = await component("components/catalog-file-list.tsx");
const { catalogFileDownload } = await component("components/catalog-file-evidence.tsx");
const render = (type, props) => renderToStaticMarkup(createElement(type, props));
const outsideEvidence = html => {
  let depth = 0;
  return html.split(/(<details\b[^>]*>|<\/details>)/).filter(part => {
    if (part.startsWith("<details")) { depth++; return false; }
    if (part === "</details>") { depth--; return false; }
    return depth === 0;
  }).join("");
};

test("linked source loading and failures never claim absence", () => {
  for (const state of ["pending", "unavailable"]) {
    const html = render(SourceCatalogStatus, { state, onRetry() {} });
    assert.doesNotMatch(html, /No source is linked/);
    assert.match(html, state === "pending" ? /role="status".*Loading linked sources/ : /role="alert".*could not be loaded.*Retry catalog/);
  }
  assert.match(render(SourceCatalogStatus, { state: "ready" }), /No source is linked/);
});

test("file browsing shows 50 entries and scopes search to already loaded metadata", () => {
  const files = Array.from({ length: 60 }, (_, index) => ({ id: String(index), name: `Record ${index}`, status: "held" }));
  const html = render(CatalogFileList, { files });
  assert.equal((html.match(/<h3>/g) ?? []).length, 50);
  assert.match(html, /Search this loaded page/);
  assert.match(html, /Search covers this page only/);
  assert.match(html, /Show more files on this page/);
  assert.doesNotMatch(html, /<h3>Record 50/);
});

test("file search finds native date and source metadata without changing file evidence", () => {
  const file = { id: "native", name: "Annual volume.xml", status: "held", sourceId: "govinfo", sourceVersion: "2025",
    periods: [{ kind: "documented-publisher-scope", label: "2023 edition", start: "2023", end: "2023", basis: "source-record" }],
    metadataConflicts: ["Filename year differs from document edition"] };
  const files = [file, { id: "other", name: "Other data", status: "held" }];
  assert.deepEqual(matchingCatalogFiles(files, "govinfo 2023"), [file]);
  assert.deepEqual(matchingCatalogFiles(files, "2025 edition"), [file]);
  assert.deepEqual(matchingCatalogFiles(files, "2030"), []);
  const visible = outsideEvidence(render(CatalogFileList, { files: [file] }));
  assert.match(visible, /2023/);
  assert.match(visible, /role="alert".*Source details disagree/);
  assert.doesNotMatch(visible, /Source version|Source identifier|govinfo/);
});

test("requested dates retain their meaning and administrative metadata stays in details", () => {
  const file = {id:"scoped",name:"Requested records",status:"held",
    periods:[{kind:"requested-scope",label:"2025"}],
    metadataConflicts:["receipt-reference-unavailable","source-id-withheld","capture-time-invalid-or-unsupported","transport"]};
  const html=render(CatalogFileList,{files:[file]}), visible=outsideEvidence(html);
  assert.match(visible,/Dates we asked for: 2025/);
  assert.doesNotMatch(visible,/role="alert"|receipt-reference|source-id-withheld/);
  assert.match(html,/receipt-reference-unavailable/);
  assert.match(outsideEvidence(render(CatalogFileList,{files:[{...file,metadataConflicts:["periods"]}]})),/Recorded dates disagree/);
});

test("original downloads use guarded local archive keys and keep checksums collapsed", () => {
  const file = { id: "safe", name: "Original.json", status: "held", sha256: "sha256:" + "a".repeat(64),
    contentKey: "objects/original.json.gz", provenance: { availability: "local", basis: "unknown", sourceUrls: [] } };
  const html = render(CatalogFileList, { files: [file] });
  assert.match(outsideEvidence(html), /Download original \(.gz\)/);
  assert.doesNotMatch(outsideEvidence(html), /sha256:|File fingerprint|Capture date/);
  assert.match(html, /Technical evidence/);
  for (const key of ["../escape", "/absolute", "https://evil.invalid/file", "bad%2fkey", "bad?key", "bad\\key"]) {
    assert.equal(catalogFileDownload({ ...file, contentKey: key }), undefined);
  }
  assert.equal(catalogFileDownload({ ...file, provenance: { ...file.provenance, availability: "missing" } }), undefined);
});
