# SpicyGov

Public government data, connected. Live at **https://spicygov.ai**.

A static React application deployed to GitHub Pages. The browser reads Parquet directly from `https://data.spicygov.ai` in a Web Worker; no application server, credentials, or preview-service account is required.

## Development

Requires Node.js 22.13 or newer.

```sh
npm ci
npm run dev
npm test
npm run build
```

`npm run preview` serves the production build. `npm run check:data` reads a first-column record from each currently published table.

## Deployment

Push to `main` or run **Deploy SpicyGov** in Actions. The workflow tests and builds the site, then deploys `dist/` to GitHub Pages. Repository Pages settings use GitHub Actions and the custom domain `spicygov.ai`. With the apex and `www` DNS records pointing to GitHub Pages, GitHub redirects `www.spicygov.ai` to the apex domain. Enable HTTPS enforcement when GitHub finishes provisioning the certificate.

The site is hosted at the root of its custom domain. It intentionally uses root-relative asset paths. GitHub Pages custom domains for Actions deployments are configured in repository settings, not through a CNAME artifact.

## Data and joins

`lib/catalog.ts` loads `publication.v2.json` live, resolving immutable generation paths and all member files for every published table. Metadata-only tables absent from that index are not represented as available. Errors never fall back to example records.

Descriptions and the 84 declared joins are bundled from the SpicyRegs dictionary, revision `014f193112c800ee3e71b3d3459ac8ba21bc4ba4` (October 3, 2026). Refresh `lib/data/table_metadata.json` and `lib/data/table_joins.json` when the dictionary changes. New published tables receive pages and live schemas automatically.

[Hyparquet](https://github.com/hyparam/hyparquet) reads selected fields over HTTP byte ranges. The reader handles multipart tables, exact filters, compound join keys, physical row cursors, and 64-bit integers. Filters apply across the whole table. Large scans may take time and can be stopped. Missing or null join values are not fabricated. Declared relationships do not prove the underlying source data is complete or correctly linked.

Dataset/filter state is stored in the URL. The mobile drawer, coverage notes, record details, and optional WebMCP browser tools use the same explorer state.

The dedicated MCP connection guide is at `/mcp/`. Vite builds a separate HTML entry so direct links work on GitHub Pages. The public connection endpoint remains `https://mcp.spicygov.ai/mcp`.

Scorecard descriptions and 30 publisher-table joins are refreshed from the committed
SpicyRegs dictionary at `3f85f28cdf2d1df9a40c1d3bb9ff556c470ca415`.
Six additional explorer links follow the resolver's documented exact identifiers:
member/item links back to their source rows include the source snapshot in the
composite key; resolved Bioguide, bill, vote, and amendment IDs lead to the
corresponding congressional tables. NULL identifiers are never followed.
These links browse current published records; `input_pins_json` preserves the
resolver's historical input identity. Publication discovery is automatic;
relationship metadata still requires a dictionary refresh.

## Sources directory

`/sources/` groups every table in the live publication catalog by its publishing
family. `lib/sources.ts` documents the source routes and derived-table notes from
SpicyRegs pipeline definitions. New families appear under “Source not yet
documented” until their origin is mapped; they are never omitted or guessed.
Search matches table labels, identifiers, source names, and source summaries.
