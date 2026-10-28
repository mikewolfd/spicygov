import type { CatalogParquetPart, CatalogShardContext } from './catalog-parquet';
/** Shared, generation-bound metadata reader. File partitions load only on request. */
export type CatalogPeriod = { kind: string; label: string; start?: string; end?: string; basis: string };
export type CatalogFilePeriod = Partial<CatalogPeriod>;
export type CatalogVersion = 1 | 2 | 3;
export type CatalogPeriodSummary = { count: number; observedRetained?: CatalogPeriod };
export type CatalogCollection = { id: string; title: string; publisher?: string; description?: string; statuses: string[]; families: string[]; tables: string[]; routeCount: number; holdings: { aliases: number; objects: number; decodedBytes: number; missing: number }; periods?: CatalogPeriod[]; periodSummary?: CatalogPeriodSummary; detailPath: string; localPath?: string; encodedBytes?: number; verification?: string; internalOnly?: unknown };
export type CatalogManifest = { format: 'spicy-source-catalog'; version: CatalogVersion; generation: string; generatedAt: string; collections: CatalogCollection[]; totals: Record<string, number>; localPath?: string; encodedBytes?: number; verification?: string; internalOnly?: unknown };
export type CatalogRoute = { id: string; label: string; deliveryMethod: string; lifecycle: string; custodian: string; contentBehavior: string; accessUrl?: string; periods: CatalogPeriod[]; status?: string; note?: string; localPath?: string; encodedBytes?: number; verification?: string; internalOnly?: unknown };
export type CatalogFileProvenance = { basis: 'receipt-backed' | 'provisional' | 'inferred' | 'unknown'; sourceUrls: string[]; capturedAt?: string; receipt?: { sha256: string; entry?: number; key?: string | null; kind?: string }; originalReceiptSha256?: string; originalReceiptKey?: string | null; originalReceiptPointer?: string; availability: 'local' | 'missing' | 'external' | 'not-acquired' | 'unknown' };
export type CatalogFile = { id: string; name: string; status: string; provenance?: CatalogFileProvenance; sha256?: string; bytes?: number; contentKey?: string; storedBytes?: number; routeId?: string; sourceId?: string; sourceVersion?: string; periods?: CatalogFilePeriod[]; metadataConflicts?: string[]; localPath?: string; encodedBytes?: number; verification?: string; internalOnly?: unknown };
export const coverageStages = ['expected', 'advertised', 'acquired', 'processed', 'published'] as const;
export type CoverageStage = typeof coverageStages[number];
export type CoverageMeasurement = { count: number; unit: string; routeId?: string; version?: string; evidenceBasis: string; scope: { collectionId?: string; table?: string; observationId?: string; capturedAt?: string; qualificationScope?: string }; period: { kind?: string; label?: string; start?: string; end?: string } | null };
export type CatalogCoverage = { completenessDenominator: null; stages: Record<CoverageStage, { status: 'unknown' | 'evidence-recorded' | 'scope-withheld'; measurements: CoverageMeasurement[] }> };
export type PublicationMember = { key: string; sha256: string; bytes: number; rows: number; partition: Record<string, string> };
export type PublicationTable = { table: string; bytes: number; rows: number; sha256?: string; members?: PublicationMember[]; partitionColumns?: string[] };
export type PublicationObservation = { id: string; family: string; captureAt: string; familyPublishedAt: string; serverDate: string; responseSha256: string; artifactDigest: string; artifactPrefix: string; associationStatus: 'exact-family' | 'unqualified'; tables: PublicationTable[] };
export type PublicationReconciliation = { scope: 'current' | 'historical'; version: string; status: 'verified' | 'missing_local_files' | 'missing_provenance' | 'conflicting_evidence'; sourceFiles: number; matchedSourceFiles: number; missingSourceFiles: number; capturedSourceFiles: number; inputClosureComplete: boolean; reasons: string[]; evidenceLinks: { label: string; url: string }[] };
export type CatalogTable = { id: string; family: string; status: string; artifactDigest?: string; coverageNote?: string; publication?: PublicationReconciliation };
export type CatalogFilePart = { path: string; rows: number } | CatalogParquetPart;
export type CatalogDetail = { format: 'spicy-source-collection'; version: CatalogVersion; generation: string; collection: CatalogCollection & { periods: CatalogPeriod[] }; routes: CatalogRoute[]; tables: CatalogTable[]; files: { pages: CatalogFilePart[]; total: number }; retainedFiles?: { pages: CatalogFilePart[]; total: number }; planned: Record<string, unknown>[]; observations: Record<string, unknown>[]; relationships: Record<string, unknown>[]; coverage?: CatalogCoverage; publicationObservations?: PublicationObservation[]; localPath?: string; encodedBytes?: number; verification?: string; internalOnly?: unknown };
export type CatalogFilePage = { format: 'spicy-source-files'; version: CatalogVersion; generation: string; collectionId: string; files: CatalogFile[]; localPath?: string; encodedBytes?: number; verification?: string; internalOnly?: unknown };
const internalFields = ['audience', 'localPath', 'encodedBytes', 'verification', 'internalOnly'];
function object(raw: unknown): Record<string, unknown> { if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Catalog object expected'); return raw as Record<string, unknown>; }
function fields(raw: unknown, allowed: string[], internal: boolean) { const value = object(raw); for (const key of Object.keys(value)) if (!allowed.includes(key) && !(internal && internalFields.includes(key))) throw Error(`Unsupported catalog field: ${key}`); return value; }
function string(raw: unknown) { if (typeof raw !== 'string' || !raw.trim()) throw Error('Catalog text expected'); return raw; }
function optionalString(raw: unknown) { if (raw !== undefined) string(raw); }
function number(raw: unknown) { if (!Number.isSafeInteger(raw) || (raw as number) < 0) throw Error('Nonnegative catalog count expected'); }
function array(raw: unknown): unknown[] { if (!Array.isArray(raw)) throw Error('Catalog array expected'); return raw; }
function strings(raw: unknown) { array(raw).forEach(string); }
function unique(raw: unknown[], key: string) { const ids = raw.map(row => string(object(row)[key])); if (new Set(ids).size !== ids.length) throw Error(`Duplicate catalog ${key}`); }
function header(raw: unknown, format: string, allowed: string[], internal: boolean, generation?: string, version?: CatalogVersion) { const value = fields(raw, ['format', 'version', 'generation', ...allowed], internal); if (value.format !== format || ![1, 2, 3].includes(value.version as number)) throw Error('Unsupported source catalog version'); if (!/^sha256:[a-f0-9]{64}$/.test(string(value.generation))) throw Error('Invalid catalog generation'); if (internal && value.audience !== 'internal') throw Error('Internal catalog audience required'); if (generation && value.generation !== generation) throw Error('Catalog generation changed; reload the catalog'); if (version && value.version !== version) throw Error('Catalog partition version differs from manifest'); return value; }
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
    if (/(?:^|[\s"'])\/(?:Users|home|private|tmp|var|Volumes)\//.test(raw) || /(?:^|[\s"'])[A-Za-z]:\\/.test(raw) || (raw.startsWith('file:') && !(['id','alias_id'].includes(key) && /^file:[a-f0-9]{64}$/.test(raw)))) throw Error('Local path in public catalog');
    for (const match of raw.matchAll(/https?:\/\/[^\s"<>]+/g)) { const url = new URL(match[0]); if (url.username || url.password || [...url.searchParams.keys()].some(key => /token|secret|password|api[_-]?key|signature|credential/i.test(key))) throw Error('Credential in public catalog URL'); }
  } else if (Array.isArray(raw)) raw.forEach(value => publicSafe(value)); else if (raw && typeof raw === 'object') Object.entries(raw).forEach(([key, value]) => publicSafe(value, key));
}
export function validatePublicCatalog(raw: unknown) { publicSafe(raw); }
function period(raw: unknown) { const value = fields(raw, ['kind', 'label', 'start', 'end', 'basis'], false); ['kind', 'label', 'basis'].forEach(key => string(value[key])); ['start','end'].forEach(key => optionalString(value[key])); }
function periodSummary(raw: unknown, periods?: unknown[]) {
  const value = fields(raw, ['count','observedRetained'], false); number(value.count);
  if (value.observedRetained !== undefined) {
    period(value.observedRetained); const observed = object(value.observedRetained);
    if (!value.count || observed.kind !== 'observed-retained-scope' || typeof observed.start !== 'string') throw Error('Invalid observed retained period summary');
  }
  if (periods) {
    if (value.count !== periods.length) throw Error('Catalog period summary count mismatch');
    const identity = (raw: unknown) => { const value = object(raw); return JSON.stringify(['kind','label','start','end','basis'].map(key => value[key])); };
    const observed = [...new Map(periods.filter(raw => object(raw).kind === 'observed-retained-scope' && object(raw).start).map(raw => [identity(raw), raw])).values()];
    const expected = observed.length === 1 ? identity(observed[0]) : undefined;
    const actual = value.observedRetained === undefined ? undefined : identity(value.observedRetained);
    if (actual !== expected) throw Error('Catalog observed period summary mismatch');
  }
}
function collection(raw: unknown, internal: boolean, version: CatalogVersion, detail = false) {
  const periodFields = version === 1 ? ['periods'] : ['periodSummary', ...(detail ? ['periods'] : [])];
  const value = fields(raw, ['id','title','publisher','description','statuses','families','tables','routeCount','holdings',...periodFields,'detailPath'], internal);
  ['id','title','detailPath'].forEach(key => string(value[key])); ['publisher','description'].forEach(key => optionalString(value[key])); ['statuses','families','tables'].forEach(key => strings(value[key])); number(value.routeCount);
  const holdings = fields(value.holdings, ['aliases','objects','decodedBytes','missing'], false); ['aliases','objects','decodedBytes','missing'].forEach(key => number(holdings[key]));
  const periods = version === 1 || detail ? array(value.periods) : undefined; periods?.forEach(period);
  if (version >= 2) periodSummary(value.periodSummary, periods);
  catalogPartitionUrl('https://catalog.example/manifest.json', string(value.detailPath));
}
export function parseCatalogManifest(raw: unknown, internal = false): CatalogManifest {
  if (!internal) publicSafe(raw); const value = header(raw, 'spicy-source-catalog', ['generatedAt','collections','totals'], internal); if (!Number.isFinite(Date.parse(string(value.generatedAt)))) throw Error('Catalog date expected'); array(value.collections).forEach(row => collection(row, internal, value.version as CatalogVersion)); unique(array(value.collections), 'id'); Object.values(object(value.totals)).forEach(number); return value as unknown as CatalogManifest;
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
function validatePublicationObservations(raw: unknown) {
  const digest = (value: unknown) => { if (!/^sha256:[a-f0-9]{64}$/.test(string(value))) throw Error('Invalid publication digest'); };
  const timestamp = (value: unknown) => { if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(string(value)) || !Number.isFinite(Date.parse(value as string))) throw Error('Invalid publication timestamp'); };
  const path = (value: unknown) => catalogPartitionUrl('https://catalog.example/manifest.json', string(value));
  const observations = array(raw);
  observations.forEach(raw => {
    const row = fields(raw, ['id','family','captureAt','familyPublishedAt','serverDate','responseSha256','artifactDigest','artifactPrefix','associationStatus','tables'], false);
    ['id','family'].forEach(key => string(row[key]));
    ['captureAt','familyPublishedAt','serverDate'].forEach(key => timestamp(row[key]));
    ['responseSha256','artifactDigest'].forEach(key => digest(row[key])); path(row.artifactPrefix);
    if (!['exact-family','unqualified'].includes(string(row.associationStatus))) throw Error('Invalid publication association');
    const tables = array(row.tables);
    if (!tables.length) throw Error('Publication tables expected');
    tables.forEach(raw => {
      const table = fields(raw, ['table','bytes','rows','sha256','members','partitionColumns'], false);
      path(table.table); number(table.bytes); number(table.rows);
      if ((table.sha256 === undefined) === (table.members === undefined)) throw Error('Publication member identity expected');
      if (table.sha256 !== undefined) { digest(table.sha256); if (table.partitionColumns !== undefined) throw Error('Unexpected publication partition columns'); }
      if (table.members !== undefined) {
        strings(table.partitionColumns); const columns = table.partitionColumns as string[]; if (!columns.length || new Set(columns).size !== columns.length) throw Error('Invalid publication partition columns');
        const members = array(table.members); if (!members.length) throw Error('Publication partition members expected');
        members.forEach(raw => { const member = fields(raw, ['key','sha256','bytes','rows','partition'], false); path(member.key); digest(member.sha256); number(member.bytes); number(member.rows); const partition = object(member.partition); if (Object.keys(partition).length !== columns.length || columns.some(column => !(column in partition))) throw Error('Publication partition keys mismatch'); Object.values(partition).forEach(value => { if (typeof value !== 'string') throw Error('Publication partition text expected'); }); });
        unique(members, 'key');
        for (const key of ['bytes','rows']) if (members.reduce((sum: number, member) => sum + (object(member)[key] as number), 0) !== table[key]) throw Error('Publication partition totals mismatch');
      }
    }); unique(tables, 'table');
  }); unique(observations, 'id');
}
function validateReconciliation(raw: unknown, artifactDigest: unknown) {
  const value = fields(raw, ['scope','version','status','sourceFiles','matchedSourceFiles','missingSourceFiles','capturedSourceFiles','inputClosureComplete','reasons','evidenceLinks'], false);
  if (!['current','historical'].includes(string(value.scope))) throw Error('Invalid reconciliation scope');
  if (!/^sha256:[a-f0-9]{64}$/.test(string(value.version)) || value.version !== artifactDigest) throw Error('Reconciliation version differs from the table publication');
  if (!['verified','missing_local_files','missing_provenance','conflicting_evidence'].includes(string(value.status))) throw Error('Invalid reconciliation status');
  ['sourceFiles','matchedSourceFiles','missingSourceFiles','capturedSourceFiles'].forEach(key => number(value[key]));
  if ((value.matchedSourceFiles as number) + (value.missingSourceFiles as number) !== value.sourceFiles) throw Error('Reconciliation file counts disagree');
  if (typeof value.inputClosureComplete !== 'boolean' || (value.capturedSourceFiles as number) > (value.sourceFiles as number)) throw Error('Invalid reconciliation input completeness');
  if (value.status === 'verified' && (!value.sourceFiles || value.missingSourceFiles || !value.inputClosureComplete)) throw Error('Verified reconciliation requires matching local originals');
  strings(value.reasons);
  array(value.evidenceLinks).forEach(raw => {
    const link = fields(raw, ['label','url'], false); string(link.label);
    const url = new URL(string(link.url));
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('Unsafe reconciliation evidence URL');
  });
}
function validateFilePartitions(raw: unknown, version: CatalogVersion) {
  const files = fields(raw, ['pages','total'], false); number(files.total);
  array(files.pages).forEach(raw => {
    const row = fields(raw, ['path','rows', ...(version === 3 ? ['format','schema','bytes','sha256'] : [])], false);
    if (version === 3 && (row.format !== 'parquet' || row.schema !== 'spicy-source-files/v1' || !Number.isSafeInteger(row.bytes) || (row.bytes as number) < 12 || (row.bytes as number) > 4 * 1024 * 1024 || !/^sha256:[a-f0-9]{64}$/.test(string(row.sha256)) || !string(row.path).endsWith('.parquet'))) throw Error('Invalid catalog Parquet partition');
    catalogPartitionUrl('https://catalog.example/manifest.json', string(row.path)); number(row.rows);
    if ((row.rows as number) > 5000) throw Error('Catalog file page exceeds export bound');
  });
  unique(array(files.pages), 'path');
  if (array(files.pages).reduce((sum: number, page) => sum + (object(page).rows as number), 0) !== files.total) throw Error('Catalog file partitions do not match total');
}
export function parseCatalogDetail(raw: unknown, generation: string, collectionId: string, internal = false, version?: CatalogVersion): CatalogDetail {
  if (!internal) publicSafe(raw); const value = header(raw, 'spicy-source-collection', ['collection','routes','tables','files','planned','observations','relationships','coverage','publicationObservations','retainedFiles'], internal, generation, version); collection(value.collection, internal, value.version as CatalogVersion, true); if (object(value.collection).id !== collectionId) throw Error('Catalog collection mismatch');
  array(value.routes).forEach(raw => { const row = fields(raw, ['id','label','deliveryMethod','lifecycle','custodian','contentBehavior','accessUrl','periods','status','note'], internal); ['id','label','deliveryMethod','lifecycle','custodian','contentBehavior'].forEach(key => string(row[key])); ['status','note'].forEach(key => optionalString(row[key])); array(row.periods).forEach(period); if (row.accessUrl !== undefined) { const url = new URL(string(row.accessUrl)); if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw Error('Unsafe source route URL'); } }); unique(array(value.routes), 'id'); if (array(value.routes).length !== object(value.collection).routeCount) throw Error('Catalog route count mismatch');
  array(value.tables).forEach(raw => { const row = fields(raw, ['id','family','status','artifactDigest','coverageNote','publication'], internal); ['id','family','status'].forEach(key => string(row[key])); ['artifactDigest','coverageNote'].forEach(key => optionalString(row[key])); if (row.publication !== undefined) validateReconciliation(row.publication, row.artifactDigest); });
  validateFilePartitions(value.files,value.version as CatalogVersion);
  if (value.retainedFiles !== undefined) validateFilePartitions(value.retainedFiles,value.version as CatalogVersion);
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
  }); if (value.coverage !== undefined) validateCoverage(value.coverage); if (value.publicationObservations !== undefined) validatePublicationObservations(value.publicationObservations); return value as unknown as CatalogDetail;
}
function validateFileProvenance(raw: unknown) {
  const value = fields(raw, ['basis','sourceUrls','capturedAt','receipt','originalReceiptSha256','originalReceiptKey','originalReceiptPointer','availability'], false);
  if (!['receipt-backed','provisional','inferred','unknown'].includes(string(value.basis))) throw Error('Invalid file provenance basis');
  if (!['local','missing','external','not-acquired','unknown'].includes(string(value.availability))) throw Error('Invalid file availability');
  const urls = array(value.sourceUrls); urls.forEach(raw => {
    const url = new URL(string(raw));
    const publicListing = url.host === 'com-courtlistener-storage.s3-us-west-2.amazonaws.com'
      && url.pathname === '/list.html' && url.search === '?prefix=bulk-data/';
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || (url.search && !publicListing) || url.hash) throw Error('Unsafe file source URL');
  });
  if (new Set(urls).size !== urls.length) throw Error('Duplicate file source URL');
  const digest = (raw: unknown) => { if (!/^sha256:[a-f0-9]{64}$/.test(string(raw))) throw Error('Invalid file receipt digest'); };
  if (value.receipt !== undefined) {
    const receipt = fields(value.receipt, ['sha256','entry','key','kind'], false); digest(receipt.sha256);
    if (receipt.entry !== undefined) { number(receipt.entry); if (!receipt.entry) throw Error('Invalid file receipt entry'); }
    if (receipt.key != null) catalogArchiveKey(receipt.key);
    if (receipt.kind !== undefined && !['frozen-index','acquisition','retained-manifest'].includes(string(receipt.kind))) throw Error('Invalid file receipt kind');
  }
  if (value.originalReceiptSha256 !== undefined) digest(value.originalReceiptSha256);
  if (value.originalReceiptKey != null) catalogArchiveKey(value.originalReceiptKey);
  if (value.originalReceiptPointer !== undefined && (typeof value.originalReceiptPointer !== 'string' || !/^(?:\/(?:[^~]|~[01])*)*$/.test(value.originalReceiptPointer))) throw Error('Invalid original receipt pointer');
  if (value.capturedAt !== undefined) {
    if (value.basis !== 'receipt-backed' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(string(value.capturedAt)) || !Number.isFinite(Date.parse(value.capturedAt as string))) throw Error('Invalid file capture timestamp');
  }
}
export function parseCatalogFilePage(raw: unknown, generation: string, collectionId: string, rows: number, internal = false, version?: CatalogVersion): CatalogFilePage {
  if (!internal) publicSafe(raw);
  if (rows > 5000) throw Error('Catalog file page exceeds export bound');
  const value = header(raw, 'spicy-source-files', ['collectionId','files'], internal, generation, version);
  if (value.collectionId !== collectionId) throw Error('Catalog file collection mismatch');
  if (array(value.files).length !== rows) throw Error('Catalog file page count mismatch');
  const nativeFields = value.version === 3 ? ['sourceId','sourceVersion','periods','metadataConflicts'] : [];
  array(value.files).forEach(raw => {
    const row = fields(raw, ['id','name','status','sha256','bytes','contentKey','storedBytes','routeId','provenance',...nativeFields], internal);
    ['id','name','status'].forEach(key => string(row[key]));
    ['sha256','routeId'].forEach(key => optionalString(row[key]));
    const nativeText = (value: unknown) => { if (value !== undefined && typeof value !== 'string') throw Error('Catalog native text expected'); };
    ['sourceId','sourceVersion'].forEach(key => nativeText(row[key]));
    if (row.bytes !== undefined) number(row.bytes);
    if (row.storedBytes !== undefined) number(row.storedBytes);
    if (row.contentKey !== undefined) catalogArchiveKey(row.contentKey);
    if (row.provenance !== undefined) validateFileProvenance(row.provenance);
    if (row.metadataConflicts !== undefined) strings(row.metadataConflicts);
    if (row.periods !== undefined) array(row.periods).forEach(raw => {
      const period = fields(raw, ['kind','label','start','end','basis'], false);
      Object.values(period).forEach(nativeText);
    });
    if (internal) { optionalString(row.localPath); optionalString(row.verification); if (row.encodedBytes !== undefined) number(row.encodedBytes); }
  });
  unique(array(value.files), 'id');
  return value as unknown as CatalogFilePage;
}
export function catalogArchiveKey(raw: unknown): string {
  const key = string(raw);
  catalogPartitionUrl('https://archive.example/manifest.json',key);
  return key;
}
export async function parseCatalogParquet(buffer: ArrayBuffer, context: CatalogShardContext): Promise<CatalogFilePage> {
  return (await import('./catalog-parquet')).decodeCatalogFileShard(buffer,context);
}
export const catalogResponseByteLimit = 16 * 1024 * 1024;
export const catalogReadTimeoutMs = 30_000;
export class SourceCatalogReader {
  constructor(readonly manifestUrl = '/source-catalog/manifest.json', readonly internal = false, readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init), readonly timeoutMs = catalogReadTimeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw Error('Positive catalog read timeout required');
  }
  private async bounded<T>(read: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason ?? new DOMException('Catalog read aborted','AbortError'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort',abort,{once:true});
    const timer = setTimeout(() => controller.abort(Error('Source catalog request timed out. Try again.')),this.timeoutMs);
    let rejectRead: () => void = () => {};
    const cancelled = new Promise<never>((_,reject) => {
      rejectRead = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort',rejectRead,{once:true});
    });
    try {
      controller.signal.throwIfAborted();
      return await Promise.race([read(controller.signal),cancelled]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort',abort);
      controller.signal.removeEventListener('abort',rejectRead);
    }
  }
  private async bytes(url: string, limit = catalogResponseByteLimit, signal?: AbortSignal): Promise<ArrayBuffer> {
    return this.bounded(signal => this.readBytes(url,limit,signal),signal);
  }
  private async readBytes(url: string, limit: number, signal: AbortSignal): Promise<ArrayBuffer> {
    const response = await this.fetcher(url, { signal, cache: 'no-cache' });
    if (!response.ok) throw Error(`Source catalog request failed (${response.status})`);
    const stream = response.body?.getReader();
    if (!stream) throw Error('Source catalog response is empty');
    const cancel = () => { void stream.cancel().catch(() => {}); };
    if (signal.aborted) { cancel(); signal.throwIfAborted(); }
    signal.addEventListener('abort',cancel,{once:true});
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      if (Number(response.headers.get('content-length')) > limit) throw Error(limit === catalogResponseByteLimit ? 'Source catalog response exceeds 16 MiB limit' : 'Source catalog response exceeds partition byte limit');
      for (;;) {
        const chunk = await stream.read();
        signal.throwIfAborted();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > limit) throw Error(limit === catalogResponseByteLimit ? 'Source catalog response exceeds 16 MiB limit' : 'Source catalog response exceeds partition byte limit');
        chunks.push(chunk.value);
      }
      const result = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { result.set(chunk,offset); offset += chunk.byteLength; }
      return result.buffer;
    } catch (error) { cancel(); throw error; }
    finally { signal.removeEventListener('abort',cancel); stream.releaseLock(); }
  }
  private async json(url: string, signal?: AbortSignal): Promise<unknown> {
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await this.bytes(url,catalogResponseByteLimit,signal)));
  }
  async manifest(signal?: AbortSignal) { return parseCatalogManifest(await this.json(this.manifestUrl, signal), this.internal); }
  async detail(manifest: CatalogManifest, item: CatalogCollection, signal?: AbortSignal) { return parseCatalogDetail(await this.json(catalogPartitionUrl(this.manifestUrl, item.detailPath), signal), manifest.generation, item.id, this.internal, manifest.version); }
  private async filePage(manifest: CatalogManifest, collectionId: string, part: CatalogFilePart | undefined, inventoryKind: 'active' | 'attention', signal?: AbortSignal) {
    if (!part) throw Error('Catalog file page unavailable');
    const url = catalogPartitionUrl(this.manifestUrl,part.path);
    if (manifest.version !== 3) return parseCatalogFilePage(await this.json(url,signal),manifest.generation,collectionId,part.rows,this.internal,manifest.version);
    if (!('format' in part)) throw Error('Catalog Parquet descriptor required');
    const buffer = await this.bytes(url,part.bytes,signal);
    if (signal?.aborted) throw new DOMException('Catalog read aborted','AbortError');
    const context: CatalogShardContext = {generation:manifest.generation,collectionId,inventoryKind,part};
    if (typeof window === 'undefined') return (await import('./catalog-parquet')).decodeCatalogFileShard(buffer,context);
    return this.bounded(signal => new Promise<CatalogFilePage>((resolve,reject) => {
      const worker = new Worker(new URL('./parquet.worker.ts',import.meta.url),{type:'module'});
      const finish = () => { signal?.removeEventListener('abort',abort); worker.terminate(); };
      const abort = () => { finish(); reject(new DOMException('Catalog read aborted','AbortError')); };
      signal?.addEventListener('abort',abort,{once:true});
      worker.onerror = () => { finish(); reject(Error('Catalog file reader failed')); };
      worker.onmessage = event => {
        if (event.data.type === 'catalog-files') { finish(); resolve(event.data.page); }
        else if (event.data.type === 'error') { finish(); reject(Error(event.data.message)); }
      };
      worker.postMessage({type:'catalog-files',buffer,context},[buffer]);
    }),signal);
  }
  async files(manifest: CatalogManifest, detail: CatalogDetail, page: number, signal?: AbortSignal) { return this.filePage(manifest,detail.collection.id,detail.files.pages[page],'active',signal); }
  async retainedFiles(manifest: CatalogManifest, detail: CatalogDetail, page: number, signal?: AbortSignal) { return this.filePage(manifest,detail.collection.id,detail.retainedFiles?.pages[page],'attention',signal); }
}
