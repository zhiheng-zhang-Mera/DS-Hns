import unittest,sys
from pathlib import Path
class CostRssTest(unittest.TestCase):
 def test_actual_process_peak_is_measured_not_zero(self):
  sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts/ecq'))
  import bench_shacl_cost
  self.assertGreater(bench_shacl_cost.peak_rss(),1024*1024)
if __name__=='__main__':unittest.main()
