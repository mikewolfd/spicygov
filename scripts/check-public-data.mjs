import { build } from "esbuild";
const compile = async (path) => {
  const { outputFiles } = await build({
    entryPoints: [path],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString("base64")}`
  );
};
const { loadCatalog } = await compile("lib/catalog.ts");
const { readPage } = await compile("lib/reader.ts");
const catalog = await loadCatalog();
let next = 0,
  passed = 0;
const failures = [];
async function run() {
  while (next < catalog.length) {
    const table = catalog[next++];
    try {
      const result = await readPage({
        table,
        columns: [table.columns[0].name],
        filters: [],
        cursor: 0,
        limit: 1,
      });
      if (result.rows.length !== Math.min(1, table.rows))
        throw new Error("Unexpected record count");
      passed++;
    } catch (e) {
      failures.push({ table: table.id, error: e.message });
      console.log("FAIL", table.id, e.message);
    }
  }
}
await Promise.all([run(), run(), run()]);
console.log(JSON.stringify({ checked: catalog.length, passed, failures }));
if (failures.length) process.exitCode = 1;
