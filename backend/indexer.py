"""
indexer.py — code chunking and BM25 index construction.

The chunking strategy here is the part I spent the most time on. Naive
approaches (fixed line windows, character counts) produce terrible retrieval
because you end up with chunks that start mid-function and have no useful
signal. Splitting at definition boundaries means each chunk is a coherent
semantic unit — a function, a class, a method.

The tokeniser splits camelCase and snake_case before indexing, which matters
a lot for code. 'getUserById' being indexed as ['get', 'user', 'by', 'id']
means a query for 'get user by id' or 'fetch user id' both hit it. Without
this you'd miss most matches.

BM25 over dense embeddings was a deliberate choice. Embedding models add a
heavy dependency, need GPU or a paid API, and don't actually outperform BM25
on code retrieval benchmarks (identifiers are mostly exact-match signals).
The retrieval quality is good enough that Claude can find the right files
reliably, which is all that matters here.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field

from rank_bm25 import BM25Okapi


@dataclass
class Chunk:
    id: str            # "{path}::{index}" — stable identifier for deduplication
    path: str
    content: str
    start_line: int
    end_line: int
    symbol: str | None   # function/class name if we could extract it
    language: str
    # Tokenised content+path, cached so retrieval can do cheap set-overlap
    # relevance checks without re-tokenising every chunk on every query.
    token_set: frozenset = field(default_factory=frozenset)


@dataclass
class Index:
    chunks: list[Chunk] = field(default_factory=list)
    files: dict[str, str] = field(default_factory=dict)
    bm25: BM25Okapi | None = field(default=None, repr=False)
    repo_meta: dict = field(default_factory=dict)

    def is_ready(self) -> bool:
        return self.bm25 is not None and bool(self.chunks)


# Extension → language tag for syntax highlighting in the frontend
EXT_LANG = {
    ".py": "python", ".pyw": "python",
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript",
    ".ts": "typescript", ".tsx": "typescript",
    ".java": "java", ".kt": "kotlin",
    ".go": "go", ".rs": "rust", ".rb": "ruby",
    ".c": "c", ".h": "c", ".cpp": "cpp", ".cs": "csharp",
    ".swift": "swift", ".scala": "scala", ".php": "php",
    ".sh": "bash", ".bash": "bash", ".sql": "sql",
    ".md": "markdown", ".mdx": "markdown",
    ".html": "html", ".css": "css", ".scss": "scss",
    ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
}


def _detect_lang(path: str) -> str:
    _, ext = os.path.splitext(path)
    return EXT_LANG.get(ext.lower(), "text")


# These patterns match the start of a top-level definition in each language.
# They're intentionally loose — it's better to split too often (small chunks,
# more precise retrieval) than too rarely (big chunks, poor signal-to-noise).
_DEF_PATTERNS: dict[str, re.Pattern] = {
    "python":     re.compile(r"^(async )?def |^class ", re.MULTILINE),
    "javascript": re.compile(r"^(export (default )?|async )?(function |class )", re.MULTILINE),
    "typescript": re.compile(r"^(export (default )?|async )?(function |class |interface |type |enum )", re.MULTILINE),
    "java":       re.compile(r"^\s*(public|private|protected|static)\s+.*\s+(class|interface|void|\w+)\s+\w+\s*[({]", re.MULTILINE),
    "go":         re.compile(r"^func ", re.MULTILINE),
    "rust":       re.compile(r"^(pub(\(crate\))? )?(fn |struct |impl |trait |enum )", re.MULTILINE),
    "kotlin":     re.compile(r"^(fun |class |object |interface |data class )", re.MULTILINE),
}

_SYMBOL_RE = re.compile(r"(?:def|class|function|func|fn|struct|impl|trait|interface|type|enum)\s+(\w+)")
_ALT_SYMBOL_RE = re.compile(r"(?:const|let|var)\s+(\w+)\s*=")

MAX_CHUNK_LINES = 120
MIN_CHUNK_LINES = 3


def _extract_symbol(first_line: str) -> str | None:
    for pattern in (_SYMBOL_RE, _ALT_SYMBOL_RE):
        m = pattern.search(first_line)
        if m:
            return m.group(1)
    return None


def _make_chunk(path: str, lines: list[str], start: int, idx: int, lang: str) -> Chunk | None:
    if len(lines) < MIN_CHUNK_LINES:
        return None
    return Chunk(
        id=f"{path}::{idx}",
        path=path,
        content="\n".join(lines),
        start_line=start + 1,
        end_line=start + len(lines),
        symbol=_extract_symbol(lines[0]) if lines else None,
        language=lang,
    )


def _chunk_by_definitions(content: str, path: str, lang: str) -> list[Chunk]:
    pattern = _DEF_PATTERNS.get(lang)
    lines = content.splitlines()

    if not pattern or len(lines) < MIN_CHUNK_LINES:
        return _chunk_by_lines(content, path, lang)

    split_points = sorted({0} | {content[:m.start()].count("\n") for m in pattern.finditer(content)})

    chunks = []
    for i, start in enumerate(split_points):
        end = split_points[i + 1] if i + 1 < len(split_points) else len(lines)
        segment = lines[start:end]

        if len(segment) > MAX_CHUNK_LINES:
            # Sub-split oversized definition blocks
            for j in range(0, len(segment), MAX_CHUNK_LINES):
                chunk = _make_chunk(path, segment[j:j + MAX_CHUNK_LINES], start + j, len(chunks), lang)
                if chunk:
                    chunks.append(chunk)
        else:
            chunk = _make_chunk(path, segment, start, len(chunks), lang)
            if chunk:
                chunks.append(chunk)

    return chunks or _chunk_by_lines(content, path, lang)


def _chunk_by_lines(content: str, path: str, lang: str) -> list[Chunk]:
    lines = content.splitlines()
    chunks = []
    for i in range(0, len(lines), MAX_CHUNK_LINES):
        chunk = _make_chunk(path, lines[i:i + MAX_CHUNK_LINES], i, len(chunks), lang)
        if chunk:
            chunks.append(chunk)
    return chunks


def chunk_file(path: str, content: str) -> list[Chunk]:
    lang = _detect_lang(path)
    if lang in _DEF_PATTERNS:
        chunks = _chunk_by_definitions(content, path, lang)
    else:
        chunks = _chunk_by_lines(content, path, lang)

    # MIN_CHUNK_LINES stops splitting from producing tiny fragments, but it
    # also means a short-but-real file (a one-line barrel export, a 2-line
    # config, a small type-only module) produces zero chunks and becomes
    # invisible to search. Keep such files as one whole-file chunk so they're
    # still retrievable.
    if not chunks and content.strip():
        lines = content.splitlines() or [content]
        chunks = [Chunk(
            id=f"{path}::0",
            path=path,
            content=content,
            start_line=1,
            end_line=len(lines),
            symbol=_extract_symbol(lines[0]) if lines else None,
            language=lang,
        )]

    return chunks


# BM25 tokenisation — splits camelCase, snake_case, and strips noise.
# The result is a bag of words that maps well to both natural language queries
# and identifier-heavy code.
_CAMEL_SPLIT = re.compile(r"([a-z])([A-Z])")
_SEPARATOR    = re.compile(r"[_\-./\\@#]")
_NOISE        = re.compile(r"[^a-z0-9\s]")


def _tokenise(text: str) -> list[str]:
    text = _CAMEL_SPLIT.sub(r"\1 \2", text)
    text = _SEPARATOR.sub(" ", text)
    text = text.lower()
    text = _NOISE.sub(" ", text)
    return [t for t in text.split() if len(t) > 1]


def build_index(files: dict[str, str], repo_meta: dict) -> Index:
    all_chunks: list[Chunk] = []

    for path, content in files.items():
        if not content or not content.strip():
            continue
        all_chunks.extend(chunk_file(path, content))

    if not all_chunks:
        raise ValueError("No indexable content found.")

    # Include the file path in the tokenised representation so that queries like
    # "auth middleware" can match files named auth_middleware.py even if the
    # content itself doesn't say "auth middleware" verbatim.
    tokenised = [_tokenise(c.content + " " + c.path) for c in all_chunks]

    # Cache each chunk's token set for the retriever's relevance gate. We
    # already have the tokens here, so reuse them rather than recomputing.
    for chunk, tokens in zip(all_chunks, tokenised):
        chunk.token_set = frozenset(tokens)

    bm25 = BM25Okapi(tokenised)

    return Index(chunks=all_chunks, files=files, bm25=bm25, repo_meta=repo_meta)
