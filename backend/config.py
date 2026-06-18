"""
config.py: read and write the local .env so API keys can be set from the UI.

This exists so you can paste your keys into the app instead of editing a file
by hand. It is for LOCAL use only: the /api/settings endpoints that call it are
restricted to localhost / private networks, and .env is gitignored. Do not
expose this server on the public internet.
"""

import os
from pathlib import Path

ENV_PATH = Path(__file__).resolve().parent.parent / ".env"

# Only these keys are ever read or written by the settings UI.
MANAGED = ("ANTHROPIC_API_KEY", "GITHUB_TOKEN", "ANTHROPIC_MODEL")


def mask(value: str) -> str:
    """Show enough of a secret to recognise it, never the whole thing."""
    v = (value or "").strip()
    if not v:
        return ""
    if len(v) <= 10:
        return v[0] + "\u2022" * (len(v) - 1)
    return f"{v[:6]}\u2026{v[-4:]}"


def get_status() -> dict:
    """What's currently set (masked), for the UI to display."""
    a = os.getenv("ANTHROPIC_API_KEY", "").strip()
    g = os.getenv("GITHUB_TOKEN", "").strip()
    m = os.getenv("ANTHROPIC_MODEL", "").strip()
    return {
        "anthropic_api_key_set": bool(a),
        "anthropic_api_key_masked": mask(a),
        "github_token_set": bool(g),
        "github_token_masked": mask(g),
        "anthropic_model": m,
    }


def save_keys(updates: dict) -> None:
    """
    Upsert KEY=value pairs into .env, preserving every other line and comment,
    and apply them to the running process immediately. Only non-empty values
    are written; a blank value means "leave this one unchanged".
    """
    clean = {
        k: v.strip()
        for k, v in updates.items()
        if k in MANAGED and isinstance(v, str) and v.strip()
    }
    if not clean:
        return

    lines = ENV_PATH.read_text(encoding="utf-8").splitlines() if ENV_PATH.exists() else []

    # Map existing assignable keys to their line numbers.
    where = {}
    for i, line in enumerate(lines):
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        where[s.split("=", 1)[0].strip()] = i

    for key, val in clean.items():
        entry = f"{key}={val}"
        if key in where:
            lines[where[key]] = entry
        else:
            lines.append(entry)
        os.environ[key] = val  # take effect without a restart

    ENV_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")
