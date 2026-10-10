"""Tiny synthetic archive and HTTP framing tests; no live requests/catalog."""
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import time
import unittest
import zlib
from email.message import Message

SCRIPTS = Path(__file__).parents[1] / 'scripts'
def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
archive = load('source-catalog-archive')
fetch = load('fetch-source-catalog')
sha = lambda b: 'sha256:' + hashlib.sha256(b).hexdigest()

class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.root = Path(self.temp.name)
        self.path = self.root / 'toy.tar.gz'
        self.members = [{'path': 'item.json', 'bytes': 2, 'sha256': sha(b'{}')}]
        header = archive.canonical_header('item.json', 2)
        self.raw = header + b'{}' + b'\0' * 510 + b'\0' * 9216
        self.write(self.raw)
    def tearDown(self):
        self.temp.cleanup()
    def write(self, raw):
        with self.path.open('wb') as stream:
            with gzip.GzipFile(filename='',mtime=0,compresslevel=6,fileobj=stream,mode='wb') as zipped:
                zipped.write(raw)
    def check(self):
        return archive.validate(self.path,self.members,compressed_cap=4096,decoded_cap=10240)
    def test_roundtrip_extraction_exact(self):
        target=self.root/'fresh'
        archive.extract_checked(self.path,self.members,target,compressed_cap=4096,decoded_cap=10240)
        self.assertEqual((target/'item.json').read_bytes(),b'{}')
    def test_invalid_preflight_creates_no_output(self):
        self.members[0]['sha256']=sha(b'bad')
        target=self.root/'fresh'
        with self.assertRaises(ValueError):archive.extract_checked(self.path,self.members,target,compressed_cap=4096,decoded_cap=10240)
        self.assertFalse(target.exists())
    def test_existing_output_preserved(self):
        target=self.root/'old';target.mkdir();(target/'keep').write_text('retained')
        with self.assertRaises(FileExistsError):archive.extract_checked(self.path,self.members,target,compressed_cap=4096,decoded_cap=10240)
        self.assertEqual((target/'keep').read_text(),'retained')
    def test_symlink_output_refused(self):
        target=self.root/'link';target.symlink_to(self.root)
        with self.assertRaises(ValueError):archive.extract_checked(self.path,self.members,target,compressed_cap=4096,decoded_cap=10240)
    def test_traversal_and_link_headers_refused(self):
        for name,kind in [('../escape',tarfile.REGTYPE),('item.json',tarfile.SYMTYPE)]:
            h=tarfile.TarInfo(name);h.size=2;h.mode=0o644;h.type=kind;h.linkname='outside'
            self.write(h.tobuf(tarfile.USTAR_FORMAT)+self.raw[512:])
            with self.assertRaises(ValueError):self.check()
    def test_trailing_and_concatenation_refused(self):
        good=self.path.read_bytes()
        for extra in [b'x',gzip.compress(b'other',mtime=0)]:
            self.path.write_bytes(good+extra)
            with self.assertRaises(ValueError):self.check()
    def test_crc_and_truncated_refused(self):
        good=self.path.read_bytes()
        for bad in [good[:-5],good[:-8]+bytes([good[-8]^1])+good[-7:]]:
            self.path.write_bytes(bad)
            with self.assertRaises((ValueError,EOFError,zlib.error)):self.check()
    def test_padding_and_decoded_bomb_refused(self):
        for raw in [self.raw[:-1]+b'x',self.raw+b'x'*65536]:
            self.write(raw)
            with self.assertRaises(ValueError):self.check()
    def test_duplicate_and_compressed_cap_refused(self):
        with self.assertRaises(ValueError):archive.validate(self.path,self.members*2,compressed_cap=4096,decoded_cap=10240)
        with self.assertRaises(ValueError):archive.validate(self.path,self.members,compressed_cap=1,decoded_cap=10240)
    def response(self,body,**headers):
        class Response(io.BytesIO):
            status=200;url='https://example.invalid/exact'
        r=Response(body);r.headers=Message()
        for k,v in headers.items():r.headers[k]=v
        class Opener:
            def open(self,request,timeout):
                self.request=request;return r
        return Opener()
    def test_selection_generation_scope(self):
        generation='sha256:'+'a'*64
        selected={'format':'spicy-public-source-catalog-selection','version':1,'generation':generation,'files':[{'path':'manifest.json','bytes':2,'sha256':sha(b'{}')}]}
        self.assertEqual(len(archive.selection_members(json.dumps(selected).encode(),generation,expected_members=1,expected_bytes=2)),1)
        selected['files'][0]['path']='../escape.json'
        with self.assertRaises(ValueError):archive.selection_members(json.dumps(selected).encode(),generation,expected_members=1,expected_bytes=2)
    def test_download_redirect_status(self):
        opener=self.response(b'{}');response=opener.open(None,30);response.status=302
        with self.assertRaises(ValueError):fetch.download('https://example.invalid/exact',self.root/'redirect',2,sha(b'{}'),opener=opener)
    def test_download_identity_and_hash(self):
        result=fetch.download('https://example.invalid/exact',self.root/'download',2,sha(b'{}'),opener=self.response(b'{}',**{'Content-Length':'2'}))
        self.assertEqual(result['bytes'],2)
    def test_download_overflow_short_hash_encoding_length(self):
        cases=[(b'xxx',{}),(b'x',{}),(b'xx',{}),(b'{}',{'Content-Encoding':'gzip'}),(b'{}',{'Content-Length':'3'})]
        for i,(body,headers) in enumerate(cases):
            with self.assertRaises(ValueError):fetch.download('https://example.invalid/exact',self.root/str(i),2,sha(b'{}'),opener=self.response(body,**headers))
    def test_download_type_and_repeated_framing(self):
        with self.assertRaises(ValueError):fetch.download('https://example.invalid/exact',self.root/'type',2,sha(b'{}'),opener=self.response(b'{}',**{'Content-Type':'text/html'}),media_type='application/json')
        opener=self.response(b'{}');response=opener.open(None,30);response.headers.add_header('Content-Length','2');response.headers.add_header('Content-Length','2')
        with self.assertRaises(ValueError):fetch.download('https://example.invalid/exact',self.root/'repeat',2,sha(b'{}'),opener=opener)
    def test_download_deadline_and_no_overwrite(self):
        with self.assertRaises(TimeoutError):fetch.download('https://example.invalid/exact',self.root/'deadline',2,sha(b'{}'),opener=self.response(b'{}'),deadline=time.monotonic()-1)
        target=self.root/'old';target.write_bytes(b'keep')
        with self.assertRaises(FileExistsError):fetch.download('https://example.invalid/exact',target,2,sha(b'{}'),opener=self.response(b'{}'))
        self.assertEqual(target.read_bytes(),b'keep')

if __name__ == '__main__':
    unittest.main()
