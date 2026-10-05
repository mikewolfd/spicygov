import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
const { outputFiles } = await build({
  entryPoints: ["lib/reader.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { readPage } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString("base64")}`
);
const files = [0, 1].map((n) =>
  readFileSync(new URL(`./fixtures/part${n}.parquet`, import.meta.url)),
);
const server = createServer((req, res) => {
  const file = files[Number(req.url.slice(1))];
  if (!file) {
    res.writeHead(404).end();
    return;
  }
  const match = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? "");
  if (match) {
    const start = Number(match[1]),
      end = Number(match[2]);
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${file.length}`,
      "Content-Length": end - start + 1,
    });
    res.end(file.subarray(start, end + 1));
  } else {
    res.writeHead(200, { "Content-Length": file.length });
    res.end(file);
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const table = {
  rows: 140,
  columns: [
    { name: "id", type: "VARCHAR" },
    { name: "group", type: "VARCHAR" },
    { name: "key", type: "VARCHAR" },
    { name: "large", type: "BIGINT" },
  ],
  members: files.map((f, i) => ({
    url: `http://127.0.0.1:${server.address().port}/${i}`,
    byteSize: f.length,
    rows: 70,
  })),
};
try {
  await test("paging crosses file boundaries without duplicates or skipped rows", async () => {
    let cursor = 0;
    const ids = [];
    let done = false;
    while (!done) {
      const p = await readPage({ table, columns: ["id"], filters: [], cursor });
      ids.push(...p.rows.map((r) => r.id));
      cursor = p.cursor;
      done = p.done;
    }
    assert.deepEqual(
      ids,
      Array.from({ length: 140 }, (_, i) => String(i)),
    );
  });
  await test("composite filters preserve exact values and NULL does not match", async () => {
    const p = await readPage({
      table,
      columns: ["id"],
      filters: [
        { column: "group", value: "a" },
        { column: "key", value: "2" },
      ],
      cursor: 0,
    });
    assert.deepEqual(
      p.rows.map((r) => r.id),
      Array.from({ length: 140 }, (_, i) => i)
        .filter((i) => i % 3 && i % 7 && i % 5 === 2)
        .map(String),
    );
    assert.equal(p.done, true);
  });
  await test("filtered pagination resumes after the last returned physical row", async () => {
    const a = await readPage({
      table,
      columns: ["id"],
      filters: [{ column: "group", value: "a" }],
      cursor: 0,
    });
    const b = await readPage({
      table,
      columns: ["id"],
      filters: [{ column: "group", value: "a" }],
      cursor: a.cursor,
    });
    assert.equal(a.rows.length, 40);
    assert.equal(b.rows.length, 40);
    assert.equal(new Set([...a.rows, ...b.rows].map((r) => r.id)).size, 80);
    assert.deepEqual(
      [...a.rows, ...b.rows].map((r) => r.id),
      Array.from({ length: 140 }, (_, i) => i)
        .filter((i) => i % 3)
        .slice(0, 80)
        .map(String),
    );
  });
  await test("record reads preserve 64-bit integers and exact physical position", async () => {
    const p = await readPage({
      table,
      columns: ["id", "large"],
      filters: [],
      cursor: 72,
      limit: 1,
    });
    assert.equal(p.rows[0].id, "72");
    assert.equal(String(p.rows[0].large), "9007199254741065");
    assert.deepEqual(p.positions, [72]);
  });
  await test("unknown fields are rejected", async () => {
    await assert.rejects(
      readPage({ table, columns: ["missing"], filters: [], cursor: 0 }),
      /Unknown field/,
    );
  });
  await test("zero matches completes across all files", async () => {
    const p = await readPage({
      table,
      columns: ["id"],
      filters: [{ column: "id", value: "does-not-exist" }],
      cursor: 0,
    });
    assert.equal(p.rows.length, 0);
    assert.equal(p.cursor, 140);
    assert.equal(p.done, true);
  });
  await test('text sorting covers every file, not just the visible page', async () => {
    const sort = {column: 'id', direction: 'asc'};
    const p = await readPage({table, columns: ['id'], filters: [], cursor: 0, sort});
    const expected = Array.from({length: 140}, (_, i) => String(i)).sort();
    assert.deepEqual(p.rows.map(row => row.id), expected.slice(0, 40));
    assert.equal(p.done, false);
    assert.deepEqual(p.positions, expected.slice(0, 40).map(Number));
  });
  await test('descending numeric sorting preserves adjacent 64-bit integers and record identity', async () => {
    const p = await readPage({table, columns: ['id', 'large'], filters: [], cursor: 0, sort: {column: 'large', direction: 'desc'}});
    assert.deepEqual(p.positions, Array.from({length: 40}, (_, i) => 139 - i));
    assert.deepEqual(p.rows.map(row => String(row.large)), Array.from({length: 40}, (_, i) => String(9007199254740993n + BigInt(139 - i))));
    const detail = await readPage({table, columns: ['id', 'large'], filters: [], cursor: p.positions[0], limit: 1});
    assert.deepEqual(detail.rows, [p.rows[0]]);
  });
  await test('sorted pagination keeps tied and null values across files without losing filtered records', async () => {
    const source = await readPage({table, columns: ['id', 'key', 'group'], filters: [], cursor: 0, limit: 200});
    for (const direction of ['asc', 'desc']) {
      const expected = source.rows.filter(row => row.group === 'a').sort((a, b) => {
        if (a.key == null && b.key != null) return 1;
        if (a.key != null && b.key == null) return -1;
        const comparison = a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
        return (direction === 'asc' ? comparison : -comparison) || Number(a.id) - Number(b.id);
      });
      let cursor = 0, done = false;
      const actual = [];
      while (!done) {
        const p = await readPage({table, columns: ['id', 'key'], filters: [{column: 'group', value: 'a'}], cursor, limit: 17, sort: {column: 'key', direction}});
        assert.equal(p.positions.length, p.rows.length);
        actual.push(...p.rows.map(row => row.id));
        cursor = p.cursor;
        done = p.done;
        assert.ok(actual.length <= expected.length);
      }
      assert.deepEqual(actual, expected.map(row => row.id));
      assert.equal(new Set(actual).size, expected.length);
    }
  });
  await test('sorted scans report full progress, support hidden sort fields, and finish zero matches', async () => {
    const progress = [];
    const p = await readPage({table, columns: ['id'], filters: [], cursor: 0, limit: 1, sort: {column: 'large', direction: 'desc'}}, n => progress.push(n));
    assert.equal(p.rows[0].id, '139');
    assert.equal('large' in p.rows[0], false);
    assert.equal(progress.at(-1), 140);
    const empty = await readPage({table, columns: ['id'], filters: [{column: 'id', value: 'absent'}], cursor: 0, sort: {column: 'id', direction: 'asc'}});
    assert.deepEqual(empty.rows, []);
    assert.equal(empty.done, true);
  });
  await test('unknown sort fields and invalid sorted boundaries are rejected', async () => {
    await assert.rejects(readPage({table, columns: ['id'], filters: [], cursor: 0, sort: {column: 'missing', direction: 'asc'}}), /Unknown field/);
    await assert.rejects(readPage({table, columns: ['id'], filters: [], cursor: 141, sort: {column: 'id', direction: 'asc'}}), /Invalid sort/);
    await assert.rejects(readPage({table, columns: ['id'], filters: [], cursor: 0, sort: {column: 'id', direction: 'sideways'}}), /Invalid sort/);
  });
} finally {
  server.close();
}
