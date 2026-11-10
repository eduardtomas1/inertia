"""Map the six themed models onto stable app IDs, then frame both WebP variants."""
import argparse
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROLES = {
    'runner': 'workflow-planner',
    'scout': 'investigator',
    'guard': 'marketer',
    'builder': 'builder',
    'scribe': 'writer',
    'spark': 'creative',
}
ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path, default=ROOT/'source-assets/custom-agent-marks')
parser.add_argument('--output', type=Path, default=ROOT/'src/renderer/src/assets/marks')
parser.add_argument('--sheets', type=Path, default=ROOT/'source-assets/custom-agent-marks/app-review')
args = parser.parse_args()
with tempfile.TemporaryDirectory(prefix='inertia-themed-marks-') as temporary:
    for mark, role in ROLES.items():
        source = args.source/role/(role+'-transparent.png')
        for theme in ['dark', 'light']:
            shutil.copyfile(source, Path(temporary)/(mark+'-'+theme+'.png'))
    subprocess.run([
        sys.executable, str(Path(__file__).with_name('frame-renders.py')),
        '--source', temporary, '--output', str(args.output), '--sheets', str(args.sheets),
        '--light-contrast', '1.1', '--light-lift', '0', '--dark-brightness', '1.06',
    ], check=True)
