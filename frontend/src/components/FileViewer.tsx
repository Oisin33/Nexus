import { useState, useEffect, useRef } from "react";

// In dev, Vite proxies this to localhost:8000 (see vite.config.ts).
// In Docker, nginx handles the proxy (see nginx.conf).
const API = "/api";

interface Props {
  path: string;
  highlightLines?: { start: number; end: number };
  onClose: () => void;
}

// Very basic syntax coloring via regex. Not trying to be a real highlighter —
// just enough to make the output readable. A real implementation would use
// highlight.js or Shiki, but that's a heavy dependency for something that's
// mostly functional as plain text anyway.
function colorize(line: string, lang: string): string {
  if (lang === "text" || lang === "markdown") return escHtml(line);

  let s = escHtml(line);

  // Strings
  s = s.replace(/(&quot;.*?&quot;|&#x27;.*?&#x27;|`.*?`)/g, '<span style="color:#a5d8ff">$1</span>');
  // Comments
  if (lang === "python") {
    s = s.replace(/(#.*)$/, '<span style="color:#4a6a54">$1</span>');
  } else {
    s = s.replace(/(\/\/.*)$/, '<span style="color:#4a6a54">$1</span>');
    s = s.replace(/(\/\*.*?\*\/)/g, '<span style="color:#4a6a54">$1</span>');
  }
  // Keywords
  const kw = lang === "python"
    ? /\b(def|class|import|from|return|if|elif|else|for|while|try|except|finally|with|as|pass|raise|yield|async|await|not|and|or|in|is|None|True|False|self|lambda)\b/g
    : /\b(const|let|var|function|class|import|export|return|if|else|for|while|try|catch|finally|async|await|new|this|typeof|instanceof|null|undefined|true|false|type|interface|enum|extends|implements)\b/g;
  s = s.replace(kw, '<span style="color:#c084fc">$1</span>');
  // Numbers
  s = s.replace(/\b(\d+\.?\d*)\b/g, '<span style="color:#fbbf24">$1</span>');

  return s;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

function getLang(path: string): string {
  const ext = path.split(".").pop() || "";
  const map: Record<string, string> = {
    py: "python", js: "javascript", jsx: "javascript",
    ts: "typescript", tsx: "typescript", go: "go", rs: "rust",
    java: "java", kt: "kotlin", rb: "ruby", sh: "bash",
    sql: "sql", md: "markdown", json: "json",
  };
  return map[ext] || "text";
}

export default function FileViewer({ path, highlightLines, onClose }: Props) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading]  = useState(true);
  const [error, setError]      = useState<string | null>(null);
  const highlightRef           = useRef<HTMLTableRowElement>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setContent(null);

    fetch(`${API}/file?path=${encodeURIComponent(path)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json();
      })
      .then((d) => setContent(d.content))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [path]);

  // Scroll to highlighted range once content loads
  useEffect(() => {
    if (content && highlightLines && highlightRef.current) {
      setTimeout(() => highlightRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 80);
    }
  }, [content, highlightLines]);

  const lines   = content?.split("\n") ?? [];
  const lang    = getLang(path);
  const hlStart = highlightLines?.start ?? -1;
  const hlEnd   = highlightLines?.end   ?? -1;

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      height: "100%", background: "#060d09",
      borderLeft: "1px solid #1a3a24",
      fontFamily: "'IBM Plex Mono', monospace",
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 14px", borderBottom: "1px solid #1a3a24",
        background: "#0a1208", flexShrink: 0,
      }}>
        <div style={{ overflow: "hidden" }}>
          <div style={{ fontSize: 11, color: "#5a8a6a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {path}
          </div>
          {highlightLines && (
            <div style={{ fontSize: 9, color: "#3a6a4a", marginTop: 2 }}>
              lines {highlightLines.start}–{highlightLines.end}
            </div>
          )}
        </div>
        <button
          onClick={onClose}
          style={{
            background: "none", border: "1px solid #1a3a24",
            borderRadius: 5, padding: "3px 8px", cursor: "pointer",
            color: "#3a6a4a", fontSize: 11, flexShrink: 0, marginLeft: 10,
            fontFamily: "'IBM Plex Mono', monospace",
            transition: "all 0.15s",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#3a6a4a"; e.currentTarget.style.color = "#00ff6a"; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#1a3a24"; e.currentTarget.style.color = "#3a6a4a"; }}
        >
          ✕
        </button>
      </div>

      {/* Content */}
      <div style={{
        flex: 1, overflowY: "auto",
        scrollbarWidth: "thin", scrollbarColor: "#1a3a24 transparent",
      }}>
        {loading && (
          <div style={{ padding: 20, fontSize: 11, color: "#3a6a4a" }}>loading…</div>
        )}
        {error && (
          <div style={{ padding: 20, fontSize: 11, color: "#f87171" }}>{error}</div>
        )}
        {content && (
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 11, lineHeight: 1.6 }}>
            <tbody>
              {lines.map((line, i) => {
                const lineNum = i + 1;
                const isHighlighted = lineNum >= hlStart && lineNum <= hlEnd;
                return (
                  <tr
                    key={i}
                    ref={isHighlighted && lineNum === hlStart ? highlightRef : null}
                    style={{
                      background: isHighlighted ? "#00ff6a0d" : "transparent",
                      borderLeft: isHighlighted ? "2px solid #00ff6a44" : "2px solid transparent",
                    }}
                  >
                    <td style={{
                      width: 44, paddingLeft: 8, paddingRight: 12,
                      color: "#2a4a34", textAlign: "right",
                      userSelect: "none", verticalAlign: "top",
                      fontVariantNumeric: "tabular-nums",
                      fontSize: 10,
                    }}>
                      {lineNum}
                    </td>
                    <td style={{ paddingRight: 20, whiteSpace: "pre", color: "#7ab88a" }}>
                      <span dangerouslySetInnerHTML={{ __html: colorize(line, lang) || " " }} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
