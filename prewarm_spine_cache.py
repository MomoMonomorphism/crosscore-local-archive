"""Parallel, resumable cache prewarmer for the S13 browser audit.

Each package owns a distinct output directory, so workers never write the same
target.  ``extract_package`` validates source identity and returns immediately for
an already complete cache entry.  The original game tree is only read.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import time
from pathlib import Path

from asset_cache import DEFAULT_CACHE, DEFAULT_CENSUS, DEFAULT_SOURCE, extract_package, load_catalog


def main() -> None:
    parser = argparse.ArgumentParser(description="Prewarm browser-ready Spine packages")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--census", type=Path, default=DEFAULT_CENSUS)
    args = parser.parse_args()
    if not 1 <= args.workers <= 8:
        raise ValueError("workers must be between 1 and 8")

    packages = [item["package"] for item in load_catalog(args.census)]
    started = time.perf_counter()
    failures: list[tuple[str, str]] = []

    def extract(package: str) -> tuple[str, bool]:
        result = extract_package(package, args.source, args.cache)
        return package, bool(result.get("cacheHit"))

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(extract, package): package for package in packages}
        for index, future in enumerate(concurrent.futures.as_completed(futures), 1):
            package = futures[future]
            try:
                _, cache_hit = future.result()
                state = "cached" if cache_hit else "extracted"
            except Exception as error:  # keep the complete failure inventory
                state = "failed"
                failures.append((package, f"{type(error).__name__}: {error}"))
            if index % 20 == 0 or index == len(packages) or state == "failed":
                elapsed = time.perf_counter() - started
                print(f"{index}/{len(packages)} {state} · {elapsed:.1f}s", flush=True)

    if failures:
        for package, detail in failures:
            print(f"FAILED {package}: {detail}")
        raise SystemExit(f"{len(failures)} package(s) failed")
    print(f"all {len(packages)} packages ready in {time.perf_counter() - started:.1f}s")


if __name__ == "__main__":
    main()
