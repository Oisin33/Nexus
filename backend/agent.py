"""
agent.py — the core of Nexus.

Runs a tool-calling loop against the Anthropic streaming API, dispatching
four tools against the in-memory BM25 index. Events are emitted as
newline-delimited JSON for SSE — the frontend parses them and renders
tool activity and text deltas as they arrive.

One thing that took a while to figure out: the streaming API and tool use
interact in a slightly awkward way. When stop_reason is "tool_use", the
stream ends without yielding all the text (because there might not be any).
get_final_message() reassembles the full message from the stream events,
so we use that for tool dispatch rather than tracking blocks manually.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from collections.abc import Generator

from dotenv import load_dotenv
import anthropic

import retriever
from indexer import Index


_ENV_PATH = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(_ENV_PATH, override=True)

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "").strip()

_client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

def _choose_model() -> str:
    # Manual override still wins if you set ANTHROPIC_MODEL in .env
    configured = os.getenv("ANTHROPIC_MODEL", "").strip()
    if configured:
        return configured

    try:
        models = _client.models.list()
        ids = [m.id for m in models.data]

        # Prefer cheapest suitable model first
        preferred = [
            "claude-haiku-4-5-20251001",
            "claude-sonnet-4-6",
            "claude-sonnet-4-5-20250929",
            "claude-fable-5",
            "claude-opus-4-8",
        ]

        for model in preferred:
            if model in ids:
                return model

        # Fallback: any Haiku model
        for model in ids:
            if "haiku" in model.lower():
                return model

        # Fallback: any Sonnet model
        for model in ids:
            if "sonnet" in model.lower():
                return model

        # Last fallback: first available model
        if ids:
            return ids[0]

    except Exception as e:
        print("Could not auto-detect Anthropic model:", e)

    return "claude-haiku-4-5-20251001"


MODEL = _choose_model()
print("Using Anthropic model:", MODEL)


def reload_credentials() -> str:
    """
    Re-read the Anthropic key from .env (after the user updates it in Settings),
    rebuild the client, and re-resolve the model. Lets a new key take effect
    without restarting the server.
    """
    global _client, MODEL, ANTHROPIC_API_KEY
    load_dotenv(_ENV_PATH, override=True)
    ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "").strip()
    _client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    MODEL = _choose_model()
    print("Reloaded credentials; using model:", MODEL)
    return MODEL


def validate_key() -> bool:
    """Best-effort check that the current key actually works."""
    try:
        _client.models.list()
        return True
    except Exception:
        return False

MAX_TOKENS = 4096
MAX_TOOL_ROUNDS = 4  # sanity cap so we don't loop forever on weird queries


TOOLS: list[dict] = [
    {
        "name": "search_codebase",
        "description": (
            "Full-text search over the indexed repository using BM25. Returns the most relevant "
            "code chunks with file paths and line numbers. Always start here — reading random files "
            "without searching first is slow and usually wrong."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Plain-language or keyword query. camelCase and snake_case are both split before indexing, so searching 'user auth' will hit 'userAuth', 'user_auth', etc.",
                },
                "n_results": {
                    "type": "integer",
                    "description": "How many chunks to return. Default 5. Go higher (7-8) for broad structural questions, lower for targeted lookups.",
                    "default": 5,
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "read_file",
        "description": (
            "Read the full contents of a specific file. Use this when search results show you the "
            "right file but you need more context than the chunk provides — entry points, config files, "
            "or anything where you need to see the whole picture. Files over 12k chars are truncated."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Exact file path relative to repo root, e.g. 'src/api/auth.py'",
                },
            },
            "required": ["path"],
        },
    },
    {
        "name": "list_files",
        "description": (
            "List all indexed files, optionally filtered by directory prefix or extension. "
            "Good for understanding project structure or finding all files of a specific type. "
            "Pair with read_file for config/entrypoint discovery."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "directory": {
                    "type": "string",
                    "description": "Only return files under this path (e.g. 'src/models'). Optional.",
                },
                "extension": {
                    "type": "string",
                    "description": "Filter by file extension, e.g. '.py' or 'ts'. Optional.",
                },
            },
        },
    },
    {
        "name": "generate_docs",
        "description": (
            "Generate structured markdown documentation for a specific file. Covers purpose, "
            "public API (functions/classes/exports), parameters, return types, and a usage example. "
            "Runs a separate focused Claude call so the docs don't eat your context window."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path to document"},
            },
            "required": ["path"],
        },
    },
]


def _execute_tool(name: str, inputs: dict, index: Index, sources: list[dict]) -> str:
    """
    Run a tool and return its result as a string for the model.

    Also appends to `sources` (the citation panel) as a side effect — the tool
    that does the work is the right place to record what it touched, and it
    means we don't re-run the search just to figure out the sources.
    """
    if name == "search_codebase":
        n = min(inputs.get("n_results", 5), 8)
        chunks = retriever.search(index, inputs["query"], n=n)
        if not chunks:
            return "Nothing matched — try broader terms or check list_files to confirm the file exists."
        parts = []
        for c in chunks:
            symbol = f" · {c.symbol}" if c.symbol else ""
            parts.append(
                f"### {c.path}{symbol}  (lines {c.start_line}–{c.end_line})\n"
                f"```{c.language}\n{c.content[:2000]}\n```"
            )
            entry = {"path": c.path, "lines": f"{c.start_line}–{c.end_line}", "symbol": c.symbol}
            if entry not in sources:
                sources.append(entry)
        return "\n\n".join(parts)

    elif name == "read_file":
        content = retriever.get_file(index, inputs["path"])
        if content is None:
            # Give a helpful hint rather than a bare error
            close = [p for p in index.files if inputs["path"] in p or p in inputs["path"]]
            hint = f"\nDid you mean one of: {close[:3]}" if close else ""
            return f"File not found: {inputs['path']}{hint}"
        _record_file_source(inputs["path"], sources)
        if len(content) > 12_000:
            content = content[:12_000] + "\n\n[...truncated — use search_codebase for specific sections]"
        return f"```\n{content}\n```"

    elif name == "list_files":
        files = retriever.list_files(
            index,
            directory=inputs.get("directory"),
            extension=inputs.get("extension"),
        )
        if not files:
            return "No files matched those filters."
        # Trim to a sane length; 200 paths is plenty for structural overview
        result = "\n".join(files[:200])
        if len(files) > 200:
            result += f"\n... and {len(files) - 200} more"
        return result

    elif name == "generate_docs":
        content = retriever.get_file(index, inputs["path"])
        if content is None:
            return f"File not found: {inputs['path']}"
        _record_file_source(inputs["path"], sources)
        resp = _client.messages.create(
            model=MODEL,
            max_tokens=2048,
            system=(
                "You write technical documentation for software engineers. "
                "Be precise and concise. Use markdown. Cover: what this file does, "
                "its public interface (functions/classes/exports with signatures), "
                "and a minimal usage example if the file exports something callable. "
                "Skip obvious things. Don't pad."
            ),
            messages=[{"role": "user", "content": f"Document {inputs['path']}:\n\n```\n{content[:8000]}\n```"}],
        )
        # A no-tools completion always leads with a text block
        return resp.content[0].text

    return f"Unknown tool: {name}"


def _record_file_source(path: str, sources: list[dict]) -> None:
    if not path:
        return
    entry = {"path": path, "lines": "full", "symbol": None}
    if entry not in sources:
        sources.append(entry)


def _system_prompt(index: Index) -> str:
    meta = index.repo_meta
    return (
        f"You are a senior engineer who has just finished reading every file in the "
        f"{meta.get('owner', '?')}/{meta.get('repo', '?')} repository "
        f"({len(index.files)} files, {len(index.chunks)} indexed chunks). "
        f"You have four tools to look things up — use them. Don't guess at file paths or "
        f"function signatures; check first.\n\n"
        f"When answering:\n"
        f"- Search before claiming anything about the code\n"
        f"- Cite specific files and line numbers, not vague references\n"
        f"- For 'how does X work' questions, trace the actual call chain\n"
        f"- For impact questions, search for usages before saying what breaks\n"
        f"- Be direct. The person asking is a developer, not a PM.\n"
        f"- Use fenced code blocks with the correct language tag"
    )


def run_agent(
    user_message: str,
    history: list,
    index: Index,
) -> Generator[str, None, None]:
    """
    Drives the tool-use loop and yields SSE events.

    Event shapes the frontend expects:
      {"type": "tool_start",  "tool": str,  "input": dict}
      {"type": "tool_result", "tool": str,  "content": str}
      {"type": "text",        "delta": str}
      {"type": "done",        "sources": list[dict]}
    """

    def emit(obj: dict) -> str:
        return f"data: {json.dumps(obj)}\n\n"

    messages = [*history, {"role": "user", "content": user_message}]
    sources_used: list[dict] = []

    for _round in range(MAX_TOOL_ROUNDS):
        # Stream the response — text deltas arrive in real time from the API.
        # Tool use blocks don't stream their content in a useful way, so we
        # use get_final_message() to get the assembled tool calls after streaming.
        with _client.messages.stream(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            system=_system_prompt(index),
            tools=TOOLS,
            messages=messages,
        ) as stream:
            for text_delta in stream.text_stream:
                yield emit({"type": "text", "delta": text_delta})
            final = stream.get_final_message()

        if final.stop_reason != "tool_use":
            break

        # Execute whatever tools were requested
        tool_results = []
        for block in final.content:
            if block.type != "tool_use":
                continue

            yield emit({"type": "tool_start", "tool": block.name, "input": block.input})
            result = _execute_tool(block.name, block.input, index, sources_used)
            yield emit({"type": "tool_result", "tool": block.name, "content": result[:600]})

            tool_results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": result,
            })

        messages.append({"role": "assistant", "content": final.content})
        messages.append({"role": "user", "content": tool_results})

        messages.append({
            "role": "user",
            "content": (
                "Stop using tools now. Based only on the tool results already gathered, "
                "give the final answer clearly and concisely. Include file/line citations where relevant."
            ),
        })

        resp = _client.messages.create(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            system=_system_prompt(index),
            messages=messages,
        )

        for block in resp.content:
            if block.type == "text":
                yield emit({"type": "text", "delta": block.text})

    yield emit({"type": "done", "sources": sources_used})
