"""Retain bounded, complete sample pairs from already retained failed selections."""
import hashlib
import json
from collections import Counter
from pathlib import Path
import pyarrow as pa
import pyarrow.parquet as pq
from spicy_regs.etl_receipts import RECEIPT_SCHEMA, subject_identity
from spicy_regs.transforms.regulations_receipts import policy

HERE = Path(__file__).resolve().parent
ROOT = Path('/Users/mikewolfd/Work/corpora/session-reports-2026-10-06')
REG = ROOT / 'native-regulatory-current'
CASES = {
 'documents': (ROOT/'bulk-current-resume/hosted-37448259592/native-family-documents/documents/build/generation', '85246d894b714bce9c1bf7659802610a', '0b5de33cdecfc6fe304e40eb91b4a67c313794461e93aa1284dd368b075e7097',98658809,'716049625e91b35fbb87256440bb0ad396ea2297913ec6a2bcaeb4b202ca357f',431821675),
 'federal_register': (REG/'normal-public-read-back/federal-register','e3c3f2726d894cb9b83c512256e193a1','ada62c7f5430f9db8fc30003f28839968ec60750d2f66aeab196fdd1722399d7',221455671,'d31a5699bbc649e484aa4c72de1250cdf7ae1e198614742efce4c257f6cce688',488431905),
 'fr_docket_links': (REG/'fr-docket-links/build/generations/f140afd8b586f9d99154aba68dd9b9c6c4819b8cdd46566bbe71336211fed404','f69a916b606e46b39f0e18a2ca602aa3','33c0cedc26ed3bd447dfc0d6648cc735861cd96c8e969cda50d4f180be32a1b9',120163600,'9712c3524eda87c1ddd4990b19111f09fa987f11522681a8501b654951d3b859',349151517),
 'comment_periods': (REG/'imported-prior','native-rulemaking-import-20261005-v1','737aa48e93b63b915be4b41832def04058325131483a8faaa126f536302a8467',24659603,'1515e103d375a8315d4620b2b9c9e8188c806d079ce23f42ab63cc27aefe0036',409667576),
 'rule_targets': (REG/'imported-prior','native-rulemaking-import-20261005-v1','e70f29e83a22bf3f9a618cbfd1b7c93e9a841ca3d35acc62276654a481b021b8',27895479,'1515e103d375a8315d4620b2b9c9e8188c806d079ce23f42ab63cc27aefe0036',409667576),
}

def stamp(path):
 s=path.stat(); return {'inode':s.st_ino,'byteSize':s.st_size,'mtimeNs':s.st_mtime_ns}
def member(path):
 with path.open('rb') as source: digest=hashlib.file_digest(source,'sha256').hexdigest()
 return {'path':str(path.relative_to(HERE)), 'byteSize':path.stat().st_size,'sha256':'sha256:'+digest}

