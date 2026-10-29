import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('inventory',Path(__file__).resolve().parents[1]/'scripts/check-archive-inventory.py')
inventory=importlib.util.module_from_spec(spec);spec.loader.exec_module(inventory)

class Inventory(unittest.TestCase):
    def test_zero_byte_objects_sizes_missing_and_retained_extras_stay_distinct(self):
        rows=[]
        result=inventory.compare({'empty':0,'same':2,'changed':3,'missing':4},
                                 [('empty',0),('same',2),('changed',5),('old',1),('same',2)],rows.append)
        self.assertEqual(result,dict(both=2,localOnly=1,r2Only=1,sizeMismatch=1,duplicate=1))
        self.assertEqual(next(r for r in rows if r['kind']=='localOnly')['key'],'missing')
        self.assertEqual(next(r for r in rows if r['kind']=='sizeMismatch')['expectedBytes'],3)

if __name__=='__main__':unittest.main()
