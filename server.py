from __future__ import annotations

import argparse
import hashlib
import os
import json
import mimetypes
import re
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlsplit
from runtime_paths import PATHS

from asset_cache import DEFAULT_CACHE, DEFAULT_CENSUS, DEFAULT_SOURCE, extract_archive_image, extract_package, load_catalog, write_catalog
from display_names import build_display_names
from spine_action import pos_space_of
from spine_runtime_settings import runtime_settings
from hall_entry import entry_manifest
from voice_cache import DEFAULT_SOURCE as DEFAULT_VOICE_SOURCE, decode_asmr, decode_stream


RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")


class AssetServer(ThreadingHTTPServer):
    runtime_paths: dict[str, str]
    source_root: Path
    cache_root: Path
    catalog_bytes: bytes
    manifest_path: Path
    display_names: dict | None
    display_names_lock: threading.Lock
    package_by_folder: dict[str, str]
    web_root: Path
    voice_source_root: Path
    voice_manifest: dict
    voice_manifest_bytes: bytes
    asmr_manifest: dict
    asmr_manifest_bytes: bytes
    thumbnail_manifest_bytes: bytes
    interaction_manifest_bytes: bytes
    multi_interaction_manifest_bytes: bytes
    audit_path: Path
    audit_lock: threading.Lock
    spine_layout_cache: dict[str, dict | None]
    spine_layout_lock: threading.Lock


