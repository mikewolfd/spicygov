import { build } from "esbuild";
await build({
  entryPoints: ["lib/parquet.worker.ts"],
  bundle: true,
  format: "esm",
  outfile: "public/parquet-worker.js",
  minify: true,
});
