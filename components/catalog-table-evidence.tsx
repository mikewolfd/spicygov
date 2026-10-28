import type { Dataset } from "../lib/catalog";
import type { CatalogTable } from "../lib/source-catalog";
import { coverageSummary } from "../lib/catalog-coverage-copy";

const reconciliationReasons: Record<string, string> = {
  'incomplete-build-input-provenance': 'The build does not document every required original input.',
  'provisional-receipt-cannot-prove-build-consumption': 'A provisional receipt records file recovery, but does not prove the build used it.',
  'capture-observation-does-not-prove-build-consumption': 'An acquisition record shows the file was captured, but does not prove the build used it.',
  'parent-output-receipt-unavailable': 'A parent table’s build receipt is unavailable.',
  'parent-output-identity-disagrees': 'A parent table’s build receipt identifies a different publication.',
  'original-build-inputs-unidentified': 'The original files required by this build have not been identified.',
  'raw-object-byte-count-disagrees': 'A local original’s byte size disagrees with its retained evidence.',
  'conflicting-raw-file-evidence': 'Local records disagree about an original file.',
  'published-output-receipt-unavailable': 'The published table’s build receipt is unavailable.',
  'published-output-identity-disagrees': 'The build receipt identifies a different publication.',
  'exact-original-files-unavailable-locally': 'Some exact referenced originals have no accepted match in the checked catalog.',
};

export function CatalogTableEvidence({ destination, current }: {
  destination: CatalogTable;
  current?: Dataset;
}) {
  const currentVersion = current?.artifactDigest ?? (current?.publication?.kind === 'rulemaking'
    ? current.publication.manifestSha256 : current?.publicationIdentity);
  const rawVersion = destination.artifactDigest;
  const rawStale = !!(currentVersion && rawVersion && currentVersion !== rawVersion);
  const publication = destination.publication;
  const historicalStale = !!(currentVersion && publication && currentVersion !== publication.version);
  const historicalCurrent = publication?.scope === "current" && !!currentVersion && !historicalStale;
  const historicalStatus = !publication
    ? "Unknown; historical build records have not been checked."
    : publication.status === "missing_provenance"
      ? "Incomplete historical build records."
      : publication.status === "missing_local_files"
        ? "Historical file references need review."
        : publication.status === "conflicting_evidence"
          ? "Historical build records conflict."
          : historicalCurrent
            ? "Build records complete for the checked publication."
            : "Build records complete for an earlier or unconfirmed publication.";
  const sourceSummary = destination.coverageNote ? coverageSummary(destination.coverageNote) : undefined;
  return <div className="catalog-table-evidence">
    <p><strong>Source coverage:</strong> {sourceSummary || "Unknown; saved source coverage has not been reviewed for this dataset."}</p>
    {sourceSummary !== destination.coverageNote && <details><summary>Full source coverage review</summary><p>{destination.coverageNote}</p></details>}
    {destination.coverageNote && rawStale && <p className="detail-caption">This raw-file coverage review describes an earlier publication. It has not been checked against the current release.</p>}
    {destination.coverageNote && (!rawVersion || !currentVersion) && <p className="detail-caption">This raw-file coverage review could not be compared with the current publication.</p>}
    <p><strong>Past processing:</strong> {historicalStatus}</p>
    {historicalStale && <p className="detail-caption">These historical build records describe an earlier publication.</p>}
    {publication && !currentVersion && <p className="detail-caption">Current publication identity could not be compared.</p>}
    {publication && <details>
      <summary>How the published dataset was made</summary>
      <p>These checks describe past processing. They do not measure how much of the original source is covered. A checksum is a file fingerprint used to check that a file has not changed.</p>
      <p>{publication.matchedSourceFiles.toLocaleString()} of {publication.sourceFiles.toLocaleString()} exact historical file references match local hashes and byte sizes.</p>
      <p>{publication.missingSourceFiles.toLocaleString()} exact historical file references have no accepted match in the checked catalog. These are catalog-unmatched references, not a count of missing raw files.</p>
      <p>{publication.capturedSourceFiles.toLocaleString()} captured originals referenced. {publication.inputClosureComplete ? "All required build inputs are documented." : "Required build inputs are not fully documented; these counts cover only referenced originals."}</p>
      {publication.reasons.map((reason, index) => <p key={index}>{reconciliationReasons[reason] ?? "Additional source evidence needs review."}</p>)}
      <p>Checked historical publication: <code>{publication.version}</code></p>
      {currentVersion && <p>Current publication: <code>{currentVersion}</code></p>}
      {publication.evidenceLinks.map((link, index) => <p key={index}><a href={link.url} target="_blank" rel="noreferrer">{link.label} ↗</a></p>)}
    </details>}
    {destination.coverageNote && rawVersion && <details>
      <summary>Raw-file coverage review version</summary>
      <p>Reviewed publication: <code>{rawVersion}</code></p>
      {currentVersion && <p>Current publication: <code>{currentVersion}</code></p>}
    </details>}
  </div>;
}
