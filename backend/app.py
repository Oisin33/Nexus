"""
app.py — FastAPI application for Nexus.

Deliberately kept thin. All the interesting stuff is in agent.py,
indexer.py, and retriever.py. This file just wires them together
and handles HTTP concerns (CORS, validation, SSE headers).

Note: the index lives in process memory which means a restart clears it.
That's fine for local use. If you're deploying this properly, you'd want
to serialize the BM25 index to disk and restore it on startup — but that's
a future problem.
"""

import logging
import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

# Load .env for local dev — no-op if the file doesn't exist or vars are
# already set (e.g. via docker-compose environment: block). This must run
# before importing the modules below, because agent.py reads ANTHROPIC_API_KEY
# at import time. Hence the noqa: E402 — the ordering is deliberate.
load_dotenv()

import agent as agent_mod  # noqa: E402
import config  # noqa: E402
import github_fetcher  # noqa: E402
import indexer as idx_mod  # noqa: E402
import retriever as ret_mod  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)s  %(message)s")
log = logging.getLogger(__name__)

_index: idx_mod.Index | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not os.environ.get("ANTHROPIC_API_KEY"):
        log.warning("ANTHROPIC_API_KEY not set — /api/chat will fail")
    yield


app = FastAPI(title="Nexus", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class IndexRequest(BaseModel):
    repo_url: str


class ChatRequest(BaseModel):
    message: str
    history: list = []


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "index_ready": _index is not None and _index.is_ready(),
        "anthropic_key_set": bool(os.environ.get("ANTHROPIC_API_KEY")),
    }


@app.post("/api/index", status_code=201)
async def index_repo(req: IndexRequest):
    global _index

    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise HTTPException(500, "Set ANTHROPIC_API_KEY before indexing")

    log.info("Indexing: %s", req.repo_url)

    try:
        repo_data = await github_fetcher.fetch_repo(req.repo_url)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        log.exception("Repo fetch failed")
        raise HTTPException(502, f"Could not fetch repository: {e}")

    if not repo_data["files"]:
        raise HTTPException(
            422,
            "No indexable source files found. This repo might be empty, "
            "binary-only, or all files exceeded the size limit."
        )

    try:
        _index = idx_mod.build_index(repo_data["files"], {
            "owner": repo_data["owner"],
            "repo": repo_data["repo"],
            "branch": repo_data["branch"],
            "url": req.repo_url,
        })
    except Exception as e:
        log.exception("Index build failed")
        raise HTTPException(500, f"Failed to build index: {e}")

    log.info("Ready: %d files, %d chunks", len(_index.files), len(_index.chunks))

    return {
        "status": "ready",
        "owner": repo_data["owner"],
        "repo": repo_data["repo"],
        "branch": repo_data["branch"],
        "file_count": len(_index.files),
        "chunk_count": len(_index.chunks),
    }


@app.get("/api/status")
def status():
    if _index is None or not _index.is_ready():
        return {"status": "empty"}
    return {"status": "ready", "file_count": len(_index.files), "chunk_count": len(_index.chunks), **_index.repo_meta}


@app.get("/api/files")
def list_files(directory: str | None = None, extension: str | None = None):
    if _index is None:
        raise HTTPException(400, "No repository indexed")
    return {"files": ret_mod.list_files(_index, directory=directory, extension=extension)}


@app.get("/api/file")
def get_file(path: str = Query(...)):
    """Return the full content of a specific indexed file."""
    if _index is None:
        raise HTTPException(400, "No repository indexed")
    content = ret_mod.get_file(_index, path)
    if content is None:
        raise HTTPException(404, f"File not in index: {path}")
    return {"path": path, "content": content, "lines": len(content.splitlines())}


@app.post("/api/chat")
def chat(req: ChatRequest):
    if _index is None or not _index.is_ready():
        raise HTTPException(400, "Index a repository first — POST to /api/index")

    def generate():
        yield from agent_mod.run_agent(req.message, req.history, _index)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Settings (local key management) ───────────────────────────────────────────
# These let you set your API keys from the UI instead of editing .env by hand.
# Restricted to localhost / private networks because they touch secrets on disk.

import ipaddress  # noqa: E402


def _is_local(request: Request) -> bool:
    host = request.client.host if request.client else ""
    try:
        ip = ipaddress.ip_address(host)
        return ip.is_loopback or ip.is_private
    except ValueError:
        return host in ("localhost", "")


class SettingsRequest(BaseModel):
    anthropic_api_key: str | None = None
    github_token: str | None = None
    anthropic_model: str | None = None


@app.get("/api/settings")
def get_settings(request: Request):
    if not _is_local(request):
        raise HTTPException(403, "Settings are only available on localhost.")
    return config.get_status()


@app.post("/api/settings")
def update_settings(body: SettingsRequest, request: Request):
    if not _is_local(request):
        raise HTTPException(403, "Settings are only available on localhost.")

    config.save_keys({
        "ANTHROPIC_API_KEY": body.anthropic_api_key,
        "GITHUB_TOKEN": body.github_token,
        "ANTHROPIC_MODEL": body.anthropic_model,
    })

    # Apply to the running process so the change takes effect without a restart.
    try:
        agent_mod.reload_credentials()
    except Exception as e:
        log.warning("reload_credentials failed: %s", e)
    try:
        github_fetcher.reload_token()
    except Exception as e:
        log.warning("reload_token failed: %s", e)

    status = config.get_status()
    # Best-effort: confirm the Anthropic key actually works, if one was just set.
    status["anthropic_valid"] = (
        agent_mod.validate_key() if body.anthropic_api_key else None
    )
    return status


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)