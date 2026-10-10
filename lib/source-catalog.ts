/** Shared, generation-bound metadata reader. File partitions load only on request. */
export type CatalogPeriod = { kind: string; label: string; start?: string; end?: string; basis: string };
export type CatalogCollection = { id: string; title: string; publisher?: string; description?: string; statuses: string[]; families: string[]; tables: string[]; routeCount: number; holdings: { aliases: number; objects: number; decodedBytes: number; missing: number }; periods: CatalogPeriod[]; detailPath: string; localPath?: string; encodedBytes?: number; verification?: string; internalOnly?: unknown };
export type CatalogManifest = { format: 'spicy-source-catalog'; version: 1; generation: string; generatedAt: string; collections: CatalogCollection[]; totals: Record<string, number>; localPath?: string; encodedBytes?: number; verification?: string; internalOnly?: unknown };
export type CatalogRoute = { id: string; label: string; deliveryMethod: string; lifecycle: string; custodian: string; contentBehavior: string; accessUrl?: string; periods: CatalogPeriod[]; status?: string; note?: string; localPath?: string; encodedBytes?: number; verification?: string; internalOnly?: unknown };
export type CatalogFile = { id: string; name: string; status: string; sha256?: string; bytes?: number; routeId?: string; localPath?: string; encodedBytes?: number; verification?: string; internalOnly?: unknown };
export const coverageStages = ['expected', 'advertised', 'acquired', 'processed', 'published'] as const;
export type CoverageStage = typeof coverageStages[number];
export type CoverageMeasurement = { count: number; unit: string; routeId?: string; version?: string; evidenceBasis: string; scope: { collectionId?: string; table?: string; observationId?: string; capturedAt?: string; qualificationScope?: string }; period: { kind?: string; label?: string; start?: string; end?: string } | null };
export type CatalogCoverage = { completenessDenominator: null; stages: Record<CoverageStage, { status: 'unknown' | 'evidence-recorded' | 'scope-withheld'; measurements: CoverageMeasurement[] }> };
export type CatalogDetail = { format: 'spicy-source-collection'; version: 1; generation: string; collection: CatalogCollection; routes: CatalogRoute[]; tables: { id: string; family: string; status: string; artifactDigest?: string; coverageNote?: string }[]; files: { pages: { path: string; rows: number }[]; total: number }; planned: Record<string, unknown>[]; observations: Record<string, unknown>[]; relationships: Record<string, unknown>[]; coverage?: CatalogCoverage; localPath?: string; encodedBytes?: number; verification?: string; internalOnly?: unknown };
export type CatalogFilePage = { format: 'spicy-source-files'; version: 1; generation: string; collectionId: string; files: CatalogFile[]; localPath?: string; encodedBytes?: number; verification?: string; internalOnly?: unknown };
const internalFields = ['audience', 'localPath', 'encodedBytes', 'verification', 'internalOnly'];
function object(raw: unknown): Record<string, unknown> { if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Catalog object expected'); return raw as Record<string, unknown>; }
function fields(raw: unknown, allowed: string[], internal: boolean) { const value = object(raw); for (const key of Object.keys(value)) if (!allowed.includes(key) && !(internal && internalFields.includes(key))) throw Error(`Unsupported catalog field: ${key}`); return value; }
function string(raw: unknown) { if (typeof raw !== 'string' || !raw.trim()) throw Error('Catalog text expected'); return raw; }
function optionalString(raw: unknown) { if (raw !== undefined) string(raw); }
function number(raw: unknown) { if (!Number.isSafeInteger(raw) || (raw as number) < 0) throw Error('Nonnegative catalog count expected'); }
function array(raw: unknown): unknown[] { if (!Array.isArray(raw)) throw Error('Catalog array expected'); return raw; }
function strings(raw: unknown) { array(raw).forEach(string); }
function unique(raw: unknown[], key: string) { const ids = raw.map(row => string(object(row)[key])); if (new Set(ids).size !== ids.length) throw Error(`Duplicate catalog ${key}`); }
function header(raw: unknown, format: string, allowed: string[], internal: boolean, generation?: string) { const value = fields(raw, ['format', 'version', 'generation', ...allowed], internal); if (value.format !== format || value.version !== 1) throw Error('Unsupported source catalog version'); if (!/^sha256:[a-f0-9]{64}$/.test(string(value.generation))) throw Error('Invalid catalog generation'); if (internal && value.audience !== 'internal') throw Error('Internal catalog audience required'); if (generation && value.generation !== generation) throw Error('Catalog generation changed; reload the catalog'); return value; }
export function catalogPartitionUrl(manifestUrl: string, path: string): string {
  if (!path || path.includes('\\') || path.includes('%') || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..') || /[?#:]/.test(path)) throw Error('Unsafe catalog partition path');
  const base = new URL(manifestUrl, typeof location === 'undefined' ? 'http://localhost' : location.href);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw Error('Unsafe catalog manifest URL');
  const resolved = new URL(path, new URL('.', base));
  if (resolved.origin !== base.origin || !resolved.pathname.startsWith(new URL('.', base).pathname)) throw Error('Catalog partition leaves its directory');
  return resolved.href;
}
function publicSafe(raw: unknown, key = ''): void {
  if (/^(local.*path.*|.*credential.*|.*token.*|.*password.*|.*secret.*|storage|internalOnly|encodedBytes|verification|audience)$/i.test(key)) throw Error(`Internal catalog field in public metadata: ${key}`);
  if (typeof raw === 'string') {
    if (/(?:^|[\s"'])\/(?:Users|home|private|tmp|var|Volumes)\//.test(raw) || /(?:^|[\s"'])[A-Za-z]:\\/.test(raw) || (raw.startsWith('file:') && !(key === 'id' && /^file:[a-f0-9]{64}$/.test(raw)))) throw Error('Local path in public catalog');
    for (const match of raw.matchAll(/https?:\/\/[^\s"<>]+/g)) { const url = new URL(match[0]); if (url.username || url.password || [...url.searchParams.keys()].some(key => /token|secret|password|api[_-]?key|signature|credential/i.test(key))) throw Error('Credential in public catalog URL'); }
  } else if (Array.isArray(raw)) raw.forEach(value => publicSafe(value)); else if (raw && typeof raw === 'object') Object.entries(raw).forEach(([key, value]) => publicSafe(value, key));
}
export function validatePublicCatalog(raw: unknown) { publicSafe(raw); }
function period(raw: unknown) { const value = fields(raw, ['kind', 'label', 'start', 'end', 'basis'], false); ['kind', 'label', 'basis'].forEach(key => string(value[key])); ['start','end'].forEach(key => optionalString(value[key])); }
function collection(raw: unknown, internal: boolean) { const value = fields(raw, ['id','title','publisher','description','statuses','families','tables','routeCount','holdings','periods','detailPath'], internal); ['id','title','detailPath'].forEach(key => string(value[key])); ['publisher','description'].forEach(key => optionalString(value[key])); ['statuses','families','tables'].forEach(key => strings(value[key])); number(value.routeCount); const holdings = fields(value.holdings, ['aliases','objects','decodedBytes','missing'], false); ['aliases','objects','decodedBytes','missing'].forEach(key => number(holdings[key])); array(value.periods).forEach(period); catalogPartitionUrl('https://catalog.example/manifest.json', string(value.detailPath)); }
export function parseCatalogManifest(raw: unknown, internal = false): CatalogManifest {
  if (!internal) publicSafe(raw); const value = header(raw, 'spicy-source-catalog', ['generatedAt','collections','totals'], internal); if (!Number.isFinite(Date.parse(string(value.generatedAt)))) throw Error('Catalog date expected'); array(value.collections).forEach(row => collection(row, internal)); unique(array(value.collections), 'id'); Object.values(object(value.totals)).forEach(number); return value as unknown as CatalogManifest;
}
function validateCoverage(raw: unknown) {
  const value = fields(raw, ['completenessDenominator', 'stages'], false);
  if (value.completenessDenominator !== null) throw Error('Unsupported catalog completeness denominator');
  const stages = fields(value.stages, [...coverageStages], false);
  for (const name of coverageStages) {
    const stage = fields(stages[name], ['status', 'measurements'], false);
    if (!['unknown', 'evidence-recorded', 'scope-withheld'].includes(string(stage.status))) throw Error('Unsupported coverage status');
    const measurements = array(stage.measurements);
    if (stage.status !== 'evidence-recorded' && measurements.length) throw Error('Unqualified coverage measurements');
    for (const raw of measurements) {
      const measurement = fields(raw, ['count', 'unit', 'routeId', 'version', 'evidenceBasis', 'scope', 'period'], false);
      number(measurement.count); string(measurement.unit); string(measurement.evidenceBasis);
      optionalString(measurement.routeId); optionalString(measurement.version);
      const scope = fields(measurement.scope, ['collectionId', 'table', 'observationId', 'capturedAt', 'qualificationScope'], false);
      if (!Object.keys(scope).length) throw Error('Coverage measurement requires selected scope');
      Object.values(scope).forEach(string);
      if (measurement.period !== null) {
        const selected = fields(measurement.period, ['kind', 'label', 'start', 'end'], false);
        if (!Object.keys(selected).length) throw Error('Coverage period expected');
        Object.values(selected).forEach(string);
      }
    }
  }
}
export function parseCatalogDetail(raw: unknown, generation: string, collectionId: string, internal = false): CatalogDetail {
  if (!internal) publicSafe(raw); const value = header(raw, 'spicy-source-collection', ['collection','routes','tables','files','planned','observations','relationships','coverage'], internal, generation); collection(value.collection, internal); if (object(value.collection).id !== collectionId) throw Error('Catalog collection mismatch');
  array(value.routes).forEach(raw => { const row = fields(raw, ['id','label','deliveryMethod','lifecycle','custodian','contentBehavior','accessUrl','periods','status','note'], internal); ['id','label','deliveryMethod','lifecycle','custodian','contentBehavior'].forEach(key => string(row[key])); ['status','note'].forEach(key => optionalString(row[key])); array(row.periods).forEach(period); if (row.accessUrl !== undefined) { const url = new URL(string(row.accessUrl)); if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw Error('Unsafe source route URL'); } }); unique(array(value.routes), 'id'); if (array(value.routes).length !== object(value.collection).routeCount) throw Error('Catalog route count mismatch');
  array(value.tables).forEach(raw => { const row = fields(raw, ['id','family','status','artifactDigest','coverageNote'], internal); ['id','family','status'].forEach(key => string(row[key])); ['artifactDigest','coverageNote'].forEach(key => optionalString(row[key])); });
  const files = fields(value.files, ['pages','total'], false); number(files.total); array(files.pages).forEach(raw => { const row = fields(raw, ['path','rows'], false); catalogPartitionUrl('https://catalog.example/manifest.json', string(row.path)); number(row.rows); if ((row.rows as number) > 5000) throw Error('Catalog file page exceeds export bound'); }); unique(array(files.pages), 'path'); if (array(files.pages).reduce((sum: number, page) => sum + (object(page).rows as number), 0) !== files.total) throw Error('Catalog file partitions do not match total');
  const entryFields: Record<string, string[]> = { planned: ['id','table','family','status','reason','routeId','destinationIds'], observations: ['id','status','observedAt','scope','declaredCount','observedCount','note'], relationships: ['id','kind','fromId','toId','scope','note'] };
  Object.entries(entryFields).forEach(([key, allowed]) => {
    array(value[key]).forEach(raw => {
      const row = fields(raw, allowed, internal);
      const required = key === 'relationships' ? ['id','kind','fromId','toId'] : ['id','status'];
      required.forEach(field => string(row[field]));
      allowed.filter(field => !required.includes(field)).forEach(field => {
        if (field === 'declaredCount' || field === 'observedCount') { if (row[field] !== undefined) number(row[field]); }
        else if (field === 'destinationIds') { if (row[field] !== undefined) strings(row[field]); }
        else optionalString(row[field]);
      });
    });
    unique(array(value[key]), 'id');
  }); if (value.coverage !== undefined) validateCoverage(value.coverage); return value as unknown as CatalogDetail;
}
export function parseCatalogFilePage(raw: unknown, generation: string, collectionId: string, rows: number, internal = false): CatalogFilePage {
  if (!internal) publicSafe(raw); if (rows > 5000) throw Error('Catalog file page exceeds export bound'); const value = header(raw, 'spicy-source-files', ['collectionId','files'], internal, generation); if (value.collectionId !== collectionId) throw Error('Catalog file collection mismatch'); if (array(value.files).length !== rows) throw Error('Catalog file page count mismatch'); array(value.files).forEach(raw => { const row = fields(raw, ['id','name','status','sha256','bytes','routeId'], internal); ['id','name','status'].forEach(key => string(row[key])); ['sha256','routeId'].forEach(key => optionalString(row[key])); if (row.bytes !== undefined) number(row.bytes); if (internal) { optionalString(row.localPath); optionalString(row.verification); if (row.encodedBytes !== undefined) number(row.encodedBytes); } }); unique(array(value.files), 'id'); return value as unknown as CatalogFilePage;
}
export const catalogResponseByteLimit = 16 * 1024 * 1024;
export class SourceCatalogReader {
  constructor(readonly manifestUrl = '/source-catalog/manifest.json', readonly internal = false, readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init)) {}
  private async json(url: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetcher(url, { signal, cache: 'no-cache' });
    if (!response.ok) throw Error(`Source catalog request failed (${response.status})`);
    const stream = response.body?.getReader();
    if (!stream) throw Error('Source catalog response is empty');
    const declaredBytes = Number(response.headers.get('content-length'));
    if (declaredBytes > catalogResponseByteLimit) { await stream.cancel(); throw Error('Source catalog response exceeds 16 MiB limit'); }
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0, json = '';
    try {
      for (;;) {
        const chunk = await stream.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > catalogResponseByteLimit) { await stream.cancel(); throw Error('Source catalog response exceeds 16 MiB limit'); }
        json += decoder.decode(chunk.value, { stream: true });
      }
      json += decoder.decode();
      return JSON.parse(json) as unknown;
    } catch (error) { await stream.cancel().catch(() => {}); throw error; }
    finally { stream.releaseLock(); }
  }
  async manifest(signal?: AbortSignal) { return parseCatalogManifest(await this.json(this.manifestUrl, signal), this.internal); }
  async detail(manifest: CatalogManifest, item: CatalogCollection, signal?: AbortSignal) { return parseCatalogDetail(await this.json(catalogPartitionUrl(this.manifestUrl, item.detailPath), signal), manifest.generation, item.id, this.internal); }
  async files(manifest: CatalogManifest, detail: CatalogDetail, page: number, signal?: AbortSignal) { const part = detail.files.pages[page]; if (!part) throw Error('Catalog file page unavailable'); return parseCatalogFilePage(await this.json(catalogPartitionUrl(this.manifestUrl, part.path), signal), manifest.generation, detail.collection.id, part.rows, this.internal); }
}
