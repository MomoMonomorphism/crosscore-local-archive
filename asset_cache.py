from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import threading
import uuid
from pathlib import Path, PurePosixPath
from typing import Any

import UnityPy
from runtime_paths import PATHS


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = PATHS['source']
DEFAULT_CACHE = PATHS['cache']
DEFAULT_CENSUS = PATHS['census']
PACKAGE_PREFIX = "prefabs_spine_"
SAFE_PACKAGE = re.compile(r"^[A-Za-z0-9_. -]+$")
SPINE_VERSION = re.compile(r'"spine"\s*:\s*"([^"]+)"')
_locks_guard = threading.Lock()
_locks: dict[str, threading.Lock] = {}


def _package_lock(package: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(package, threading.Lock())


def validate_package(package: str) -> str:
    if not package.startswith(PACKAGE_PREFIX) or not SAFE_PACKAGE.fullmatch(package):
        raise ValueError(f"invalid Spine package name: {package!r}")
    return package


def folder_for_package(package: str) -> str:
    return validate_package(package)[len(PACKAGE_PREFIX) :]


def unwrap_bundle(path: Path) -> tuple[bytes, int, bytes]:
    raw = path.read_bytes()
    offset = max(
        1,
        (23 + sum(ord(char) | (ord(char) << 16) for char in path.name[-3:]))
        % 256,
    )
    if raw[offset : offset + 8] != b"UnityFS\0":
        first = raw.find(b"UnityFS\0")
        second = raw.find(b"UnityFS\0", first + 1) if first >= 0 else -1
        if second < 0:
            raise ValueError(f"no real UnityFS header found in {path.name}")
        offset = second
    return raw, offset, raw[offset:]


def text_bytes(asset: Any) -> bytes:
    content = asset.m_Script
    if isinstance(content, bytes):
        return content
    return content.encode("utf-8", "surrogateescape")


def safe_relative_asset(name: str) -> Path:
    posix = PurePosixPath(name.replace("\\", "/"))
    if posix.is_absolute() or ".." in posix.parts or not posix.parts:
        raise ValueError(f"unsafe asset path: {name!r}")
    return Path(*posix.parts)


def allocate_output_name(
    source_name: str, seen: dict[str, int], default_suffix: str = ""
) -> str:
    candidate = source_name
    if default_suffix and not PurePosixPath(candidate).suffix:
        candidate = f"{candidate}{default_suffix}"
    key = candidate.casefold()
    occurrence = seen.get(key, 0) + 1
    seen[key] = occurrence
    if occurrence == 1:
        return candidate
    path = PurePosixPath(candidate)
    return str(path.with_name(f"{path.stem} #{occurrence}{path.suffix}"))


def atlas_pages(content: bytes) -> list[str]:
    text = content.decode("utf-8-sig", "surrogateescape")
    pages: list[str] = []
    for line in text.splitlines():
        candidate = line.strip()
        if candidate.lower().endswith(".png") and ":" not in candidate:
            safe_relative_asset(candidate)
            if candidate not in pages:
                pages.append(candidate)
    return pages


def _version(content: bytes) -> str | None:
    match = SPINE_VERSION.search(content[:1200].decode("utf-8", "surrogateescape"))
    return match.group(1) if match else None


def _is_skeleton(content: bytes) -> bool:
    head = content[:1600]
    return b'"skeleton"' in head or b'"bones"' in head


def _cached_manifest(target: Path, source: Path) -> dict[str, Any] | None:
    path = target / "manifest.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    stat = source.stat()
    identity = data.get("sourceIdentity", {})
    if identity.get("size") != stat.st_size or identity.get("mtimeNs") != stat.st_mtime_ns:
        return None
    files = data.get("files", [])
    if not files or not all((target / item).is_file() for item in files):
        return None
    data["cacheHit"] = True
    return data


def extract_package(
    package: str,
    source_root: Path = DEFAULT_SOURCE,
    cache_root: Path = DEFAULT_CACHE,
    *,
    force: bool = False,
) -> dict[str, Any]:
    package = validate_package(package)
    source = source_root / package
    if not source.is_file():
        raise FileNotFoundError(source)
    target = cache_root / "spine" / folder_for_package(package)

    with _package_lock(package):
        if not force:
            cached = _cached_manifest(target, source)
            if cached:
                return cached

        raw, offset, bundle = unwrap_bundle(source)
        environment = UnityPy.load(bundle)
        skeletons: list[dict[str, Any]] = []
        atlases: list[dict[str, Any]] = []
        textures: dict[str, Any] = {}
        text_names_seen: dict[str, int] = {}

        for obj in environment.objects:
            if obj.type.name == "TextAsset":
                asset = obj.read()
                name = (asset.m_Name or "").strip()
                content = text_bytes(asset)
                if name.lower().endswith(".atlas"):
                    atlases.append(
                        {
                            "sourceName": name,
                            "outputName": allocate_output_name(name, text_names_seen),
                            "content": content,
                        }
                    )
                elif _is_skeleton(content):
                    skeletons.append(
                        {
                            "sourceName": name,
                            "outputName": allocate_output_name(name, text_names_seen, ".json"),
                            "content": content,
                        }
                    )
            elif obj.type.name == "Texture2D":
                asset = obj.read()
                textures[(asset.m_Name or "").strip().lower()] = asset
        if not skeletons or not atlases:
            raise ValueError(
                f"{package} does not contain a browser-ready Spine skeleton and atlas"
            )

        requested_pages: list[str] = []
        for atlas in atlases:
            for page in atlas_pages(atlas["content"]):
                if page not in requested_pages:
                    requested_pages.append(page)

        missing_pages: list[str] = []
        matched_textures: dict[str, Any] = {}
        for page in requested_pages:
            key = PurePosixPath(page.replace("\\", "/")).name[:-4].lower()
            texture = textures.get(key)
            if texture is None:
                missing_pages.append(page)
            else:
                matched_textures[page] = texture
        if missing_pages:
            raise ValueError(f"atlas pages have no matching Texture2D: {missing_pages}")

        temporary = target.parent / f".{target.name}.tmp-{uuid.uuid4().hex}"
        temporary.mkdir(parents=True, exist_ok=False)
        files: list[str] = []
        models: list[dict[str, Any]] = []
        try:
            for skeleton in skeletons:
                relative = safe_relative_asset(skeleton["outputName"])
                path = temporary / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(skeleton["content"])
                files.append(relative.as_posix())
                models.append(
                    {
                        "name": PurePosixPath(skeleton["outputName"]).stem,
                        "sourceName": skeleton["sourceName"],
                        "json": relative.as_posix(),
                        "spineVersion": _version(skeleton["content"]),
                    }
                )

            for atlas in atlases:
                relative = safe_relative_asset(atlas["outputName"])
                path = temporary / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(atlas["content"])
                files.append(relative.as_posix())

            for page, texture in matched_textures.items():
                relative = safe_relative_asset(page)
                path = temporary / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                texture.image.save(path, format="PNG")
                files.append(relative.as_posix())

            source_stat = source.stat()
            manifest = {
                "package": package,
                "folder": folder_for_package(package),
                "source": str(source),
                "sourceIdentity": {
                    "size": source_stat.st_size,
                    "mtimeNs": source_stat.st_mtime_ns,
                    "sha256": hashlib.sha256(raw).hexdigest(),
                    "unityFsOffset": offset,
                },
                "unityPyVersion": UnityPy.__version__,
                "models": models,
                "atlases": [atlas["outputName"] for atlas in atlases],
                "pages": requested_pages,
                "files": sorted(set(files)),
                "cacheHit": False,
            }
            (temporary / "manifest.json").write_text(
                json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            if target.exists():
                shutil.rmtree(target)
            temporary.replace(target)
            return manifest
        except Exception:
            shutil.rmtree(temporary, ignore_errors=True)
            raise


ARCHIVE_IMAGE_PREFIX = "textures_bigs_uis_multiimg_"
SAFE_ARCHIVE_NAME = re.compile(r"^[a-z0-9_-]+$")


def validate_archive_image(name: str) -> str:
    """Validate a `textures_bigs_uis_multiimg_<name>` stem.

    Kept separate from `validate_package` because the archive bundles do not carry the
    `prefabs_spine_` prefix, and its stricter character class also blocks path traversal.
    """
    if not SAFE_ARCHIVE_NAME.fullmatch(name or ""):
        raise ValueError(f"invalid archive image name: {name!r}")
    return name


def extract_archive_image(
    name: str, source_root: Path, cache_root: Path
) -> tuple[Path, dict[str, Any]]:
    """Extract the single `img` Texture2D from an archive big-image bundle.

    Writes `cache/archive/<name>.png` plus a sidecar manifest, and returns the PNG path.
    The extraction is idempotent: the sidecar records the source bundle size and mtime, so
    a cached PNG is reused unless the bundle actually changed.
    """
    validate_archive_image(name)
    package = ARCHIVE_IMAGE_PREFIX + name
    source = source_root / package
    if not source.is_file():
        raise FileNotFoundError(f"archive bundle not found: {package}")

    target_dir = cache_root / "archive"
    target_dir.mkdir(parents=True, exist_ok=True)
    image_path = target_dir / f"{name}.png"
    manifest_path = target_dir / f"{name}.json"

    stat = source.stat()
    cached = _cached_manifest(manifest_path, source) if image_path.is_file() else None
    if cached is not None:
        return image_path, cached

    with _package_lock(package):
        if image_path.is_file():
            cached = _cached_manifest(manifest_path, source)
            if cached is not None:
                return image_path, cached
        _, _, bundle = unwrap_bundle(source)
        environment = UnityPy.load(bundle)
        texture = None
        for obj in environment.objects:
            if obj.type.name != "Texture2D":
                continue
            texture = obj.read()
            break
        if texture is None:
            raise ValueError(f"no Texture2D in {package}")
        image = texture.image
        image.save(image_path, format="PNG", optimize=True)
        manifest = {
            "name": name,
            "package": package,
            "path": f"archive/{name}.png",
            "sourceBytes": stat.st_size,
            "sourceMtime": int(stat.st_mtime),
            "width": image.width,
            "height": image.height,
            "bytes": image_path.stat().st_size,
        }
        temporary = manifest_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(manifest_path)
        return image_path, manifest


def load_catalog(census_path: Path = DEFAULT_CENSUS) -> list[dict[str, Any]]:
    rows = json.loads(census_path.read_text(encoding="utf-8"))
    catalog: list[dict[str, Any]] = []
    for row in rows:
        skeletons = row.get("skeleton") or []
        if row.get("error") or not skeletons or not row.get("atlas") or not row.get("tex"):
            continue
        package = validate_package(row["pkg"])
        catalog.append(
            {
                "package": package,
                "folder": folder_for_package(package),
                "bundleBytes": row.get("bytes", 0),
                "models": skeletons,
                "atlases": row.get("atlas", []),
                "textureCount": len(row.get("tex", [])),
                "spineVersions": sorted(
                    {item.get("spine") for item in skeletons if item.get("spine")}
                ),
            }
        )
    return catalog


def write_catalog(
    cache_root: Path = DEFAULT_CACHE, census_path: Path = DEFAULT_CENSUS
) -> Path:
    cache_root.mkdir(parents=True, exist_ok=True)
    path = cache_root / "catalog.json"
    entries = load_catalog(census_path)
    content = json.dumps(
        {"entries": entries, "count": len(entries)}, ensure_ascii=False, indent=2
    )
    if not path.is_file() or path.read_text(encoding="utf-8") != content:
        path.write_text(content, encoding="utf-8")
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract CrossCore Spine assets into a cache")
    parser.add_argument("packages", nargs="*", help="exact prefabs_spine_* package names")
    parser.add_argument("--all", action="store_true", help="extract every browser-ready package")
    parser.add_argument("--limit", type=int, default=None, help="limit --all for validation")
    parser.add_argument("--force", action="store_true", help="replace a valid cached result")
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--census", type=Path, default=DEFAULT_CENSUS)
    args = parser.parse_args()

    catalog_path = write_catalog(args.cache, args.census)
    packages = list(args.packages)
    if args.all:
        packages.extend(item["package"] for item in load_catalog(args.census))
    packages = list(dict.fromkeys(packages))
    if args.limit is not None:
        packages = packages[: max(0, args.limit)]

    print(f"catalog: {catalog_path} ({len(load_catalog(args.census))} packages)")
    for index, package in enumerate(packages, 1):
        result = extract_package(
            package, args.source, args.cache, force=args.force
        )
        state = "cache" if result.get("cacheHit") else "extracted"
        print(
            f"[{index}/{len(packages)}] {state}: {package} "
            f"({len(result['models'])} models, {len(result['pages'])} pages)"
        )


if __name__ == "__main__":
    main()
