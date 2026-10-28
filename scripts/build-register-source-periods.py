"""Summarize dated observations in the cataloged Federal Register source files.

Usage: python scripts/build-register-source-periods.py INDEX.sqlite public/source-catalog
The result is a rebuildable, catalog-generation-bound list of observed months.
It is not a completeness claim: the source index may not describe every record.
"""
import datetime
import json
from pathlib import Path
import sqlite3
import sys

index, catalog = Path(sys.argv[1]), Path(sys.argv[2])
manifest = json.loads((catalog / 'manifest.json').read_text())
generation = manifest['generation']
collection = next(value for value in manifest['collections'] if value['id'] == 'family:federal-register')
detail = json.loads((catalog / collection['detailPath']).read_text())
hashes = {item['sha256'] for page in detail['files']['pages']
          for item in json.loads((catalog / page['path']).read_text())['files']
          if item.get('status') == 'held' and item.get('sha256')}
if not hashes:
    raise ValueError('No held Federal Register objects')
conn = sqlite3.connect(index.resolve().as_uri() + '?mode=ro', uri=True)
conn.execute('CREATE TEMP TABLE selected (sha256 TEXT PRIMARY KEY)')
conn.executemany('INSERT INTO selected VALUES (?)', ((value,) for value in hashes))
rows = conn.execute("""SELECT p.label, f.local_path FROM selected s
    CROSS JOIN files f ON f.sha256=s.sha256
    CROSS JOIN raw_objects o ON o.sha256=f.sha256
    CROSS JOIN raw_periods p ON p.file_id=f.id
    WHERE f.collection_id='family:federal-register' AND f.status='held' AND o.present=1
      AND p.kind='publication-date' AND p.basis LIKE 'Original /%'""")
months, dates = set(), []
for label, path in rows:
    try:
        date = datetime.date.fromisoformat(label)
    except (TypeError, ValueError):
        continue
    if date.year >= 1994 and path and Path(path).is_file():
        months.add(date.strftime('%Y-%m'))
        dates.append(date.isoformat())
if not dates:
    raise ValueError('No dated source observations')
result = {'generation': generation, 'months': sorted(months), 'latestIndexedDate': max(dates)}
output = Path(__file__).resolve().parents[1] / 'content/federal-register-source-periods.json'
output.write_text(json.dumps(result, indent=2) + '\n')
print(f"{len(months)} observed months; latest indexed source date {result['latestIndexedDate']}")
