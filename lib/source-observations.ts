import { validDate } from './metadata';
import { DATA_BASE, object } from './publication-evidence';
export type SourceObservation = { source: string; endpoint: string; selection: string; purpose?: string; examples?: number; lastObservedAt?: string; observedAt?: string; status?: number; saved?: boolean };
export type ObservationPreview = { observations: SourceObservation[]; inherited: boolean; partial: boolean };
export function parseObservationPreview(text: string, partial = false): ObservationPreview {
  const observations: SourceObservation[] = [];
  let inherited = false;
  for (const line of text.split('\n')) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (!object(row)) continue;
    if (row.event === 'lineage') inherited = true;
    if (row.event !== 'capture') continue;
    try {
      const url = new URL(row.resolved_url ?? row.requested_url);
      if (!['https:', 'http:'].includes(url.protocol)) continue;
      observations.push({ source: url.hostname, endpoint: url.pathname, selection: url.searchParams.toString(), purpose: typeof row.purpose === 'string' ? row.purpose : undefined, observedAt: validDate(row.observed_at),
        status: Number.isInteger(row.status_code) ? row.status_code : undefined, saved: typeof row.body_retained === 'boolean' ? row.body_retained : undefined });
    } catch { /* Malformed source URLs are not displayed. */ }
    if (observations.length === 5) { partial = true; break; }
  }
  // The bounded preview can contain repeated reads of the same endpoint.
  // Combine them without inventing a request purpose or source selection.
  const groups = new Map<string, SourceObservation>();
  for (const observation of observations) {
    const key = JSON.stringify([observation.source, observation.endpoint, observation.selection, observation.purpose, observation.status, observation.saved, !!observation.observedAt]);
    const previous = groups.get(key);
    if (!previous) groups.set(key, {...observation, examples: 1});
    else {
      previous.examples = (previous.examples ?? 1) + 1;
      if (observation.observedAt) {
        const dates = [previous.observedAt, previous.lastObservedAt, observation.observedAt].filter((date): date is string => !!date).sort((a, b) => Date.parse(a) - Date.parse(b));
        previous.observedAt = dates[0]; previous.lastObservedAt = dates[dates.length - 1];
      }
    }
  }
  return { observations: [...groups.values()], inherited, partial };
}
export async function loadObservationPreview(url: string): Promise<ObservationPreview> {
  if (!new RegExp(`^${DATA_BASE.replaceAll('.', '\\.')}\\/source-evidence\\/[a-f0-9]{64}\\/journal\\.jsonl$`).test(url)) throw new Error('Invalid source log location.');
  const response = await fetch(url, { headers: { Range: 'bytes=0-65535' }, signal: AbortSignal.timeout(10000) });
  if (!response.ok || !response.body) throw new Error('Source observations unavailable.');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let text = '', bytes = 0, partial = response.status === 206;
  try {
    while (bytes < 65536) {
      const part = await reader.read();
      if (part.done) break;
      const take = part.value.subarray(0, 65536 - bytes);
      text += decoder.decode(take, { stream: true }); bytes += take.length;
    }
    if (bytes >= 65536) partial = true;
  } finally { await reader.cancel(); }
  return parseObservationPreview(text, partial);
}
