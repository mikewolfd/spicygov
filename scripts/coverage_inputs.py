"""Resolve coverage parents through retained generation receipts, never 'latest'."""
import time
from collection_coverage import BASE, Inputs, identity
from publication_census import digest
from coverage_dimensions import quote, scan_dimension


def selected_members(members, table_id):
    selected = [m for m in members if m.get('role') == 'table' and
                (m['objectKey'] == table_id + '.parquet' or m['objectKey'].startswith(table_id + '/'))]
    if not selected: raise ValueError('Retained parent table is absent: ' + table_id)
    return [{'key': m['objectKey'], 'sha256': m['sha256'], 'rows': m['recordCount'],
             'byteSize': m['byteSize']} for m in selected]


class CoverageInputs(Inputs):
    def __init__(self):
        super().__init__()
        self.lookup_remaining = max(0, self.deadline - time.monotonic())

    def fetch(self, key):
        # Column scans between lookups do not consume the input-fetch allowance.
        started = time.monotonic()
        self.deadline = started + self.lookup_remaining
        try:
            data = super().fetch(key)
        finally:
            self.lookup_remaining -= time.monotonic() - started
        if self.lookup_remaining < 0:
            raise ValueError('Input lookup exceeded the scan budget')
        return data

    def table(self, family, generation, table_id, expected=None):
        key, artifact, members = self.artifact(family, generation)
        files = selected_members(members, table_id)
        if expected is not None and identity(files) != identity(expected):
            raise ValueError('Coverage table bytes differ from its publication: ' + table_id)
        return {'family': family, 'artifactDigest': generation, 'tableId': table_id,
                'artifact': artifact, 'members': files, 'rows': sum(m['rows'] for m in files),
                'recordUrl': BASE + '/' + key + '/artifact.json',
                'urls': [BASE + '/' + key + '/' + m['key'] for m in files]}

    def producing(self, table_id, table):
        generation, seen = table['artifactDigest'], set()
        for _ in range(32):
            if generation in seen: raise ValueError('Repeated coverage input generation')
            seen.add(generation)
            retained = self.table(table['family'], generation, table_id, table['members'])
            carried = retained['artifact']['spec'].get('carriedForward', {}).get(table_id + '.parquet')
            if not carried: return retained
            generation = carried
        raise ValueError('Coverage input history exceeded the lookup limit')

    def parent(self, child_id, child, relation):
        owner = self.producing(child_id, child)
        parent_id = relation['table']
        if relation['mode'] == 'same-generation':
            # Same-family output tables are pinned by the child's own publication.
            result = self.table(owner['family'], owner['artifactDigest'], parent_id)
        elif relation['mode'] == 'recorded-parent':
            spec = owner['artifact']['spec']
            pin = spec.get('parents', {}).get(parent_id + '.parquet')
            if not isinstance(pin, dict) or not digest(pin.get('sha256')):
                raise ValueError('Producing release does not pin this coverage parent')
            result = self.table(pin['family'], pin['artifactDigest'], parent_id)
            if (len(result['members']) != 1 or result['members'][0]['sha256'] != pin['sha256']
                    or result['members'][0]['byteSize'] != pin['byteSize']):
                raise ValueError('Coverage parent member differs from its input receipt')
            snapshot = spec.get('readSnapshot', {}).get('families', {}).get(pin['family'])
            if snapshot:
                descriptor = snapshot.get('tables', {}).get(parent_id + '.parquet', {})
                if (snapshot.get('artifactDigest') != pin['artifactDigest']
                        or descriptor.get('sha256') != pin['sha256']
                        or descriptor.get('byteSize') != pin['byteSize']
                        or descriptor.get('rows') != result['rows']):
                    raise ValueError('Coverage parent differs from the saved read snapshot')
        else:
            raise ValueError('Unsupported coverage parent lookup')
        return result


def inherit_unique(conn, child_urls, child_rows, parent, relation, dimension):
    """One matching parent may supply a dimension; unmatched rows remain unplaced."""
    conn.read_parquet(child_urls, hive_partitioning=False).create_view('coverage_child', replace=True)
    conn.read_parquet(parent['urls'], hive_partitioning=False).create_view('coverage_parent', replace=True)
    keys = relation.get('keys')
    if (not isinstance(keys, list) or not keys or any(not isinstance(pair, list) or len(pair) != 2 for pair in keys)):
        raise ValueError('Incomplete coverage join keys')
    child_names = {r[0] for r in conn.execute('DESCRIBE coverage_child').fetchall()}
    parent_names = {r[0] for r in conn.execute('DESCRIBE coverage_parent').fetchall()}
    actual_parent_rows = conn.execute('SELECT count(*) FROM coverage_parent').fetchone()[0]
    if actual_parent_rows != parent['rows']: raise ValueError('Coverage parent row count differs from its receipt')
    if any(c not in child_names or p not in parent_names for c, p in keys):
        raise ValueError('Coverage join keys are not in the retained schema')
    parent_keys = ','.join(quote(p) for _, p in keys)
    nonnull = ' AND '.join(quote(p) + ' IS NOT NULL' for _, p in keys)
    duplicates = conn.execute(f'SELECT count(*) FROM (SELECT {parent_keys} FROM coverage_parent WHERE {nonnull} GROUP BY ALL HAVING count(*) > 1)').fetchone()[0]
    if duplicates: raise ValueError('Coverage parent keys are not unique')
    fields = list(dimension['fields'])
    fields += [dimension[k] for k in ('precisionField', 'approximateField') if dimension.get(k)]
    fields += [c['field'] for c in dimension.get('conditions', [])]
    fields = list(dict.fromkeys(fields))
    if any(f not in parent_names for f in fields): raise ValueError('Coverage dimension is absent from the retained parent')
    aliases = {f: 'coverage_inherited_' + f for f in fields}
    if any(f in child_names for f in aliases.values()): raise ValueError('Coverage field alias conflicts with child schema')
    projected = ','.join(f'p.{quote(f)} AS {quote(a)}' for f, a in aliases.items())
    on = ' AND '.join(f'c.{quote(c)} = p.{quote(p)}' for c, p in keys)
    conn.execute(f'CREATE OR REPLACE TEMP VIEW coverage_join AS SELECT c.*, {projected}, p.{quote(keys[0][1])} IS NOT NULL AS coverage_parent_matched FROM coverage_child c LEFT JOIN coverage_parent p ON {on}')
    total, matched = conn.execute('SELECT count(*), count(*) FILTER (WHERE coverage_parent_matched) FROM coverage_join').fetchone()
    if total != child_rows: raise ValueError('Inherited coverage changed the child row count')
    copied = {**dimension, 'fields': [aliases[f] for f in dimension['fields']]}
    for key in ('precisionField', 'approximateField'):
        if dimension.get(key): copied[key] = aliases[dimension[key]]
    copied['conditions'] = [{**c, 'field': aliases[c['field']]} for c in dimension.get('conditions', [])]
    measured = scan_dimension(conn, [], child_rows, copied, source_view='coverage_join')
    measured['fields'] = dimension['fields']
    measured['parent'] = {k: parent[k] for k in ('family', 'artifactDigest', 'tableId', 'recordUrl', 'members', 'rows')}
    measured['matchedRows'], measured['unmatchedRows'] = matched, total - matched
    return measured
