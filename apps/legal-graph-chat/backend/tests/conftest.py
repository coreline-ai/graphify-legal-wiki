from __future__ import annotations

import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parents[2]
for path in (BACKEND_ROOT, REPO_ROOT):
    value = str(path)
    if value not in sys.path:
        sys.path.insert(0, value)
