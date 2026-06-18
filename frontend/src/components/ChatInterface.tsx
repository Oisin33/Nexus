import { useState, useRef, useEffect, useCallback } from "react";
import type { ChatMessage, RepoStatus, Source, AgentEvent, ToolEvent } from "../types";
import FileTree from "./FileTree";
import FileViewer from "./FileViewer";

// In dev, Vite proxies this to localhost:8000 (see vite.config.ts).
// In Docker, nginx handles the proxy (see nginx.conf).
const API = "/api";

const TOOL_LABELS: Record<string, { label: string; icon: string }> = {
  search_codebase: { label: "searching",      icon: "⌕" },
  read_file:       { label: "reading",         icon: "↗" },
  list_files:      { label: "listing files",   icon: "≡" },
  generate_docs:   { label: "generating docs", icon: "◎" },
};

const STARTER_QUESTIONS = [
  "Walk me through the overall architecture",
  "How does the request/response cycle work?",
  "What does the entry point do?",
  "Where is error handling done?",
  "What external services or APIs does this use?",
  "Generate docs for the main module",
];

// ── Markdown-ish renderer ─────────────────────────────────────────────────────
// Handles fenced code blocks, inline code, bold, headers. Not a full markdown
// parser — just enough for what the agent actually produces.

function renderContent(text: string) {
  const fenceRe = /```([\w]*)\n([\s\S]*?)```/g;
  const parts: React.ReactNode[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = fenceRe.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parts.push(<InlineText key={key++} text={text.slice(lastIdx, match.index)} />);
    }
    parts.push(
      <CodeBlock key={key++} lang={match[1]} code={match[2].trimEnd()} />
    );
    lastIdx = match.index + match[0].length;
  }

  if (lastIdx < text.length) {
    parts.push(<InlineText key={key++} text={text.slice(lastIdx)} />);
  }

  return <>{parts}</>;
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div style={{
      background: "#060d09", border: "1px solid #1a3a24",
      borderRadius: 8, margin: "10px 0", overflow: "hidden",
    }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "5px 12px", borderBottom: "1px solid #1a3a24",
        background: "#0a1208",
      }}>
        <span style={{ fontSize: 9, color: "#3a6a4a", letterSpacing: "0.08em" }}>
          {lang || "code"}
        </span>
        <button
          onClick={copy}
          style={{
            background: "none", border: "none", cursor: "pointer",
            fontSize: 9, color: copied ? "#00ff6a" : "#3a6a4a",
            fontFamily: "'IBM Plex Mono', monospace",
            transition: "color 0.2s",
          }}
        >
          {copied ? "copied ✓" : "copy"}
        </button>
      </div>
      <pre style={{
        margin: 0, padding: "12px 16px", fontSize: 11.5,
        color: "#8ab88a", lineHeight: 1.65,
        overflowX: "auto", whiteSpace: "pre",
      }}>
        {code}
      </pre>
    </div>
  );
}

function InlineText({ text }: { text: string }) {
  const lines = text.split("\n");
  const nodes: React.ReactNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("### ")) {
      nodes.push(<div key={i} style={{ fontWeight: 600, color: "#00ff6a", marginTop: 14, marginBottom: 4, fontSize: 13 }}>{line.slice(4)}</div>);
    } else if (line.startsWith("## ")) {
      nodes.push(<div key={i} style={{ fontWeight: 700, color: "#c9f0d0", marginTop: 18, marginBottom: 6, fontSize: 14 }}>{line.slice(3)}</div>);
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      nodes.push(
        <div key={i} style={{ display: "flex", gap: 8, marginTop: 3 }}>
          <span style={{ color: "#3a6a4a", flexShrink: 0, marginTop: 1 }}>·</span>
          <span>{formatInline(line.slice(2))}</span>
        </div>
      );
    } else {
      nodes.push(<span key={i}>{formatInline(line)}{i < lines.length - 1 ? "\n" : ""}</span>);
    }
  }

  return <>{nodes}</>;
}

