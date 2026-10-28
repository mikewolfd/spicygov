import { parquetMetadataAsync, parquetReadObjects, parquetSchema, type SchemaTree } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { exactParsers } from './exact-parquet';
import { parseCatalogFilePage, validatePublicCatalog, catalogArchiveKey, type CatalogFile, type CatalogFilePage, type CatalogFilePeriod } from './source-catalog';

export const catalogShardBytes = 4 * 1024 * 1024;
export const catalogShardRows = 5000;
export type CatalogParquetPart = { path: string; format: 'parquet'; schema: 'spicy-source-files/v1'; rows: number; bytes: number; sha256: string };
export type CatalogShardContext = { generation: string; collectionId: string; inventoryKind: 'active' | 'attention'; part: CatalogParquetPart };
type FieldType = 'text' | 'hash' | 'uint' | 'time' | 'texts' | 'periods';
const fields: [string, FieldType, boolean][] = [
  ['alias_id','text',true], ['dataset_id','text',true], ['publisher','text',false], ['inventory_kind','text',true],
  ['name','text',true], ['status','text',true], ['provenance_basis','text',true], ['availability','text',true],
  ['source_id','text',false], ['source_version','text',false], ['route_id','text',false], ['content_sha256','hash',false], ['original_bytes','uint',false],
  ['content_key','text',false], ['stored_bytes','uint',false], ['captured_at','time',false], ['source_url','text',false], ['source_urls','texts',false],
  ['period_kind','text',false], ['period_label','text',false], ['period_basis','text',false], ['period_start','text',false], ['period_end','text',false],
  ['periods','periods',false], ['conflict_fields','texts',false], ['receipt_key','text',false], ['receipt_sha256','hash',false],
  ['receipt_entry','uint',false], ['receipt_kind','text',false], ['original_receipt_key','text',false],
  ['original_receipt_sha256','hash',false], ['original_receipt_pointer','text',false],
];
const periodFields = ['kind','label','basis','start','end'];
const hex = (bytes: Uint8Array) => [...bytes].map(byte => byte.toString(16).padStart(2,'0')).join('');
function fail(message: string): never { throw Error(`Catalog Parquet ${message}`); }
function checkField(node: SchemaTree, type: FieldType, required: boolean): void {
  const value = node.element;
  if (value.repetition_type !== (required ? 'REQUIRED' : 'OPTIONAL')) fail('field nullability differs');
  if (type === 'texts' || type === 'periods') {
    if (value.type || value.logical_type?.type !== 'LIST' || value.converted_type !== 'LIST' || node.children.length !== 1) fail('list schema differs');
    const repeated = node.children[0];
    if (repeated.element.repetition_type !== 'REPEATED' || repeated.children.length !== 1) fail('list storage differs');
    const element = repeated.children[0];
    if (type === 'texts') checkField(element,'text',false);
    else {
      if (element.element.type || element.element.repetition_type !== 'OPTIONAL' || element.children.map(child => child.element.name).join() !== periodFields.join()) fail('period schema differs');
      element.children.forEach(child => checkField(child,'text',false));
    }
    return;
  }
  if (node.children.length) fail('unexpected nested field');
  if (type === 'text' && (value.type !== 'BYTE_ARRAY' || value.converted_type !== 'UTF8' || value.logical_type?.type !== 'STRING')) fail('text schema differs');
  if (type === 'hash' && (value.type !== 'FIXED_LEN_BYTE_ARRAY' || value.type_length !== 32 || value.logical_type || value.converted_type)) fail('fingerprint schema differs');
  if (type === 'uint' && (value.type !== 'INT64' || value.converted_type !== 'UINT_64' || value.logical_type?.type !== 'INTEGER' || value.logical_type.bitWidth !== 64 || value.logical_type.isSigned)) fail('unsigned integer schema differs');
  if (type === 'time' && (value.type !== 'INT64' || value.converted_type !== 'TIMESTAMP_MICROS' || value.logical_type?.type !== 'TIMESTAMP' || value.logical_type.unit !== 'MICROS' || !value.logical_type.isAdjustedToUTC)) fail('capture timestamp schema differs');
}
function string(value: unknown, required = false): string | undefined {
  if (value == null && !required) return;
  if (typeof value !== 'string' || required && !value.trim()) fail('text value is invalid');
  return value;
}
function integer(value: unknown): number | undefined {
  if (value == null) return;
  if (typeof value !== 'bigint' && typeof value !== 'number') fail('integer value is invalid');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) fail('integer is outside the supported exact range');
  return number;
}
function fingerprint(value: unknown): string | undefined {
  if (value == null) return;
  if (!(value instanceof Uint8Array) || value.length !== 32) fail('fingerprint value is invalid');
  return `sha256:${hex(value)}`;
}
function strings(value: unknown): string[] | undefined {
  if (value == null) return;
  if (!Array.isArray(value)) fail('list value is invalid');
  return value.map(item => string(item,true)!);
}
function receiptKey(value: unknown): string | undefined {
  const key = string(value);
  return key === undefined ? undefined : catalogArchiveKey(key);
}
function publicText(value: unknown, key = ''): void {
  if (typeof value === 'string') {
    const plain = value.replace(/https?:\/\/[^\s"']+/g,'');
    if (key !== 'original_receipt_pointer' && /(^|[\s"'=:(])\/(?!\/)[^\s]|(^|[\s"'])[A-Za-z]:[\\/]/.test(plain)) fail('private path in text');
    if (/file:\/\/|api_key=|apikey=|token=|bearer |x-amz-signature|password=|secret=/i.test(value)) fail('credential or private URL in text');
  } else if (Array.isArray(value)) value.forEach(item => publicText(item,key));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([name,item]) => publicText(item,name));
}

function validateRow(row: Record<string, unknown>, context: CatalogShardContext): CatalogFile {
  if (Object.keys(row).join() !== fields.map(([name]) => name).join()) fail('decoded fields differ');
  const clean: Record<string, unknown> = {};
  for (const [name,type,required] of fields) {
    const value = row[name];
    if (type === 'text' || type === 'time') clean[name] = string(value,required);
    else if (type === 'hash') clean[name] = fingerprint(value);
    else if (type === 'uint') clean[name] = integer(value);
    else if (type === 'texts') clean[name] = strings(value);
    else {
      if (value == null) clean[name] = undefined;
      else {
        if (!Array.isArray(value) || value.length < 2) fail('period list is invalid');
        clean[name] = value.map(item => {
          if (!item || typeof item !== 'object' || Object.keys(item).join() !== periodFields.join()) fail('period fields differ');
          return Object.fromEntries(periodFields.map(key => [key,string(item[key])]));
        });
      }
    }
  }
  validatePublicCatalog(clean);
  publicText(clean);
  if (clean.dataset_id !== context.collectionId || clean.inventory_kind !== context.inventoryKind) fail('row scope differs from selected inventory');
  const sourceUrl = clean.source_url as string | undefined, sourceUrls = clean.source_urls as string[] | undefined;
  if (sourceUrls && (sourceUrl !== undefined || sourceUrls.length < 2 || new Set(sourceUrls).size !== sourceUrls.length)) fail('source URL alternatives are invalid');
  const singlePeriod = ['period_kind','period_label','period_basis','period_start','period_end'].some(key => clean[key] !== undefined);
  if (clean.periods && singlePeriod) fail('period alternatives overlap');
  if ((clean.period_kind === undefined) !== (clean.period_label === undefined)) fail('single period is incomplete');
  const contentKey = receiptKey(row.content_key);
  if (contentKey && clean.content_sha256 === undefined) fail('content archive key lacks its fingerprint');
  const key = receiptKey(row.receipt_key), originalKey = receiptKey(row.original_receipt_key);
  const receiptSha = clean.receipt_sha256 as string | undefined, entry = clean.receipt_entry as number | undefined;
  if (entry !== undefined && (!entry || !receiptSha)) fail('receipt entry lacks an exact receipt');
  if (key !== undefined && receiptSha === undefined) fail('receipt key and fingerprint disagree');
  const kind = clean.receipt_kind as string | undefined;
  if (kind !== undefined && !['frozen-index','acquisition','retained-manifest'].includes(kind)) fail('receipt kind is invalid');
  if (key && (!kind || !entry)) fail('receipt kind lacks its archive reference');
  if (key) {
    const expectedKind = key.startsWith('acquisitions/sha256/') ? 'acquisition' : key.endsWith('.jsonl.gz') ? 'frozen-index' : 'retained-manifest';
    if (kind !== expectedKind) fail('receipt kind differs from archive key');
    const hash = receiptSha!.slice(7);
    if (kind === 'acquisition' && key !== `acquisitions/sha256/${hash.slice(0,2)}/${hash}`) fail('acquisition key differs from fingerprint');
  }
  const originalSha = clean.original_receipt_sha256 as string | undefined;
  if (originalKey !== undefined && originalSha === undefined) fail('original receipt reference is incomplete');
  for (const [objectKey,hash] of [[contentKey,clean.content_sha256],[originalKey,originalSha]]) {
    if (objectKey) {
      const digest = (hash as string).slice(7), base = `objects/sha256/${digest.slice(0,2)}/${digest}`;
      if (objectKey !== base && objectKey !== `${base}.gz`) fail('archive object key differs from fingerprint');
    }
  }
  const pointer = clean.original_receipt_pointer as string | undefined;
  if (pointer !== undefined && (!originalKey || !/^(?:\/(?:[^~]|~[01])*)*$/.test(pointer) || /\/(Users|home|private|tmp|Volumes)(\/|$)|credential|password|secret|token|api[_-]?key|:\/\/|\.\./i.test(pointer))) fail('original receipt pointer is invalid');
  const file: CatalogFile = {
    id: clean.alias_id as string, name: clean.name as string, status: clean.status as string,
    ...(clean.source_id !== undefined ? {sourceId:clean.source_id as string} : {}),
    ...(clean.source_version !== undefined ? {sourceVersion:clean.source_version as string} : {}),
    ...(clean.periods ? {periods:clean.periods as CatalogFilePeriod[]} : singlePeriod ? {periods:[Object.fromEntries(periodFields.filter(key => clean['period_' + key] !== undefined).map(key => [key,clean['period_' + key]]))]} : {}),
    ...(clean.conflict_fields !== undefined ? {metadataConflicts:clean.conflict_fields as string[]} : {}),
    ...(clean.route_id !== undefined ? {routeId:clean.route_id as string} : {}),
    ...(clean.content_sha256 !== undefined ? {sha256:clean.content_sha256 as string} : {}),
    ...(clean.original_bytes !== undefined ? {bytes:clean.original_bytes as number} : {}),
    ...(contentKey ? {contentKey} : {}),
    ...(clean.stored_bytes !== undefined ? {storedBytes:clean.stored_bytes as number} : {}),
    provenance: {
      basis: clean.provenance_basis as NonNullable<CatalogFile['provenance']>['basis'],
      availability: clean.availability as NonNullable<CatalogFile['provenance']>['availability'],
      sourceUrls: sourceUrl === undefined ? sourceUrls ?? [] : [sourceUrl],
      ...(clean.captured_at !== undefined ? {capturedAt:clean.captured_at as string} : {}),
      ...(receiptSha ? {receipt:{key:key ?? null,sha256:receiptSha,...(kind ? {kind} : {}),...(entry !== undefined ? {entry} : {})}} : {}),
      ...(originalSha ? {originalReceiptKey:originalKey ?? null,originalReceiptSha256:originalSha,...(pointer !== undefined ? {originalReceiptPointer:pointer} : {})} : {}),
    },
  };
  return file;
}

/** One byte/schema/value boundary for browser reads and offline public staging. */
export async function decodeCatalogFileShard(buffer: ArrayBuffer, context: CatalogShardContext): Promise<CatalogFilePage> {
  const {part,generation,collectionId,inventoryKind} = context;
  if (part.format !== 'parquet' || part.schema !== 'spicy-source-files/v1' || !Number.isSafeInteger(part.rows) || part.rows < 1 || part.rows > catalogShardRows || !Number.isSafeInteger(part.bytes) || part.bytes < 12 || part.bytes > catalogShardBytes || buffer.byteLength !== part.bytes) fail('shard bounds differ');
  const sha = `sha256:${hex(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer)))}`;
  if (sha !== part.sha256) fail('shard fingerprint differs');
  const metadata = await parquetMetadataAsync(buffer,{parsers:exactParsers});
  if (metadata.num_rows !== BigInt(part.rows)) fail('footer row count differs');
  const expected = {'spicy_catalog.format':'spicy-source-files-parquet','spicy_catalog.schema_version':'1','spicy_catalog.generation':generation,'spicy_catalog.dataset_id':collectionId,'spicy_catalog.inventory_kind':inventoryKind};
  const entries = metadata.key_value_metadata ?? [];
  if (entries.length !== Object.keys(expected).length || new Set(entries.map(item => item.key)).size !== entries.length || entries.some(item => expected[item.key as keyof typeof expected] !== item.value)) fail('footer scope metadata differs');
  validatePublicCatalog({createdBy:metadata.created_by});
  publicText(metadata.created_by);
  const schema = parquetSchema(metadata);
  if (schema.element.name !== 'schema') fail('root schema name differs');
  if (schema.children.map(node => node.element.name).join() !== fields.map(([name]) => name).join()) fail('physical fields differ');
  schema.children.forEach((node,index) => checkField(node,fields[index][1],fields[index][2]));
  let decodedBytes = 0n;
  for (const group of metadata.row_groups) {
    decodedBytes += group.total_byte_size;
    if (group.total_byte_size < 0n || decodedBytes > 64n * 1024n * 1024n || group.columns.some(column => column.file_path)) fail('row group exceeds public bounds');
  }
  const rows = await parquetReadObjects({file:buffer,metadata,compressors,parsers:exactParsers,columns:fields.map(([name]) => name),rowStart:0,rowEnd:part.rows});
  if (rows.length !== part.rows) fail('decoded row count differs');
  const files = rows.map(row => validateRow(row,context));
  return parseCatalogFilePage({format:'spicy-source-files',version:3,generation,collectionId,files},generation,collectionId,part.rows);
}
