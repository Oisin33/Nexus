"""
Tests for the agent tool-use loop.

The Anthropic client is mocked so these run in CI without an API key — what
we're testing is our own orchestration (tool dispatch, SSE event shape, source
tracking, the round cap), not the model. Each fake "turn" returns either a
tool_use request or a final answer, and we assert the loop drives them
correctly.
"""

import json
import types

import agent
import indexer

REPO = {
    "src/auth.py": (
        "def authenticate(token):\n"
        "    # verify the bearer token against the session store\n"
        "    session = lookup_session(token)\n"
        "    return session.user\n"
    ),
    "src/routes.py": (
        "def handle_login(request):\n"
        "    # entry point for login\n"
        "    return authenticate(request.token)\n"
    ),
}


def _index():
    return indexer.build_index(REPO, {"owner": "demo", "repo": "demo", "branch": "main"})


# ---- Minimal fakes mimicking the Anthropic streaming client ----

class _Block:
    def __init__(self, **kw):
        self.__dict__.update(kw)


class _Final:
    def __init__(self, content, stop_reason):
        self.content = content
        self.stop_reason = stop_reason


class _Stream:
    def __init__(self, text_chunks, final):
        self._chunks = text_chunks
        self._final = final

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    @property
    def text_stream(self):
        yield from self._chunks

    def get_final_message(self):
        return self._final


def _install_client(stream_fn, create_fn=None):
    msgs = types.SimpleNamespace(
        stream=stream_fn,
        create=create_fn or (lambda **kw: types.SimpleNamespace(
            content=[_Block(type="text", text="docs")]
        )),
    )
    agent._client = types.SimpleNamespace(messages=msgs)


def _collect(message, idx):
    events = []
    for raw in agent.run_agent(message, [], idx):
        assert raw.startswith("data: ") and raw.endswith("\n\n"), f"bad SSE framing: {raw!r}"
        events.append(json.loads(raw[6:]))
    return events


def test_single_tool_then_answer():
    """One search call, then a final answer. Sources should come from the search."""
    calls = {"n": 0}

    def stream(**kw):
        calls["n"] += 1
        if calls["n"] == 1:
            tool = _Block(type="tool_use", name="search_codebase",
                          input={"query": "authenticate token"}, id="t1")
            return _Stream(["Looking. "], _Final([_Block(type="text", text="Looking. "), tool], "tool_use"))
        return _Stream(
            ["Auth lives in src/auth.py."],
            _Final([_Block(type="text", text="Auth lives in src/auth.py.")], "end_turn"),
        )

    _install_client(stream)
    events = _collect("how does auth work?", _index())
    kinds = [e["type"] for e in events]

    assert "tool_start" in kinds and "tool_result" in kinds
    assert kinds[-1] == "done"

    # The tool actually retrieved auth.py from the real index
    result = next(e["content"] for e in events if e["type"] == "tool_result")
    assert "src/auth.py" in result

    # Sources populated from the real search
    sources = {s["path"] for s in events[-1]["sources"]}
    assert "src/auth.py" in sources

    text = "".join(e["delta"] for e in events if e["type"] == "text")
    assert "auth" in text.lower()


def test_all_tools_dispatch():
    """Every tool should dispatch through the loop in order."""
    seq = {
        1: _Block(type="tool_use", name="list_files", input={"extension": ".py"}, id="a"),
        2: _Block(type="tool_use", name="search_codebase", input={"query": "authenticate"}, id="b"),
        3: _Block(type="tool_use", name="read_file", input={"path": "src/missing.py"}, id="c"),
        4: _Block(type="tool_use", name="generate_docs", input={"path": "src/auth.py"}, id="d"),
    }
    calls = {"n": 0}

    def stream(**kw):
        calls["n"] += 1
        if calls["n"] in seq:
            return _Stream([], _Final([seq[calls["n"]]], "tool_use"))
        return _Stream(["Done."], _Final([_Block(type="text", text="Done.")], "end_turn"))

    _install_client(stream)
    events = _collect("explain auth", _index())

    dispatched = [e["tool"] for e in events if e["type"] == "tool_start"]
    assert dispatched == ["list_files", "search_codebase", "read_file", "generate_docs"]

    # Missing-file hint should fire
    read_result = next(
        e["content"] for e in events
        if e["type"] == "tool_result" and e["tool"] == "read_file"
    )
    assert "not found" in read_result.lower()


def test_round_cap_terminates():
    """A model that always asks for a tool must still terminate at the cap."""
    def stream(**kw):
        tool = _Block(type="tool_use", name="search_codebase", input={"query": "x"}, id="loop")
        return _Stream([], _Final([tool], "tool_use"))

    _install_client(stream)
    events = _collect("loop", _index())

    rounds = sum(1 for e in events if e["type"] == "tool_start")
    assert rounds == agent.MAX_TOOL_ROUNDS
    assert events[-1]["type"] == "done"
