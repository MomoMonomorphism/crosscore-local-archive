"""Explicit, pinned per-package references. Never substitutes game Lua/configs."""
from functools import lru_cache
import hashlib
import json
from pathlib import Path
from runtime_paths import PATHS

ROOT = Path(__file__).resolve().parent
DEFAULT_SOURCE = PATHS['source']
REFERENCES = json.loads((ROOT / 'spine_resource_references.json').read_text('utf8'))


@lru_cache(maxsize=16)
def _digest(path: str, size: int, mtime_ns: int) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _verify(path: Path, expected: str) -> None:
    stat = path.stat()
    if _digest(str(path.resolve()), stat.st_size, stat.st_mtime_ns) != expected:
        raise ValueError(f'Pinned Spine reference hash mismatch: {path}')


def resolve_spine_source(package: str, source_root: Path) -> Path:
    base = source_root / package
    reference = REFERENCES.get(package)
    # Explicit alternative --source roots retain their own resources.
    if not reference or source_root.resolve() != DEFAULT_SOURCE.resolve():
        return base
    # A public clone may configure its own game build. Pinned comparisons only
    # authorize substitutions for the frozen PC baseline that was actually audited.
    if reference.get('baseSource') and source_root.resolve() != (ROOT / reference['baseSource']).resolve():
        return base
    target = (ROOT / reference['source']).resolve()
    _verify(base, reference['baseSha256'])
    _verify(target, reference['sha256'])
    return target


def spine_reference_metadata(package: str, source: Path) -> dict | None:
    reference = REFERENCES.get(package)
    if reference and source.resolve() == (ROOT / reference['source']).resolve():
        return {k: reference[k] for k in ('platform', 'baseline', 'sha256', 'spineVersion', 'reason')}
    return None
