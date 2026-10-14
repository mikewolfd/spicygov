import type { RouteCapability, TableMetadataState } from './metadata';

type Endpoint = { metadataState: TableMetadataState };
type CountStatus = { state: 'measured' | 'unknown' | 'unavailable' | 'external'; label: string; detail: string };
type Options = { direction: 'forward' | 'reverse'; capability?: RouteCapability; source?: Endpoint; target?: Endpoint; external?: boolean; available?: boolean };
const number = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const format = (value: number) => value.toLocaleString('en-US');
const blocked = (endpoint?: Endpoint) => !endpoint || ['loading', 'missing', 'incompatible', 'unavailable'].includes(endpoint.metadataState);

/** Display only the selected direction's qualified counts; legacy join kinds are historical notes. */
export function connectionCountStatus({ direction, capability, source, target, external = false, available }: Options): CountStatus {
  if (blocked(source) || !external && blocked(target) || capability?.available === false || available === false) {
    return {state: 'unavailable', label: 'Unavailable', detail: 'This connection is unavailable for the selected publication.'};
  }
  if (external) return {state: 'external', label: 'External reference', detail: 'Matching counts do not apply to an external URL.'};
  if ([source, target].some(endpoint => endpoint?.metadataState === 'older-publication')) {
    return {state: 'unknown', label: 'Counts need updating', detail: 'The connection describes an earlier publication; current matching counts are unavailable.'};
  }
  const unknown: CountStatus = {state: 'unknown', label: 'Not checked', detail: 'Matching counts are not available for this publication.'};
  const measured = capability?.measurement;
  if (capability?.available !== true || !measured || measured.status !== 'measured') return unknown;
  if (direction === 'reverse') {
    const {matchedTargetRows: matched, unmatchedTargetRows: unmatched} = measured;
    if (measured.scope !== 'all_selected_targets_against_eligible_source_references' || !number(matched) || !number(unmatched) || !number(matched + unmatched)) return unknown;
    const total = matched + unmatched;
    return {state: 'measured', label: 'Checked', detail: total
      ? `${format(matched)} of ${format(total)} target records are referenced${unmatched ? ` · ${format(unmatched)} not referenced` : ''}.`
      : 'No target records in this publication.'};
  }
  const {eligible, matched, missing, ambiguous, unsupported} = measured;
  // Ambiguous references are a subset of matched references, not a third denominator category.
  if (measured.scope !== 'full_selected_inputs' || !number(eligible) || !number(matched) || !number(missing)
      || !number(ambiguous) || !number(unsupported) || matched + missing !== eligible || ambiguous > matched) return unknown;
  const issues = [missing && `${format(missing)} missing`, ambiguous && `${format(ambiguous)} ambiguous`, unsupported && `${format(unsupported)} unsupported`].filter(Boolean);
  const detail = eligible ? `${format(matched)} of ${format(eligible)} eligible references have a target` : 'No eligible references in this publication';
  return {state: 'measured', label: missing || ambiguous ? 'Needs review' : 'Checked', detail: `${detail}${issues.length ? ` · ${issues.join(' · ')}` : ''}.`};
}
