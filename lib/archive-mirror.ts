import type { CatalogManifest } from './source-catalog';
import { digest, object, size } from './publication-evidence';

export const archiveMirrorBase = 'https://data.spicygov.ai/spicyregs/raw/';
export type ArchiveMirror = {
  format: 'spicygov-archive-mirror'; version: 1; preparedAt: string; archiveBase: string;
  catalog: { generation: string; manifestSha256: string };
  inventory: { generation: string; recordedAt: string; evidenceSha256: string;
    rawSnapshotSha256: string; acquisitionReceiptSetSha256: string; objects: number; receipts: number;
    controls: {key: string; bytes: number}[] };
  publicChecks: { checkedAt: string; scope: 'sample'; files: {key: string; bytes: number; status: 200}[] };
};
function fields(value: unknown, names: string[]): Record<string, any> {
  if (!object(value) || Object.keys(value).some(key => !names.includes(key))) throw Error('Invalid archive mirror fields');
  return value;
}
function date(value: unknown) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw Error('Invalid archive mirror date');
}
function fingerprint(value: unknown) {
  if (!digest(value) || !value.startsWith('sha256:')) throw Error('Invalid archive mirror fingerprint');
}
export function archiveKeyListed(mirror: ArchiveMirror | undefined, key: string | null | undefined): boolean {
  if (!mirror || !key) return false;
  const hash = key.match(/^(objects|acquisitions)\/sha256\/([a-f0-9]{2})\/([a-f0-9]{64})(\.gz)?$/);
  if (hash) return hash[2] === hash[3].slice(0,2) && (hash[1] === 'objects' || !hash[4]);
  return mirror.inventory.controls.some(control => control.key === key);
}
/** This receipt qualifies inventory membership, not a whole-archive byte audit. */
export function parseArchiveMirror(raw: unknown, manifest: CatalogManifest, manifestSha256: string): ArchiveMirror {
  const value = fields(raw,['format','version','preparedAt','archiveBase','catalog','inventory','publicChecks']);
  if (value.format !== 'spicygov-archive-mirror' || value.version !== 1 || value.archiveBase !== archiveMirrorBase)
    throw Error('Unsupported archive mirror evidence');
  date(value.preparedAt);
  const catalog = fields(value.catalog,['generation','manifestSha256']);
  fingerprint(catalog.generation);fingerprint(catalog.manifestSha256);
  if (catalog.generation !== manifest.generation || catalog.manifestSha256 !== manifestSha256)
    throw Error('Archive mirror belongs to another catalog');
  const inventory = fields(value.inventory,['generation','recordedAt','evidenceSha256','rawSnapshotSha256','acquisitionReceiptSetSha256','objects','receipts','controls']);
  for (const key of ['generation','evidenceSha256','rawSnapshotSha256','acquisitionReceiptSetSha256']) fingerprint(inventory[key]);
  date(inventory.recordedAt);
  if (!size(inventory.objects) || !inventory.objects || !size(inventory.receipts) || !Array.isArray(inventory.controls) || inventory.controls.length > 32)
    throw Error('Invalid archive mirror inventory');
  for (const item of inventory.controls) {
    const control = fields(item,['key','bytes']);
    if (typeof control.key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(control.key)
        || !size(control.bytes)) throw Error('Invalid archive mirror control');
  }
  if (new Set(inventory.controls.map(control => control.key)).size !== inventory.controls.length) throw Error('Repeated archive mirror control');
  const checks = fields(value.publicChecks,['checkedAt','scope','files']);date(checks.checkedAt);
  if (checks.scope !== 'sample' || !Array.isArray(checks.files) || checks.files.length < 1 || checks.files.length > 3)
    throw Error('Invalid public mirror sample');
  for (const item of checks.files) {
    const sample = fields(item,['key','bytes','status']);
    if (!archiveKeyListed(value as ArchiveMirror,sample.key) || !size(sample.bytes) || sample.status !== 200) throw Error('Invalid public mirror check');
  }
  if (new Set(checks.files.map(file => file.key)).size !== checks.files.length) throw Error('Repeated public mirror check');
  return value as ArchiveMirror;
}
export function mirrorInventoryDate(mirror: ArchiveMirror): string {
  return new Date(mirror.inventory.recordedAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'});
}