function formatInline(text: string): React.ReactNode {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith("`") && p.endsWith("`"))
          return <code key={i} style={{ background: "#0a1a0e", color: "#00ff6a", padding: "1px 5px", borderRadius: 3, fontSize: "0.88em", border: "1px solid #1a3a24" }}>{p.slice(1, -1)}</code>;
        if (p.startsWith("**") && p.endsWith("**"))
          return <strong key={i} style={{ color: "#e2fde8" }}>{p.slice(2, -2)}</strong>;
        return <span key={i}>{p}</span>;
      })}
    </>
  );
}


// ── Tool activity badge ───────────────────────────────────────────────────────

function ToolBadge({ event, isLast }: { event: ToolEvent; isLast: boolean }) {
  const [open, setOpen] = useState(false);
  const meta   = TOOL_LABELS[event.tool];
  const done   = event.type === "tool_result";
  const detail = event.input?.query ?? event.input?.path ?? event.input?.directory ?? null;

  return (
    <div
      onClick={() => done && setOpen((v) => !v)}
      style={{
        display: "flex", alignItems: "flex-start", gap: 8,
        padding: "4px 0",
        cursor: done ? "pointer" : "default",
        opacity: done ? 1 : 0.6,
      }}
    >
      <div style={{
        width: 16, height: 16, borderRadius: 4, flexShrink: 0, marginTop: 1,
        background: done ? "#00ff6a15" : "#ffffff08",
        border: `1px solid ${done ? "#00ff6a33" : "#2a3a2a"}`,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 9, color: done ? "#00ff6a" : "#4a6a4a",
      }}>
        {done ? "✓" : meta?.icon ?? "○"}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 10.5, color: done ? "#4a8a5a" : "#3a6a4a", fontFamily: "'IBM Plex Mono', monospace" }}>
          {meta?.label ?? event.tool}
          {detail && <span style={{ color: "#2a5a3a", marginLeft: 6 }}>"{String(detail).slice(0, 50)}"</span>}
          {!done && isLast && <span style={{ animation: "blink 1s step-end infinite" }}>_</span>}
        </span>
        {open && event.content && (
          <div style={{
            marginTop: 6, padding: "8px 10px",
            background: "#060d09", border: "1px solid #1a3a24", borderRadius: 5,
            fontSize: 10, color: "#4a7a5a", whiteSpace: "pre-wrap", wordBreak: "break-word",
            maxHeight: 180, overflowY: "auto",
          }}>
            {event.content.slice(0, 800)}{event.content.length > 800 ? "\n…" : ""}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Source chip ───────────────────────────────────────────────────────────────

function SourceChip({ source, onClick }: { source: Source; onClick: () => void }) {
  const filename = source.path.split("/").pop() ?? source.path;
  return (
    <button
      onClick={onClick}
      title={`${source.path} [${source.lines}]`}
      style={{
        background: "#0a1208", border: "1px solid #1a3a24",
        borderRadius: 5, padding: "3px 9px",
        fontSize: 10, color: "#4a7a5a", cursor: "pointer",
        fontFamily: "'IBM Plex Mono', monospace",
        transition: "all 0.12s", display: "flex", alignItems: "center", gap: 5,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#00ff6a44"; e.currentTarget.style.color = "#00ff6a"; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#1a3a24"; e.currentTarget.style.color = "#4a7a5a"; }}
    >
      <span style={{ opacity: 0.5 }}>↗</span>
      {source.symbol ? `${filename}::${source.symbol}` : filename}
      <span style={{ color: "#2a4a34" }}>{source.lines}</span>
    </button>
  );
}


// ── Message bubble ────────────────────────────────────────────────────────────

function MessageBubble({
  msg,
  onSourceClick,
}: {
  msg: ChatMessage;
  onSourceClick: (source: Source) => void;
}) {
  const isUser = msg.role === "user";

  if (isUser) {
    return (
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 24 }}>
        <div style={{
          background: "#0a2214", border: "1px solid #1a4a2a",
          borderRadius: "12px 12px 3px 12px", padding: "10px 16px",
          maxWidth: "72%", fontSize: 13, color: "#c9f0d0",
          fontFamily: "'IBM Plex Mono', monospace", lineHeight: 1.6,
        }}>
          {msg.content}
        </div>
      </div>
    );
  }

  const toolEvents = msg.toolEvents ?? [];
  const hasTools   = toolEvents.length > 0;
  const hasContent = msg.content.length > 0;
  const hasSources = (msg.sources ?? []).length > 0;

  return (
    <div style={{ display: "flex", gap: 10, marginBottom: 28, alignItems: "flex-start" }}>
      {/* Avatar */}
      <div style={{
        width: 26, height: 26, borderRadius: 6, flexShrink: 0, marginTop: 2,
        background: "#00ff6a0d", border: "1px solid #00ff6a22",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 12, color: "#00ff6a",
      }}>
        ◈
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Tool activity */}
        {hasTools && (
          <div style={{
            background: "#060d09", border: "1px solid #1a3a24",
            borderRadius: 8, padding: "8px 12px", marginBottom: 10,
          }}>
            {toolEvents.map((ev, i) => (
              <ToolBadge key={i} event={ev} isLast={i === toolEvents.length - 1 && msg.streaming === true} />
            ))}
          </div>
        )}

        {/* Response text */}
        {(hasContent || msg.streaming) && (
          <div style={{
            fontSize: 13, color: "#b0d8b8", lineHeight: 1.75,
            fontFamily: "'IBM Plex Mono', monospace",
            whiteSpace: "pre-wrap", wordBreak: "break-word",
          }}>
            {renderContent(msg.content)}
            {msg.streaming && (
              <span style={{ color: "#3a6a4a", animation: "blink 1s step-end infinite" }}>▋</span>
            )}
          </div>
        )}

        {/* Sources */}
        {hasSources && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 9, color: "#2a4a34", letterSpacing: "0.1em", marginBottom: 7 }}>SOURCES</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {(msg.sources ?? []).map((s, i) => (
                <SourceChip key={i} source={s} onClick={() => onSourceClick(s)} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}


// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  status: RepoStatus;
  onReset: () => void;
}

export default function ChatInterface({ status, onReset }: Props) {
  const [messages,    setMessages]    = useState<ChatMessage[]>([]);
  const [input,       setInput]       = useState("");
  const [streaming,   setStreaming]   = useState(false);
  const [files,       setFiles]       = useState<string[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [viewerFile,  setViewerFile]  = useState<{ path: string; lines?: { start: number; end: number } } | null>(null);
  const [referencedPaths, setReferencedPaths] = useState<Set<string>>(new Set());

  const bottomRef  = useRef<HTMLDivElement>(null);
  const inputRef   = useRef<HTMLTextAreaElement>(null);

  // Fetch file list after indexing
  useEffect(() => {
    fetch(`${API}/files`)
      .then((r) => r.json())
      .then((d) => setFiles(d.files ?? []))
      .catch(() => {});
  }, []);

  // Scroll to bottom as messages update
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Cmd/Ctrl+K to focus input
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
      // Escape to close file viewer
      if (e.key === "Escape" && viewerFile) {
        setViewerFile(null);
      }
      // Cmd+\ to toggle sidebar
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        setSidebarOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [viewerFile]);

  const buildHistory = useCallback(
    () => messages.filter((m) => !m.streaming).map((m) => ({ role: m.role, content: m.content })),
    [messages]
  );

  const sendMessage = useCallback(async (text?: string) => {
    const query = (text ?? input).trim();
    if (!query || streaming) return;
    setInput("");
    // Clearing the value via state doesn't reset the inline height we set
    // while auto-growing, so the empty box stays tall. Reset it by hand.
    if (inputRef.current) inputRef.current.style.height = "auto";

    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: "user", content: query, timestamp: Date.now() };
    const assistantId = crypto.randomUUID();
    const assistantMsg: ChatMessage = {
      id: assistantId, role: "assistant", content: "",
      sources: [], toolEvents: [], timestamp: Date.now(), streaming: true,
    };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setStreaming(true);

    try {
      const res = await fetch(`${API}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: query, history: buildHistory() }),
      });

      if (!res.ok || !res.body) {
        const err = await res.text().catch(() => "Unknown error");
        throw new Error(err);
      }

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer    = "";

      const patch = (fn: (m: ChatMessage) => ChatMessage) =>
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? fn(m) : m)));

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let event: AgentEvent;
          try { event = JSON.parse(line.slice(6)); }
          catch { continue; }

          switch (event.type) {
            case "text":
              patch((m) => ({ ...m, content: m.content + event.delta }));
              break;
            case "tool_start":
              patch((m) => ({ ...m, toolEvents: [...(m.toolEvents ?? []), { type: "tool_start", tool: event.tool, input: event.input }] }));
              break;
            case "tool_result":
              patch((m) => ({ ...m, toolEvents: [...(m.toolEvents ?? []), { type: "tool_result", tool: event.tool, content: event.content }] }));
              break;
            case "done":
              patch((m) => ({ ...m, sources: event.sources, streaming: false }));
              setReferencedPaths((prev) => {
                const next = new Set(prev);
                event.sources.forEach((s) => next.add(s.path));
                return next;
              });
              break;
          }
        }
      }
    } catch (e) {
      setMessages((prev) =>
        prev.map((m) => m.id === assistantId ? { ...m, content: `Error: ${(e as Error).message}`, streaming: false } : m)
      );
    } finally {
      setStreaming(false);
      inputRef.current?.focus();
    }
  }, [input, streaming, buildHistory]);

  const handleSourceClick = (source: Source) => {
    const lineRange = source.lines !== "full" && source.lines !== "full file"
      ? (() => {
          const parts = source.lines.split(/[–—-]/);
          const start = parseInt(parts[0]);
          const end   = parseInt(parts[1] ?? parts[0]);
          return isNaN(start) ? undefined : { start, end };
        })()
      : undefined;
    setViewerFile({ path: source.path, lines: lineRange });
  };

  // Auto-resize textarea
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
  };

  const viewerWidth = viewerFile ? 420 : 0;

  return (
    <div style={{
      height: "100vh", display: "flex", flexDirection: "column",
      background: "#090e13", fontFamily: "'IBM Plex Mono', monospace",
    }}>

      {/* Top bar */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 16px", borderBottom: "1px solid #1a3a24",
        background: "#0a1208", flexShrink: 0, gap: 10,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            title="⌘\"
            style={{
              background: "none", border: "1px solid #1a3a24", borderRadius: 5,
              padding: "3px 7px", cursor: "pointer", color: sidebarOpen ? "#4a8a5a" : "#2a5a3a",
              fontSize: 11, transition: "all 0.15s",
            }}
          >
            ≡
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 14, color: "#00ff6a" }}>◈</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: "#c9f0d0" }}>
              {status.owner}/{status.repo}
            </span>
            <span style={{ fontSize: 10, color: "#2a5a3a" }}>·</span>
            <span style={{ fontSize: 10, color: "#2a5a3a" }}>{status.branch}</span>
            <span style={{ fontSize: 10, color: "#2a5a3a" }}>·</span>
            <span style={{ fontSize: 10, color: "#2a5a3a" }}>{status.file_count} files</span>
          </div>
        </div>
        <button
          onClick={onReset}
          style={{
            background: "none", border: "1px solid #1a3a24", borderRadius: 6,
            padding: "4px 12px", color: "#3a6a4a", fontSize: 10, cursor: "pointer",
            transition: "all 0.15s",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#3a6a4a"; e.currentTarget.style.color = "#00ff6a"; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#1a3a24"; e.currentTarget.style.color = "#3a6a4a"; }}
        >
          ← switch repo
        </button>
      </div>

      {/* Body: sidebar + chat + file viewer */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

        {/* File tree sidebar */}
        {sidebarOpen && (
          <div style={{ width: 220, flexShrink: 0, overflow: "hidden" }}>
            <FileTree
              files={files}
              referencedPaths={referencedPaths}
              onFileClick={(path) => setViewerFile({ path })}
              activeFile={viewerFile?.path ?? null}
            />
          </div>
        )}

        {/* Chat area */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

          {/* Messages */}
          <div style={{
            flex: 1, overflowY: "auto", padding: "28px 28px 0",
            scrollbarWidth: "thin", scrollbarColor: "#1a3a24 transparent",
          }}>
            {messages.length === 0 && (
              <div style={{ textAlign: "center", paddingTop: 60, paddingBottom: 40 }}>
                <div style={{ fontSize: 24, color: "#1a4a2a", marginBottom: 10 }}>◈</div>
                <div style={{ fontSize: 12, color: "#2a5a3a", marginBottom: 28 }}>
                  ask anything about {status.owner}/{status.repo}
                </div>
                <div style={{
                  display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                  gap: 8, maxWidth: 660, margin: "0 auto",
                }}>
                  {STARTER_QUESTIONS.map((q) => (
                    <button
                      key={q}
                      onClick={() => sendMessage(q)}
                      style={{
                        background: "#0a1208", border: "1px solid #1a3a24",
                        borderRadius: 8, padding: "10px 14px", textAlign: "left",
                        color: "#3a6a4a", fontSize: 11, cursor: "pointer",
                        transition: "all 0.15s", lineHeight: 1.5,
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#2a5a3a"; e.currentTarget.style.color = "#6a9a7a"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#1a3a24"; e.currentTarget.style.color = "#3a6a4a"; }}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg) => (
              <MessageBubble key={msg.id} msg={msg} onSourceClick={handleSourceClick} />
            ))}

            <div ref={bottomRef} style={{ height: 24 }} />
          </div>

          {/* Input */}
          <div style={{
            padding: "12px 20px 16px",
            borderTop: "1px solid #1a3a24",
            background: "#0a1208",
          }}>
            <div style={{
              display: "flex", gap: 8, alignItems: "flex-end",
              background: "#060d09", border: `1px solid ${streaming ? "#1a4a2a" : "#1a3a24"}`,
              borderRadius: 10, padding: "8px 8px 8px 14px",
              transition: "border-color 0.2s",
            }}>
              <textarea
                ref={inputRef}
                value={input}
                onChange={handleInputChange}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
                placeholder="ask something… (⌘K to focus, shift+enter for newline)"
                disabled={streaming}
                rows={1}
                style={{
                  flex: 1, background: "none", border: "none", outline: "none",
                  fontSize: 12.5, color: "#c9f0d0", resize: "none",
                  fontFamily: "'IBM Plex Mono', monospace", lineHeight: 1.6,
                  minHeight: 24, maxHeight: 160,
                  scrollbarWidth: "none",
                }}
              />
              <button
                onClick={() => sendMessage()}
                disabled={streaming || !input.trim()}
                style={{
                  background: streaming || !input.trim() ? "transparent" : "#00ff6a",
                  border: "1px solid",
                  borderColor: streaming || !input.trim() ? "#1a3a24" : "#00ff6a",
                  borderRadius: 7, padding: "7px 14px",
                  color: streaming || !input.trim() ? "#2a5a3a" : "#001a0a",
                  fontSize: 11, fontWeight: 700,
                  cursor: streaming || !input.trim() ? "not-allowed" : "pointer",
                  fontFamily: "'IBM Plex Mono', monospace",
                  transition: "all 0.15s", flexShrink: 0, alignSelf: "flex-end",
                }}
              >
                {streaming ? "…" : "↵"}
              </button>
            </div>
            <div style={{ fontSize: 9, color: "#1a3a24", marginTop: 6, display: "flex", gap: 16 }}>
              <span>↵ send</span>
              <span>⇧↵ newline</span>
              <span>⌘K focus</span>
              <span>⌘\ sidebar</span>
              <span>esc close viewer</span>
            </div>
          </div>
        </div>

        {/* File viewer panel */}
        {viewerFile && (
          <div style={{ width: viewerWidth, flexShrink: 0, overflow: "hidden" }}>
            <FileViewer
              path={viewerFile.path}
              highlightLines={viewerFile.lines}
              onClose={() => setViewerFile(null)}
            />
          </div>
        )}
      </div>

      <style>{`
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
      `}</style>
    </div>
  );
}
