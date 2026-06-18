"""
retriever.py
BM25 retrieval over an Index.
"""

from __future__ import annotations

import numpy as np

from indexer import Chunk, Index, _tokenise

MAX_RESULTS = 8


def search(index: Index, query: str, n: int = MAX_RESULTS) -> list[Chunk]:
    """Return the top-n most relevant chunks for a query."""
    if not index.is_ready():
        return []

    query_tokens = _tokenise(query)
    if not query_tokens:
        return []

    scores = index.bm25.get_scores(query_tokens)

    # Rank by score (descending). Note: BM25Okapi scores can be NEGATIVE when a
    # query term appears in a large fraction of documents — the IDF component
    # goes negative. The ranking is still correct (less negative = more
    # relevant), but it means we can't use "score > 0" as a relevance cutoff:
    # for a common term in a small repo, *every* score is negative and that
    # cutoff would return nothing. Instead we gate on actual token overlap.
    ranked = np.argsort(scores)[::-1]
    query_set = set(query_tokens)

    results: list[Chunk] = []
    seen_paths: dict[str, int] = {}

    for idx in ranked:
        chunk = index.chunks[idx]

        # Relevance gate: the chunk must share at least one token with the
        # query. This is the real signal — independent of score sign.
        if query_set.isdisjoint(chunk.token_set):
            continue

        # Cap at 3 chunks per file so one file can't dominate. Applied while
        # walking the full ranking (not after slicing to n), so other files
        # can fill the slots a capped file would otherwise have hogged.
        if seen_paths.get(chunk.path, 0) >= 3:
            continue

        seen_paths[chunk.path] = seen_paths.get(chunk.path, 0) + 1
        results.append(chunk)

        if len(results) >= n:
            break

    return results


def get_file(index: Index, path: str) -> str | None:
    """Return full content of a file by path."""
    return index.files.get(path)


def list_files(index: Index, directory: str | None = None, extension: str | None = None) -> list[str]:
    """List all indexed file paths, with optional filters."""
    paths = list(index.files.keys())

    if directory:
        directory = directory.strip("/")
        # Match files under "directory/" — plus an exact match in case the
        # caller passed a full file path. The naive `startswith(directory)`
        # without the slash would wrongly match e.g. "src" against "srcfoo/x.py".
        paths = [
            p for p in paths
            if p.startswith(directory + "/") or p == directory
        ]

    if extension:
        ext = extension if extension.startswith(".") else "." + extension
        paths = [p for p in paths if p.endswith(ext)]

    return sorted(paths)
