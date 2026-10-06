"""The diagnostic wrapper must preserve maintained admission and refusal."""
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
import pyarrow as pa
import pyarrow.parquet as pq
from spicy_regs.etl_receipts import RECEIPT_SCHEMA, _digest, decode_exact_json, exact_json
from spicy_regs.transforms.regulations_receipts import write_held_dataset
from spicy_regs.transforms.regulations_shape import SOURCE_COLUMNS

HARNESS=Path(__file__).with_name('profile_restore.py')

def member(path):
 return {'path':path.name,'byteSize':path.stat().st_size,'sha256':'sha256:'+hashlib.sha256(path.read_bytes()).hexdigest()}

class InstrumentedRefusalTest(unittest.TestCase):
 def test_instrumented_actual_bridge_keeps_valid_and_invalid_outcomes(self):
  for change in ('valid','digest','missing','raw'):
   with self.subTest(change=change), tempfile.TemporaryDirectory() as temporary:
    root=Path(temporary)
    schema=pa.schema([(name,pa.string()) for name,_ in SOURCE_COLUMNS['federal_register']])
    row=dict.fromkeys(schema.names); row.update(document_number='2026-00001',publication_date='2026-06-30',volume='0091',title='literal source')
    source=root/'source.parquet'; pq.write_table(pa.Table.from_pylist([row],schema=schema),source)
    native,receipts=write_held_dataset('federal_register',source,root/'native',generation_id='fixture-generation')
    rows=pq.read_table(receipts).to_pylist(); accepted=next(r for r in rows if r['outcome']=='accepted')
    if change=='digest': accepted['receipt_id']='sha256:'+'0'*64
    elif change=='missing': rows.remove(accepted)
    elif change=='raw':
     values=decode_exact_json(accepted['processing_json']); values['raw_conversion_inputs']['publication_date']='2025-06-30'
     accepted['processing_json']=exact_json(values); accepted['receipt_id']=_digest({k:v for k,v in accepted.items() if k!='receipt_id'})
    pq.write_table(pa.Table.from_pylist(rows,schema=RECEIPT_SCHEMA),receipts)
    sample=root/'samples'; sample.mkdir()
    native_copy=sample/native.name; native_copy.write_bytes(native.read_bytes())
    receipts_copy=sample/receipts.name; receipts_copy.write_bytes(receipts.read_bytes())
    (sample/'samples.json').write_text(json.dumps({'cases':[{'dataset':'federal_register','generationId':'fixture-generation','sampleAcceptedRows':1,'subjects':[member(native_copy)],'receipts':member(receipts_copy),'outcomes':{'accepted':sum(r['outcome']=='accepted' for r in rows),'observed':sum(r['outcome']=='observed' for r in rows)}}]}))
    output=root/'diagnostics'
    code="import importlib.util; from pathlib import Path; s=importlib.util.spec_from_file_location('h',"+repr(str(HARNESS))+ "); h=importlib.util.module_from_spec(s); s.loader.exec_module(h); h.HERE=Path("+repr(str(sample))+"); h.child(0,Path("+repr(str(output))+"),False)"
    process=subprocess.run([sys.executable,'-c',code],capture_output=True,text=True,timeout=30)
    summary=json.loads((output/'summary.json').read_text())
    self.assertEqual(summary['status'],'passed' if change=='valid' else 'failed')
    self.assertEqual(process.returncode==0,change=='valid')
    self.assertEqual((output/'restored'/'coverage-facts.parquet').exists(),change=='valid')
    if change=='valid':
     self.assertEqual(summary['receiptOutcomes'],{'accepted':1,'observed':1})
     self.assertTrue(any('active_next' in e['phase'] for e in summary['phases']) or summary['counts'].get('spicy_regs.etl_bulk.validate_bundle.calls')==1)

if __name__=='__main__': unittest.main()
