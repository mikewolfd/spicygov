export type RegisterSourcePeriods = { generation: string; months: string[]; latestIndexedDate?: string;
  dateCoverage?: {files: number; datedFiles: number; undatedFiles: number} };

/** Accept only source dates produced for the selected catalog generation. */
export function parseRegisterSourcePeriods(raw: unknown, generation: string): RegisterSourcePeriods | undefined {
  if (!raw || typeof raw !== 'object') return;
  const value = raw as Record<string, unknown>;
  if (value.format !== 'spicygov-register-source-periods' || value.version !== 1
      || value.generation !== generation || !/^sha256:[a-f0-9]{64}$/.test(generation)
      || !Array.isArray(value.months) || !value.months.every(month => typeof month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && month >= '1994-01')
      || new Set(value.months).size !== value.months.length) return;
  const latest = value.latestIndexedDate;
  if (latest !== undefined) {
    if (typeof latest !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(latest)) return;
    const date = new Date(`${latest}T00:00:00Z`);
    if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== latest
        || !value.months.includes(latest.slice(0, 7)) || latest.slice(0, 7) !== [...value.months].sort().at(-1)) return;
  }
  if ((value.months.length > 0) !== (latest !== undefined)) return;
  const counts = value.dateCoverage as RegisterSourcePeriods['dateCoverage'];
  if (counts !== undefined && (!counts || ![counts.files, counts.datedFiles, counts.undatedFiles].every(n => Number.isSafeInteger(n) && n >= 0)
      || counts.datedFiles + counts.undatedFiles !== counts.files || (counts.datedFiles > 0) !== (value.months.length > 0))) return;
  return { generation, months: value.months as string[], ...(typeof latest === 'string' ? {latestIndexedDate: latest} : {}),
    ...(counts ? {dateCoverage: counts} : {}) };
}
