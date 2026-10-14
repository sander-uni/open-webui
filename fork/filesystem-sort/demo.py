"""Run the installed requirement-demos engine with this feature's catalog.

Only catalog/output paths change. The engine fingerprints the whole repository
and uses its standard validation, recorder, answers and proof checks.
"""

import importlib.util
import os
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[2]
os.chdir(root)
skill = Path(os.environ['REQUIREMENT_DEMOS_DIR'])
sys.path.insert(0, str(skill / 'scripts'))
spec = importlib.util.spec_from_file_location('requirement_demos', skill / 'scripts/demo.py')
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)
directory = Path('fork/filesystem-sort/demos')
engine.REQ_FILE = directory / 'requirements.json'
engine.STATE_FILE = directory / 'state.json'
engine.ANSWERS_FILE = directory / 'answers.json'
engine.RUNS_DIR = directory / 'runs'
raise SystemExit(engine.main(sys.argv[1:]))
