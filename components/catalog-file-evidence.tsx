import type { CatalogFile } from "../lib/source-catalog";

const basisLabels = {
  'receipt-backed': 'Receipt documents this retained file.',
  provisional: 'Provisional attribution; the original capture is unconfirmed.',
  inferred: 'Location inferred from retained metadata; the capture is unconfirmed.',
  unknown: 'Origin and capture evidence are unknown.',
};
const availabilityLabels = {
  local: 'Retained locally; presence checked by the catalog.',
  missing: 'Referenced bytes are unavailable locally.',
  external: 'Held externally by choice; local bytes are unavailable.',
  'not-acquired': 'Known source; acquisition is not recorded.',
  unknown: 'Local or external availability is unknown.',
};

function archiveUrl(key: string | null | undefined, archiveBase = 'https://data.spicygov.ai/spicyregs/raw/') {
    if (!key || key.startsWith('/') || key.includes('\\') || /[%?#:]/.test(key) || key.split('/').some(part => !part || part === '.' || part === '..')) return;
    try {
      const base = new URL(archiveBase), url = new URL(key,base);
      if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !base.pathname.endsWith('/') || url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return;
      return url.href;
    } catch { return; }
  }

export function catalogFileDownload(file: CatalogFile, archiveBase?: string) {
  return file.provenance?.availability === 'local' ? archiveUrl(file.contentKey, archiveBase) : undefined;
}

/** Uses safe, per-alias metadata; archive-relative receipt lookup requires direct receipt evidence. */
export function CatalogFileEvidence({ file, archiveBase = 'https://data.spicygov.ai/spicyregs/raw/' }: { file: CatalogFile; archiveBase?: string }) {
  const provenance = file.provenance;
  const urls = provenance?.sourceUrls ?? [];
  const receipt = provenance?.receipt;
  const legacyDigest = provenance?.basis === 'receipt-backed' && receipt?.key === undefined ? receipt?.sha256.slice('sha256:'.length) : undefined;
  const receiptKey = receipt?.key ?? (legacyDigest ? `acquisitions/sha256/${legacyDigest.slice(0,2)}/${legacyDigest}` : undefined);
  const receiptUrl = archiveUrl(receiptKey, archiveBase), originalReceiptUrl = archiveUrl(provenance?.originalReceiptKey, archiveBase);
  const contentUrl = catalogFileDownload(file, archiveBase);
  return <details className="catalog-file-evidence">
    <summary>Technical evidence</summary>
    <p>{basisLabels[provenance?.basis ?? 'unknown']}</p>
    <p><strong>Source location:</strong> {urls.length ? urls.map((url, index) => <span key={url}>{index > 0 && ' · '}<a href={url} target="_blank" rel="noreferrer">{url} ↗</a></span>) : 'Unknown or withheld from public metadata.'}</p>
    {contentUrl && file.contentKey?.endsWith('.gz') && <p>This download is losslessly compressed for storage. Decompress it once to check the original file’s fingerprint and size.</p>}
    {receiptUrl && <p><a href={receiptUrl} target="_blank" rel="noreferrer">Open indexed receipt ↗</a></p>}
    {originalReceiptUrl && <p><a href={originalReceiptUrl} target="_blank" rel="noreferrer">Open original acquisition receipt ↗</a></p>}
    <p><strong>Capture date:</strong> {provenance?.capturedAt ?? 'Unknown; no confirmed per-file capture time.'}</p>
    <p><strong>Availability:</strong> {availabilityLabels[provenance?.availability ?? 'unknown']}</p>
    <p><strong>File fingerprint (SHA-256):</strong> {file.sha256 ? <code>{file.sha256}</code> : 'Unknown.'}</p>
    <p className="detail-caption">A checksum is a fingerprint used to check that a file has not changed.</p>
    <p><strong>Original byte size:</strong> {file.bytes === undefined ? 'Unknown.' : file.bytes.toLocaleString()}</p>
    <p><strong>Indexed evidence SHA-256:</strong> {provenance?.receipt ? <code>{provenance.receipt.sha256}</code> : 'Unknown.'}</p>
    <p><strong>Evidence entry:</strong> {provenance?.receipt?.entry ?? 'Unknown.'} {provenance?.receipt?.entry !== undefined && '(counting from 1)'}</p>
    <p><strong>Original acquisition receipt SHA-256:</strong> {provenance?.originalReceiptSha256 ? <code>{provenance.originalReceiptSha256}</code> : 'Unknown.'}</p>
    {provenance?.basis === 'provisional' && <p>Legacy receipts may have been associated by identical bytes. A matching checksum does not establish the same acquisition or capture date.</p>}
    {(receiptKey || provenance?.originalReceiptSha256) && <details>
      <summary>Find the original receipt (local archive)</summary>
      <p>These references identify exact files in the raw archive. Public links open the same archived bytes; a local archive copy can be inspected using the keys below.</p>
      {receiptKey && <><p>Indexed receipt archive key: <code>{receiptKey}</code></p>
        {receipt?.entry !== undefined && <p>{receipt.kind === 'frozen-index'
          ? `In the decoded JSON-lines index, inspect line ${receipt.entry} (counting from 1).`
          : receipt.kind === 'acquisition' || receiptKey.startsWith('acquisitions/sha256/')
            ? `Within the receipt’s files list, inspect files[${receipt.entry - 1}] (entry ${receipt.entry}, counting from 1).`
            : `Inspect recorded entry ${receipt.entry} (counting from 1); the retained manifest defines its record layout.`}</p>}</>}
      {provenance?.originalReceiptKey && <p>Original receipt archive key: <code>{provenance.originalReceiptKey}</code></p>}
      {provenance?.originalReceiptPointer && <p>Original receipt location: <code>{provenance.originalReceiptPointer}</code></p>}
      {provenance?.originalReceiptSha256 && <><p>To restore the original acquisition receipt, run this command from the raw archive folder. It writes the inspection copy outside that folder:</p>
        {provenance.basis === 'provisional' && <p>Only the original receipt is restored. Its attribution to this capture remains unconfirmed.</p>}
        <pre><code>{`python3 verify.py restore --sha256 ${provenance.originalReceiptSha256} --destination ../receipt-review.json`}</code></pre>
        <p>This restores the original bytes, including compressed storage, checks the fingerprint, and refuses to overwrite an existing destination.</p></>}
    </details>}
    <p><strong>Recorded state:</strong> {file.status}</p>
    {!!file.metadataConflicts?.length && <p><strong>Metadata notes:</strong> {file.metadataConflicts.join(" · ")}</p>}
    <p><strong>File reference:</strong> <code>{file.id}</code></p>
    {!!file.periods?.length && <details><summary>Recorded date metadata</summary><pre>{JSON.stringify(file.periods, null, 2)}</pre></details>}
    {file.sourceId && <p><strong>Source identifier:</strong> <code>{file.sourceId}</code></p>}
    {file.sourceVersion && <p><strong>Source version:</strong> <code>{file.sourceVersion}</code></p>}
    <p className="detail-caption">Retention does not establish source accuracy or complete coverage.</p>
  </details>;
}
