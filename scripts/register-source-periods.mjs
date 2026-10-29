/** Collect only source-content dates from validated catalog file pages. */
export function registerSourcePeriods() {
  const months = new Set();
  const objects = new Set(), dated = new Set();
  let latestIndexedDate;
  return {
    addPage(collection, inventory, files) {
      if (collection !== 'family:federal-register' || inventory !== 'active') return;
      for (const file of files) {
        if (file.status !== 'held' || !file.sha256 || file.provenance?.availability !== 'local') continue;
        objects.add(file.sha256);
        for (const period of file.periods ?? []) {
          const date = period.label;
          if (period.kind !== 'publication-date' || period.basis !== 'Observed in source content'
              || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
          const parsed = new Date(`${date}T00:00:00Z`);
          if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date || date < '1994-01-01') continue;
          months.add(date.slice(0, 7));
          dated.add(file.sha256);
          if (!latestIndexedDate || date > latestIndexedDate) latestIndexedDate = date;
        }
      }
    },
    result(generation) {
      return { format: 'spicygov-register-source-periods', version: 1, generation,
        dateCoverage: {files: objects.size, datedFiles: dated.size, undatedFiles: objects.size - dated.size},
        months: [...months].sort(), ...(latestIndexedDate ? {latestIndexedDate} : {}) };
    },
  };
}
