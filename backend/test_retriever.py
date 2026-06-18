"""
Tests for the retriever — specifically the relevance gating and per-file cap,
which have some non-obvious edge cases around BM25's negative scores.

Run with:  pytest -q
"""

import indexer
import retriever


def _build(files):
    return indexer.build_index(files, {"owner": "test", "repo": "test"})


def test_common_term_query_with_negative_scores():
    """
    BM25Okapi produces negative scores when a term appears in most documents.
    The retriever must still return results in that case — gating on token
    overlap, not score sign. Regression test for the bug where a common-term
    query against a small repo returned zero results.
    """
    files = {
        "fileA.py": "\n\n\n".join(
            f"def auth_handler_{i}(token):\n"
            f"    # authenticate user token\n"
            f"    return verify_auth(token)\n"
            f"    pass"
            for i in range(6)
        ),
    }
    for name in ("fileB", "fileC", "fileD"):
        files[f"{name}.py"] = (
            f"def {name}_auth(user):\n"
            f"    # authenticate the user here\n"
            f"    return check_auth(user)\n"
            f"    pass"
        )

    index = _build(files)
    results = retriever.search(index, "authenticate user token", n=5)

    assert len(results) == 5, "should return n results even with negative scores"

    per_file = {}
    for c in results:
        per_file[c.path] = per_file.get(c.path, 0) + 1

    assert per_file["fileA.py"] <= 3, "per-file cap must hold"
    assert len(per_file) >= 2, "results should span multiple files, not just the big one"


def test_irrelevant_query_returns_nothing():
    files = {
        "payments.py": "def charge_card(amount):\n    return stripe.charge(amount)\n    pass",
    }
    index = _build(files)
    assert retriever.search(index, "kubernetes deployment yaml", n=5) == []


def test_targeted_query_ranks_right_file_first():
    files = {
        "payments.py": "def charge_card(amount):\n    # process a stripe payment\n    return stripe.charge(amount)\n    pass",
        "email.py": "def send_email(to):\n    # send an smtp email\n    return smtp.send(to)\n    pass",
    }
    index = _build(files)
    results = retriever.search(index, "stripe payment charge", n=3)
    assert results, "should find the payments file"
    assert results[0].path == "payments.py"


def test_empty_query_returns_nothing():
    index = _build({"a.py": "def f():\n    return 1\n    pass"})
    assert retriever.search(index, "", n=5) == []
    assert retriever.search(index, "!!! ??? ...", n=5) == []


def test_list_files_filters():
    files = {
        "src/a.py": "def a():\n    # does a thing\n    return 1\n    pass",
        "src/b.ts": "function b() {\n  // does b thing\n  return 1;\n}",
        "docs/c.md": "# Title\n\nSome documentation content here.\n\nMore text.",
    }
    index = _build(files)
    assert retriever.list_files(index, extension=".py") == ["src/a.py"]
    assert retriever.list_files(index, directory="src") == ["src/a.py", "src/b.ts"]


def test_directory_filter_does_not_match_sibling_prefix():
    """directory='src' must not match 'srcfoo/...' — regression test."""
    files = {
        "src/real.py": "def real():\n    # real\n    return 1\n    pass",
        "srcfoo/decoy.py": "def decoy():\n    # decoy\n    return 2\n    pass",
    }
    index = _build(files)
    result = retriever.list_files(index, directory="src")
    assert result == ["src/real.py"], f"leaked sibling dir: {result}"


def test_short_whole_files_are_searchable():
    """
    A short-but-real file (below MIN_CHUNK_LINES) should still produce a chunk
    and be searchable — regression test for short files vanishing from search.
    """
    files = {
        "index.ts": 'export * from "./api";\nexport * from "./models";',
        "config.py": "DEBUG = True",
    }
    index = _build(files)
    assert retriever.search(index, "barrel export api models", n=3), "barrel file unsearchable"
    assert retriever.search(index, "debug config", n=3), "config file unsearchable"


def test_empty_and_whitespace_files_produce_no_chunks():
    """Genuinely empty files shouldn't create chunks — but shouldn't crash."""
    # A repo of only-empty files has no indexable content and should raise
    try:
        _build({"empty.py": "", "blank.py": "   \n\n  "})
        raise AssertionError("expected ValueError for empty-only repo")
    except ValueError:
        pass
    # But one real file alongside empties is fine
    index = _build({"empty.py": "", "real.py": "def f():\n    # real\n    return 1\n    pass"})
    assert any(c.path == "real.py" for c in index.chunks)
    assert not any(c.path == "empty.py" for c in index.chunks)