def main():
 if (HERE/'samples.json').exists(): raise ValueError('Preserve prior samples; use a fresh destination')
 results=[]
 for dataset,(directory,generation,subject_sha,subject_size,receipt_sha,receipt_size) in CASES.items():
  subject_path=directory/(dataset+'.parquet'); receipt_path=directory/'etl_receipts.parquet'
  before={str(p):stamp(p) for p in (subject_path,receipt_path)}
  if subject_path.stat().st_size!=subject_size or receipt_path.stat().st_size!=receipt_size: raise ValueError('Original member size differs')
  subjects=pq.ParquetFile(subject_path); receipts=pq.ParquetFile(receipt_path); declared=policy(dataset)
  if not subjects.schema_arrow.equals(declared.subject_schema,check_metadata=False): raise ValueError('Original subject schema differs')
  if not receipts.schema_arrow.equals(RECEIPT_SCHEMA): raise ValueError('Original receipt schema differs')
  decoded=0; raw_subject=[]; subject_ordinals=[]; position=0
  for group in range(subjects.num_row_groups):
   decoded+=subjects.metadata.row_group(group).total_byte_size
   if decoded>128*1024**2: raise ValueError('Sample preparation decoded byte bound')
   rows=subjects.read_row_group(group).to_pylist(); needed=8000-len(raw_subject)
   raw_subject.extend(rows[:needed]); subject_ordinals.extend(range(position,position+min(needed,len(rows)))); position+=len(rows)
   if len(raw_subject)==8000: break
  keys=[subject_identity(declared,row) for row in raw_subject]
  wanted={key[0]:key for key in keys}
  if len(wanted)!=8000: raise ValueError('Sample native identities are not unique')
  found={}; selected=[]; receipt_ordinals=[]; position=0; read_groups=[]
  dataset_column=RECEIPT_SCHEMA.get_field_index('dataset')
  for group in range(receipts.num_row_groups):
   footer=receipts.metadata.row_group(group); stats=footer.column(dataset_column).statistics
   start=position; position+=footer.num_rows
   if stats and stats.has_min_max and not stats.min<=dataset<=stats.max: continue
   decoded+=footer.total_byte_size
   if decoded>128*1024**2: raise ValueError('Receipt sample match closure exceeds decoded byte bound')
   read_groups.append(group)
   for offset,row in enumerate(receipts.read_row_group(group).to_pylist()):
    if row['dataset']!=dataset: continue
    if row['generation_id']!=generation: raise ValueError('Receipt generation differs')
    if row['outcome']=='accepted':
     key=wanted.get(row['record_id'])
     if key is None: continue
     if (row['record_id'],row['subject_version'],row['identity_json'])!=key: raise ValueError('Complete retained subject identity differs')
     if row['record_id'] in found: raise ValueError('Ambiguous selected receipt')
     found[row['record_id']]=row
    selected.append(row); receipt_ordinals.append(start+offset)
   if len(found)==len(wanted): break
  if len(found)!=len(wanted): raise ValueError('Bounded original receipt groups do not close the sample')
  for count in (2000,8000):
   ids={key[0] for key in keys[:count]}
   keep=[(ordinal,row) for ordinal,row in zip(receipt_ordinals,selected) if row['outcome']!='accepted' or row['record_id'] in ids]
   destination=HERE/'samples'/dataset/str(count); destination.mkdir(parents=True)
   native=destination/(dataset+'.parquet'); held=destination/'etl_receipts.parquet'
   pq.write_table(pa.Table.from_pylist(raw_subject[:count],schema=subjects.schema_arrow),native,compression='zstd')
   pq.write_table(pa.Table.from_pylist([row for _,row in keep],schema=RECEIPT_SCHEMA),held,compression='zstd')
   results.append({'dataset':dataset,'generationId':generation,'sampleAcceptedRows':count,
    'subjects':[member(native)],'receipts':member(held),'outcomes':dict(Counter(row['outcome'] for _,row in keep)),
    'originalSubjectOrdinals':subject_ordinals[:count],'originalReceiptOrdinals':[ordinal for ordinal,_ in keep],
    'setupDecodedFooterBytes':decoded,'originalReceiptGroupsRead':read_groups,
    'originalMembers':{'subject':{'path':str(subject_path),'sha256':'sha256:'+subject_sha,'byteSize':subject_size},
                       'receipts':{'path':str(receipt_path),'sha256':'sha256:'+receipt_sha,'byteSize':receipt_size}},
    'qualificationScope':'Complete paired sampled subset only; full parent hashes refer to retained prior admission, not a new full-file check.'})
  after={str(p):stamp(p) for p in (subject_path,receipt_path)}
  if before!=after: raise ValueError('Original retained files changed during preparation')
  for result in results[-2:]: result['originalStableStat']=before
 total=sum(p.stat().st_size for p in (HERE/'samples').rglob('*.parquet'))
 if total>32*1024**2: raise ValueError('Total compressed sample bound exceeded')
 (HERE/'samples.json').write_text(json.dumps({'format':'spicygov-restore-diagnostic-samples','version':1,'sourceReader':'032c5a2ef9da7754a74be911254ccffc8dddfe53','compressedSampleBytes':total,'cases':results},indent=2)+'\n')
 print(json.dumps({'cases':len(results),'compressedSampleBytes':total}))

if __name__=='__main__': main()
