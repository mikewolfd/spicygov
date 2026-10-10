"""Bounded single-gzip-member USTAR validation; no extraction or filesystem writes."""
import hashlib
import json
from pathlib import Path
import tarfile
import zlib
import re

COMPRESSED_CAP = 201326592
DECODED_CAP = 163584000

class DecodedReader:
    def __init__(self, stream, compressed_cap, decoded_cap):
        self.stream = stream
        self.compressed_cap = compressed_cap
        self.decoded_cap = decoded_cap
        self.compressed = self.decoded = 0
        self.pending = self.buffer = b''
        self.decoder = zlib.decompressobj(31)
        self.finished = False

    def fill(self):
        if self.finished:
            return False
        if self.decoder.eof:
            if self.decoder.unused_data or self.pending or self.stream.read(1):
                raise ValueError('Trailing or concatenated gzip data')
            self.finished = True
            return False
        raw = self.pending
        if not raw:
            raw = self.stream.read(min(65536, max(1, self.compressed_cap - self.compressed + 1)))
            self.compressed += len(raw)
            if self.compressed > self.compressed_cap:
                raise ValueError('Compressed cap exceeded')
            if not raw:
                raise ValueError('Truncated gzip stream')
        chunk = self.decoder.decompress(raw, min(65536, max(1, self.decoded_cap - self.decoded + 1)))
        self.pending = self.decoder.unconsumed_tail
        self.decoded += len(chunk)
        if self.decoded > self.decoded_cap:
            raise ValueError('Decoded cap exceeded')
        self.buffer += chunk
        return True

    def read(self, size):
        if size < 0 or size > 1048576:
            raise ValueError('Read exceeds bounded buffer')
        chunks = []
        remaining = size
        while remaining:
            if not self.buffer and not self.fill():
                break
            take = min(remaining, len(self.buffer))
            chunks.append(self.buffer[:take])
            self.buffer = self.buffer[take:]
            remaining -= take
        return b''.join(chunks)

    def exact(self, size):
        raw = self.read(size)
        if len(raw) != size:
            raise ValueError('Truncated decoded tar')
        return raw


def canonical_header(path, size):
    parts = path.split('/')
    if not path or path.startswith('/') or '\\' in path or any(p in ('', '.', '..') for p in parts):
        raise ValueError('Unsafe member path')
    info = tarfile.TarInfo(path)
    info.size = size
    info.mode = 0o644
    info.uid = info.gid = info.mtime = 0
    return info.tobuf(tarfile.USTAR_FORMAT, encoding='utf-8', errors='strict')


def validate(path, members, *, compressed_cap=COMPRESSED_CAP, decoded_cap=DECODED_CAP, _write=None, _check=None):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > compressed_cap:
        raise ValueError('Archive missing, symlink or oversized')
    if len({m['path'] for m in members}) != len(members):
        raise ValueError('Duplicate selection member')
    expected = sum(512 + ((m['bytes'] + 511)//512)*512 for m in members) + 1024
    expected = ((expected + 10239)//10240)*10240
    if expected > decoded_cap:
        raise ValueError('Selected decoded tar exceeds cap')
    with path.open('rb') as stream:
        # Canonical GzipFile mtime0, no optional fields/filename, level6, OS255.
        if stream.read(10) != b'\x1f\x8b\x08\x00\x00\x00\x00\x00\x00\xff':
            raise ValueError('Noncanonical gzip header')
        stream.seek(0)
        reader = DecodedReader(stream, compressed_cap, decoded_cap)
        consumed = 0
        for member in sorted(members, key=lambda m:m['path']):
            if _check:
                _check()
            size = member['bytes']
            if not isinstance(size, int) or size < 0 or size > 4194304:
                raise ValueError('Member size exceeds bound')
            if reader.exact(512) != canonical_header(member['path'], size):
                raise ValueError('Member path/type/header differs from exact allowlist')
            target = _write(member['path']) if _write else None
            digest = hashlib.sha256()
            remaining = size
            while remaining:
                if _check:
                    _check()
                chunk = reader.exact(min(65536, remaining))
                digest.update(chunk)
                if target is not None:
                    target.write(chunk)
                remaining -= len(chunk)
            if target is not None:
                target.close()
            if 'sha256:'+digest.hexdigest() != member['sha256']:
                raise ValueError('Member content hash differs')
            pad = (-size) % 512
            if reader.exact(pad) != b'\0' * pad:
                raise ValueError('Nonzero member padding')
            consumed += 512 + size + pad
        trailer = expected - consumed
        while trailer:
            if _check:
                _check()
            amount = min(65536, trailer)
            if reader.exact(amount) != b'\0' * amount:
                raise ValueError('Noncanonical tar EOF/padding')
            trailer -= amount
        if reader.read(1) or not reader.finished or reader.decoded != expected:
            raise ValueError('Extra decoded data or wrong EOF')
    return {'status':'passed', 'members':len(members), 'compressed_bytes':path.stat().st_size,
            'decoded_tar_bytes':expected, 'single_gzip_member':True, 'extracted':False}



def selection_members(raw, generation, *, expected_members, expected_bytes):
    """Validate transport metadata before trusting paths, sizes or allocation."""
    if len(raw) > 2097152:
        raise ValueError('Selection exceeds bound')
    selected = json.loads(raw)
    if (selected.get('format') != 'spicy-public-source-catalog-selection'
            or selected.get('version') != 1 or selected.get('generation') != generation
            or not re.fullmatch(r'sha256:[a-f0-9]{64}', generation)):
        raise ValueError('Selection format/generation mismatch')
    members = selected['files']
    if not isinstance(members, list) or len(members) != expected_members:
        raise ValueError('Selection member count differs')
    prefix = 'generations/' + generation[7:] + '/'
    names = set()
    total = 0
    for item in members:
        name, size = item['path'], item['bytes']
        if (name in names or (name != 'manifest.json' and not name.startswith(prefix))
                or not name.endswith('.json') or type(size) is not int
                or not 0 <= size <= 4194304
                or not re.fullmatch(r'sha256:[a-f0-9]{64}', item['sha256'])):
            raise ValueError('Invalid selected member')
        canonical_header(name, size)
        names.add(name)
        total += size
    if 'manifest.json' not in names or total != expected_bytes:
        raise ValueError('Selected totals differ')
    return members


def no_links(path):
    if any(p.is_symlink() for p in [path, *path.parents]):
        raise ValueError('Symlink controlled path')


def extract_checked(archive, members, output, *, compressed_cap, decoded_cap, check=None):
    """Complete read-only preflight, then revalidate into a fresh owned tree.

    Failed fresh output is retained for diagnosis; never replace an older tree.
    """
    no_links(archive)
    no_links(output)
    validate(archive, members, compressed_cap=compressed_cap, decoded_cap=decoded_cap, _check=check)
    output.mkdir(exist_ok=False)
    opened = []
    def create(name):
        # validate compares the canonical safe header before this callback.
        target = output / name
        no_links(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        handle = target.open('xb')
        opened.append(handle)
        return handle
    try:
        result = validate(archive, members, compressed_cap=compressed_cap,
                          decoded_cap=decoded_cap, _write=create, _check=check)
    finally:
        for handle in opened:
            handle.close()
    return {**result, 'extracted': True}