class Handler(BaseHTTPRequestHandler):
    server: AssetServer

    def log_request(self, code="-", size="-") -> None:
        if urlsplit(self.path).path == '/api/spine-ui' and str(code) == '200':
            return
        super().log_request(code, size)

    def send_json(self, payload: object, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        path = unquote(urlsplit(self.path).path)
        if path.startswith('/assets/spine-ui-audio/'):
            try:
                from spine_ui_audio import decode
                target = decode(path.removeprefix('/assets/spine-ui-audio/').removesuffix('.wav'), self.server.cache_root)
                self.serve_file(target, 'audio/wav')
            except (KeyError, FileNotFoundError):
                self.send_error(HTTPStatus.NOT_FOUND, 'UI sound not found')
            return
        if path == "/api/health":
            index = self.server.web_root / 'index.html'
            self.send_json({"ok": True, "assetMode": "local-on-demand", "service": "crosscore-local-viewer",
                            "workspace": str(Path(__file__).resolve().parent), "pid": os.getpid(), "parentPid": os.getppid(),
                            "runtimePaths": self.server.runtime_paths,
                            "source": str(self.server.source_root.resolve()), "cache": str(self.server.cache_root.resolve()),
                            "buildIndexSha256": hashlib.sha256(index.read_bytes()).hexdigest() if index.is_file() else None})
            return
        if path == "/api/catalog":
            body = self.server.catalog_bytes
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/api/cache-status":
            spine_root = self.server.cache_root / "spine"
            folders = [item for item in spine_root.iterdir() if item.is_dir()] if spine_root.is_dir() else []
            size = sum(file.stat().st_size for folder in folders for file in folder.rglob("*") if file.is_file())
            self.send_json({"packages": len(folders), "bytes": size})
            return
        if path.startswith("/api/spine-layout/"):
            folder = path.removeprefix("/api/spine-layout/")
            package = self.server.package_by_folder.get(folder)
            if package is None:
                self.send_error(HTTPStatus.NOT_FOUND, "unknown Spine folder")
                return
            with self.server.spine_layout_lock:
                if folder not in self.server.spine_layout_cache:
                    self.server.spine_layout_cache[folder] = pos_space_of(self.server.source_root / package)
                space = self.server.spine_layout_cache[folder]
            self.send_json({"folder": folder, "space": space})
            return
        if path.startswith("/api/spine-runtime/"):
            folder = path.removeprefix("/api/spine-runtime/")
            package = self.server.package_by_folder.get(folder)
            if package is None:
                self.send_error(HTTPStatus.NOT_FOUND, "unknown Spine folder")
                return
            try:
                self.send_json(runtime_settings(package, self.server.source_root, self.server.cache_root))
            except (OSError, ValueError) as error:
                self.send_json({"error": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        if path == "/api/manifest":
            if not self.server.manifest_path.is_file():
                self.send_json(
                    {"error": "manifest_not_generated", "command": "python generate_manifest.py"},
                    HTTPStatus.NOT_FOUND,
                )
                return
            body = self.server.manifest_path.read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/api/display-names":
            if not self.server.manifest_path.is_file():
                self.send_error(HTTPStatus.NOT_FOUND, "manifest not generated")
                return
            try:
                with self.server.display_names_lock:
                    if self.server.display_names is None:
                        gallery = json.loads(self.server.manifest_path.read_text(encoding="utf-8"))
                        self.server.display_names = build_display_names(
                            gallery, self.server.source_root / "luascripts"
                        )
                self.send_json(self.server.display_names)
            except (OSError, ValueError, KeyError) as error:
                self.send_json({"error": type(error).__name__, "detail": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        if path == "/api/voices":
            if not self.server.voice_manifest:
                self.send_json({"error": "voice_manifest_not_generated", "command": "python voice_cache.py"}, HTTPStatus.NOT_FOUND)
                return
            body = self.server.voice_manifest_bytes
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/api/hall-entries":
            self.send_json(entry_manifest(self.server.source_root, self.server.cache_root))
            return
        if path == "/api/interactions":
            if not self.server.interaction_manifest_bytes:
                self.send_json(
                    {"error": "interaction_manifest_not_generated", "command": "python spine_action.py"},
                    HTTPStatus.NOT_FOUND,
                )
                return
            body = self.server.interaction_manifest_bytes
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/api/multi-interactions":
            manifest_path = self.server.multi_interaction_path
            if not manifest_path.is_file():
                self.send_json({"error": "multi_interaction_manifest_not_generated",
                                "command": "python multi_picture_action.py"}, HTTPStatus.NOT_FOUND)
                return
            body = manifest_path.read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/api/spine-audit":
            if not self.server.audit_path.is_file():
                self.send_json({"error": "audit_not_started"}, HTTPStatus.NOT_FOUND)
                return
            body = self.server.audit_path.read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if path.startswith("/assets/voice/"):
            self.serve_voice(path.removeprefix("/assets/voice/"))
            return
        if path == "/api/asmr":
            if not self.server.asmr_manifest_bytes:
                self.send_json({"error": "asmr_manifest_not_generated", "command": "python voice_cache.py"}, HTTPStatus.NOT_FOUND)
                return
            body = self.server.asmr_manifest_bytes
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if path.startswith("/assets/asmr/"):
            self.serve_asmr(path.removeprefix("/assets/asmr/"))
            return
        if path == "/api/thumbnails":
            if not self.server.thumbnail_manifest_bytes:
                self.send_json({"error": "thumbnail_manifest_not_generated", "command": "python thumbnail_cache.py"}, HTTPStatus.NOT_FOUND)
                return
            body = self.server.thumbnail_manifest_bytes
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/api/archive-images":
            prefix = "textures_bigs_uis_multiimg_"
            names = sorted(
                item.name[len(prefix):]
                for item in self.server.source_root.glob(f"{prefix}*")
                if item.is_file()
            )
            self.send_json({"names": names})
            return
        if path.startswith("/assets/thumbnails/"):
            self.serve_thumbnail(path.removeprefix("/assets/thumbnails/"))
            return
        if path.startswith("/assets/portrait/"):
            from portrait_cache import extract_portrait
            try:
                name = path.removeprefix("/assets/portrait/").removesuffix(".png")
                output = extract_portrait(name, self.server.source_root, self.server.cache_root,
                                          thumbnail='thumbnail=1' in urlsplit(self.path).query)
                self.serve_file(output, "image/png")
            except FileNotFoundError:
                self.send_error(HTTPStatus.NOT_FOUND, "portrait not found")
            except ValueError as error:
                self.send_error(HTTPStatus.BAD_REQUEST, str(error))
            except Exception as error:
                self.send_json({"error": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        if path.startswith("/assets/archive/"):
            self.serve_archive_image(path.removeprefix("/assets/archive/"))
            return
        if path.startswith('/assets/spine-ui/'):
            root = (self.server.cache_root / 'spine-ui').resolve()
            target = root.joinpath(*PurePosixPath(path.removeprefix('/assets/spine-ui/')).parts).resolve()
            if root not in target.parents or not target.is_file() or target.suffix != '.png':
                self.send_error(HTTPStatus.NOT_FOUND, 'UI asset not found')
                return
            self.serve_file(target, 'image/png')
            return
        if path.startswith('/assets/drag/'):
            root = (self.server.cache_root / 'drag').resolve()
            target = root.joinpath(*PurePosixPath(path.removeprefix('/assets/drag/')).parts).resolve()
            if root not in target.parents or not target.is_file():
                self.send_error(HTTPStatus.NOT_FOUND, 'drag asset not found')
                return
            self.serve_file(target, 'image/png')
            return
        if path.startswith("/assets/spine/"):
            self.serve_asset(path.removeprefix("/assets/spine/"))
            return
        if self.server.web_root.is_dir():
            self.serve_web(path)
            return
        self.send_json({"service": "CrossCore local Spine asset cache", "manifest": "/api/manifest", "cache": "/api/cache-status"})

    def do_POST(self) -> None:
        path = unquote(urlsplit(self.path).path)
        if path == "/api/spine-ui":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > 65536:
                    raise ValueError("invalid SpineUI request size")
                from spine_ui import request
                self.send_json(request(json.loads(self.rfile.read(length)), self.server.source_root, self.server.cache_root))
            except Exception as error:
                self.send_json({"error": type(error).__name__, "detail": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if path != "/api/spine-audit":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 1024 * 1024:
                raise ValueError("invalid audit payload size")
            payload = json.loads(self.rfile.read(length))
            revision = payload.get("manifestRevision")
            record = payload.get("record")
            variant_id = record.get("variantId") if isinstance(record, dict) else None
            if not isinstance(revision, str) or not isinstance(variant_id, str) or len(variant_id) > 300:
                raise ValueError("invalid audit record")
            with self.server.audit_lock:
                current = {}
                if self.server.audit_path.is_file():
                    current = json.loads(self.server.audit_path.read_text(encoding="utf-8"))
                if current.get("manifestRevision") != revision:
                    current = {"manifestRevision": revision, "generatedAt": "", "results": {}}
                current["generatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                current.setdefault("results", {})[variant_id] = record
                temporary = self.server.audit_path.with_suffix(".tmp")
                temporary.write_text(json.dumps(current, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                temporary.replace(self.server.audit_path)
            self.send_json(current)
        except (ValueError, json.JSONDecodeError, OSError) as error:
            self.send_json({"error": type(error).__name__, "detail": str(error)}, HTTPStatus.BAD_REQUEST)

    def serve_web(self, url_path: str) -> None:
        parts = PurePosixPath(url_path.lstrip("/")).parts
        if ".." in parts:
            self.send_error(HTTPStatus.BAD_REQUEST, "invalid web path")
            return
        requested = self.server.web_root.joinpath(*parts).resolve() if parts else self.server.web_root / "index.html"
        root = self.server.web_root.resolve()
        if requested != root / "index.html" and root not in requested.parents:
            self.send_error(HTTPStatus.BAD_REQUEST, "invalid web path")
            return
        file_path = requested if requested.is_file() else root / "index.html"
        if not file_path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND, "viewer not built")
            return
        body = file_path.read_bytes()
        content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache" if file_path.name == "index.html" else "public, max-age=31536000, immutable")
        self.end_headers()
        self.wfile.write(body)

    def serve_asset(self, relative_url: str) -> None:
        parts = PurePosixPath(relative_url).parts
        if len(parts) < 2 or ".." in parts:
            self.send_error(HTTPStatus.BAD_REQUEST, "invalid asset path")
            return
        folder = parts[0]
        package = self.server.package_by_folder.get(folder)
        if package is None:
            self.send_error(HTTPStatus.NOT_FOUND, "unknown Spine folder")
            return
        try:
            extract_package(package, self.server.source_root, self.server.cache_root)
        except Exception as error:
            self.send_json(
                {"error": type(error).__name__, "detail": str(error)},
                HTTPStatus.INTERNAL_SERVER_ERROR,
            )
            return

        root = (self.server.cache_root / "spine" / folder).resolve()
        file_path = root.joinpath(*parts[1:]).resolve()
        if root not in file_path.parents or not file_path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND, "asset not found")
            return
        content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        size = file_path.stat().st_size
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        self.end_headers()
        with file_path.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                self.wfile.write(chunk)

    def serve_file(self, file_path: Path, content_type: str, immutable: bool = True) -> None:
        """Send a file, honouring a single `Range` request.

        ASMR albums decode to ~200 MB WAVs, and a browser cannot seek in a media
        file the server refuses to serve partially, so range support is what makes
        the transcript seek bar work at all.
        """
        total = file_path.stat().st_size
        start, end = 0, total - 1
        status = HTTPStatus.OK
        header = self.headers.get("Range")
        if header:
            match = RANGE_RE.fullmatch(header.strip())
            if not match:
                self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE, "malformed range")
                return
            first, last = match.groups()
            if first == "":
                length = int(last) if last else 0
                if length <= 0:
                    self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE, "bad suffix range")
                    return
                start, end = max(0, total - length), total - 1
            else:
                start = int(first)
                end = int(last) if last else total - 1
                end = min(end, total - 1)
                if start >= total or end < start:
                    self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                    self.send_header("Content-Range", f"bytes */{total}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
            status = HTTPStatus.PARTIAL_CONTENT
        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        if status == HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range", f"bytes {start}-{end}/{total}")
        self.send_header(
            "Cache-Control",
            "public, max-age=31536000, immutable" if immutable else "no-store",
        )
        self.end_headers()
        with file_path.open("rb") as handle:
            handle.seek(start)
            remaining = length
            while remaining > 0:
                chunk = handle.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def serve_asmr(self, relative_url: str) -> None:
        parts = PurePosixPath(relative_url).parts
        if len(parts) != 1 or ".." in parts or not parts[0].lower().endswith(".wav"):
            self.send_error(HTTPStatus.BAD_REQUEST, "invalid asmr path")
            return
        stem = PurePosixPath(parts[0]).stem
        preview = stem.endswith("-preview")
        voice = stem.removesuffix("-preview")
        if not voice.isdigit():
            self.send_error(HTTPStatus.BAD_REQUEST, "invalid asmr album")
            return
        album = next(
            (item for item in self.server.asmr_manifest.get("albums", []) if item["voice"] == int(voice)),
            None,
        )
        if album is None:
            self.send_error(HTTPStatus.NOT_FOUND, "unknown asmr album")
            return
        try:
            file_path = decode_asmr(album, preview, self.server.voice_source_root, self.server.cache_root)
        except (ValueError, FileNotFoundError) as error:
            self.send_error(HTTPStatus.NOT_FOUND, str(error))
            return
        except Exception as error:
            self.send_json({"error": type(error).__name__, "detail": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        self.serve_file(file_path, "audio/wav")

    def serve_voice(self, relative_url: str) -> None:
        parts = PurePosixPath(relative_url).parts
        if len(parts) != 2 or ".." in parts or not parts[1].lower().endswith(".wav"):
            self.send_error(HTTPStatus.BAD_REQUEST, "invalid voice path")
            return
        banks = [
            *self.server.voice_manifest.get("entries", {}).values(),
            *self.server.voice_manifest.get("variantEntries", {}).values(),
            *self.server.voice_manifest.get("auxiliaryEntries", {}).values(),
            *self.server.voice_manifest.get("chineseEntries", {}).values(),
            *self.server.voice_manifest.get("chineseVariantEntries", {}).values(),
            *self.server.voice_manifest.get("pictureEntries", {}).values(),
        ]
        bank = next((item for item in banks if item["id"] == parts[0]), None)
        if bank is None:
            self.send_error(HTTPStatus.NOT_FOUND, "unknown voice bank")
            return
        try:
            stream_index = int(PurePosixPath(parts[1]).stem)
            file_path = decode_stream(bank, stream_index, self.server.voice_source_root, self.server.cache_root)
        except (ValueError, FileNotFoundError) as error:
            self.send_error(HTTPStatus.NOT_FOUND, str(error))
            return
        except Exception as error:
            self.send_json({"error": type(error).__name__, "detail": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        self.serve_file(file_path, "audio/wav")

    def serve_thumbnail(self, relative_url: str) -> None:
        parts = PurePosixPath(relative_url).parts
        root = (self.server.cache_root / "thumbnails").resolve()
        if len(parts) != 1 or ".." in parts:
            self.send_error(HTTPStatus.BAD_REQUEST, "invalid thumbnail path")
            return
        file_path = (root / parts[0]).resolve()
        if file_path.parent != root or not file_path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND, "thumbnail not found")
            return
        body = file_path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        self.end_headers()
        self.wfile.write(body)

    def serve_archive_image(self, relative_url: str) -> None:
        """Serve a `textures_bigs_uis_multiimg_*` static gallery image.

        These bundles are not in the Spine catalog, so they cannot go through
        `serve_asset`; the Texture2D is extracted to `cache/archive/<name>.png` on first
        request and reused afterwards. The name is validated before it reaches the
        filesystem, which is what keeps traversal out.
        """
        parts = PurePosixPath(relative_url).parts
        if len(parts) != 1 or ".." in parts:
            self.send_error(HTTPStatus.BAD_REQUEST, "invalid archive image path")
            return
        stem = parts[0]
        if stem.endswith(".png"):
            stem = stem[: -len(".png")]
        try:
            file_path, _ = extract_archive_image(
                stem, self.server.source_root, self.server.cache_root
            )
        except FileNotFoundError:
            self.send_error(HTTPStatus.NOT_FOUND, "archive image not found")
            return
        except ValueError as error:
            self.send_error(HTTPStatus.BAD_REQUEST, str(error))
            return
        except Exception as error:  # noqa: BLE001 - report, never fabricate
            self.send_json(
                {"error": type(error).__name__, "detail": str(error)},
                HTTPStatus.INTERNAL_SERVER_ERROR,
            )
            return
        self.serve_file(file_path, "image/png")

    def log_message(self, format: str, *args: object) -> None:
        print(f"{self.client_address[0]} - {format % args}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve CrossCore Spine assets from a lazy local cache")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8798)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--census", type=Path, default=DEFAULT_CENSUS)
    parser.add_argument("--voice-source", type=Path, default=DEFAULT_VOICE_SOURCE)
    args = parser.parse_args()

    catalog_path = write_catalog(args.cache, args.census)
    catalog = load_catalog(args.census)
    server = AssetServer((args.host, args.port), Handler)
    server.source_root = args.source
    server.cache_root = args.cache
    server.runtime_paths = {key: str(value.resolve()) for key, value in {
        **PATHS, 'source': args.source, 'cache': args.cache, 'census': args.census,
        'voice_source': args.voice_source,
    }.items()}
    server.catalog_bytes = catalog_path.read_bytes()
    server.manifest_path = args.cache / "assets.generated.json"
    server.display_names = None
    server.display_names_lock = threading.Lock()
    server.package_by_folder = {item["folder"]: item["package"] for item in catalog}
    server.web_root = Path(__file__).parent / "dist"
    server.voice_source_root = args.voice_source
    voice_manifest_path = args.cache / "voices.generated.json"
    server.voice_manifest_bytes = voice_manifest_path.read_bytes() if voice_manifest_path.is_file() else b""
    server.voice_manifest = json.loads(server.voice_manifest_bytes) if server.voice_manifest_bytes else {}
    asmr_manifest_path = args.cache / "asmr.generated.json"
    server.asmr_manifest_bytes = asmr_manifest_path.read_bytes() if asmr_manifest_path.is_file() else b""
    server.asmr_manifest = json.loads(server.asmr_manifest_bytes) if server.asmr_manifest_bytes else {}
    thumbnail_manifest_path = args.cache / "thumbnails.generated.json"
    server.thumbnail_manifest_bytes = thumbnail_manifest_path.read_bytes() if thumbnail_manifest_path.is_file() else b""
    interaction_manifest_path = args.cache / "spine_action.generated.json"
    server.interaction_manifest_bytes = interaction_manifest_path.read_bytes() if interaction_manifest_path.is_file() else b""
    multi_interaction_path = args.cache / "multi_picture_action.generated.json"
    server.multi_interaction_path = multi_interaction_path
    server.audit_path = args.cache / "spine-audit.generated.json"
    server.audit_lock = threading.Lock()
    server.spine_layout_cache = {}
    server.spine_layout_lock = threading.Lock()
    print(f"CrossCore asset cache: http://{args.host}:{args.port}")
    print(f"Catalog entries: {len(catalog)}; cache: {args.cache}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
