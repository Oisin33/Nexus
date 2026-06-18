"""
github_fetcher.py
Fetches a GitHub repository's file tree and raw file contents via the
public REST API. No cloning required — just the Contents API.

The file fetching is concurrent (up to FETCH_CONCURRENCY at a time) to
keep indexing fast. Unauthenticated, GitHub limits you to 60 req/hr which
is not enough for large repos. Set GITHUB_TOKEN and you get 5000/hr.

One gotcha: the recursive tree API returns a truncated flag for repos with
more than ~100k objects. In practice this only affects massive monorepos;
typical open-source projects are fine.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
import re

import httpx

_log = logging.getLogger(__name__)

GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "").strip()

_HEADERS = {
    "Accept": "application/vnd.github.v3+json",
    "X-GitHub-Api-Version": "2022-11-28",
    **({"Authorization": f"Bearer {GITHUB_TOKEN}"} if GITHUB_TOKEN else {}),
}


def reload_token() -> None:
    """Re-read GITHUB_TOKEN from the environment and rebuild request headers,
    so a token set via the Settings UI takes effect without a restart."""
    global GITHUB_TOKEN, _HEADERS
    GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "").strip()
    _HEADERS = {
        "Accept": "application/vnd.github.v3+json",
        "X-GitHub-Api-Version": "2022-11-28",
        **({"Authorization": f"Bearer {GITHUB_TOKEN}"} if GITHUB_TOKEN else {}),
    }

# How many file-content requests to fire at once.
# 10 is conservative but safe for both authenticated and unauthenticated use.
FETCH_CONCURRENCY = 2

INDEXABLE_EXTENSIONS = {
    ".py", ".js", ".ts", ".tsx", ".jsx", ".java", ".kt",
    ".c", ".cpp", ".h", ".cs", ".go", ".rs", ".rb",
    ".php", ".swift", ".scala", ".r", ".sh", ".bash",
    ".md", ".mdx", ".txt", ".yaml", ".yml", ".json",
    ".toml", ".ini", ".sql", ".html", ".css", ".scss",
}

SKIP_DIRS = {
    "node_modules", ".git", "dist", "build", "__pycache__",
    ".next", ".nuxt", "venv", ".venv", "vendor",
    "coverage", ".pytest_cache", ".mypy_cache",
}

MAX_FILE_BYTES = 80_000


def parse_repo_url(url: str) -> tuple[str, str, str | None]:
    """
    Parse a GitHub URL into (owner, repo, branch).
    Handles:
      https://github.com/owner/repo
      https://github.com/owner/repo/tree/main
      owner/repo
    """
    url = url.strip().rstrip("/")
    m = re.match(
        r"(?:https?://github\.com/)?([^/]+)/([^/]+?)(?:\.git)?(?:/tree/(.+))?$",
        url,
    )
    if not m:
        raise ValueError(f"Can't parse as a GitHub URL: {url!r}")
    return m.group(1), m.group(2), m.group(3)


async def _get_default_branch(owner: str, repo: str) -> str:
    async with httpx.AsyncClient(headers=_HEADERS, timeout=15) as client:
        resp = await client.get(f"https://api.github.com/repos/{owner}/{repo}")
        if resp.status_code == 404:
            raise ValueError(f"Repository not found: {owner}/{repo}")
        resp.raise_for_status()
        return resp.json().get("default_branch", "main")


async def _get_tree(owner: str, repo: str, branch: str) -> list[dict]:
    """Fetch the flat recursive tree and filter to indexable blobs."""
    url = f"https://api.github.com/repos/{owner}/{repo}/git/trees/{branch}?recursive=1"
    async with httpx.AsyncClient(headers=_HEADERS, timeout=30) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        data = resp.json()

    if data.get("truncated"):
        # Log it but continue — we'll get most of the repo
        import logging
        logging.getLogger(__name__).warning(
            "Tree response was truncated for %s/%s — large repo, some files may be missing",
            owner, repo,
        )

    blobs = []
    for item in data.get("tree", []):
        if item.get("type") != "blob":
            continue
        path: str = item["path"]
        parts = path.split("/")
        if any(p in SKIP_DIRS for p in parts[:-1]):
            continue
        _, ext = os.path.splitext(path)
        if ext.lower() not in INDEXABLE_EXTENSIONS:
            continue
        if item.get("size", 0) > MAX_FILE_BYTES:
            continue
        blobs.append({"path": path, "size": item.get("size", 0)})

    return blobs


async def _fetch_one(
    client: httpx.AsyncClient,
    semaphore: asyncio.Semaphore,
    owner: str,
    repo: str,
    path: str,
    branch: str,
) -> tuple[str, str | None]:
    """Fetch a single file's content. Returns (path, content | None)."""
    async with semaphore:
        url = f"https://api.github.com/repos/{owner}/{repo}/contents/{path}?ref={branch}"
        try:
            resp = await client.get(url)
            if resp.status_code == 403:
                # Almost always a rate limit. Worth surfacing because it means
                # the index will be silently incomplete.
                _log.warning("Rate limited fetching %s — slow down requests or check GITHUB_TOKEN", path)
                return path, None
            if resp.status_code != 200:
                _log.warning("Skipped %s (HTTP %d)", path, resp.status_code)
                return path, None
            data = resp.json()
            if data.get("encoding") == "base64":
                content = base64.b64decode(data["content"]).decode("utf-8", errors="replace")
                return path, content
        except Exception as e:
            _log.warning("Failed to fetch %s: %s", path, e)
        return path, None


async def fetch_repo(repo_url: str) -> dict:
    """
    Fetch all indexable files from a GitHub repo concurrently.

    Returns:
      { "owner": str, "repo": str, "branch": str, "files": { path: content } }
    """
    owner, repo, branch = parse_repo_url(repo_url)

    if not branch:
        branch = await _get_default_branch(owner, repo)

    blobs = await _get_tree(owner, repo, branch)

    semaphore = asyncio.Semaphore(FETCH_CONCURRENCY)
    async with httpx.AsyncClient(headers=_HEADERS, timeout=20) as client:
        tasks = [
            _fetch_one(client, semaphore, owner, repo, blob["path"], branch)
            for blob in blobs
        ]
        results = await asyncio.gather(*tasks)

    files = {path: content for path, content in results if content is not None}

    dropped = len(blobs) - len(files)
    if dropped:
        _log.warning(
            "Indexed %d/%d files for %s/%s — %d could not be fetched (see warnings above)",
            len(files), len(blobs), owner, repo, dropped,
        )

    return {"owner": owner, "repo": repo, "branch": branch, "files": files}
