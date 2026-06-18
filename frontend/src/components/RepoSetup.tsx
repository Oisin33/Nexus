import { useState } from "react";
import type { RepoStatus } from "../types";

// In dev, Vite proxies this to localhost:8000 (see vite.config.ts).
// In Docker, nginx handles the proxy (see nginx.conf).
const API = "/api";

// A few repos that work well as demos. Flask is the best one for first-time
// use because it's small enough to index quickly and has clean structure.
const EXAMPLES = [
  { url: "https://github.com/pallets/flask",   label: "pallets/flask",   note: "small, clean Python" },
  { url: "https://github.com/fastapi/fastapi", label: "fastapi/fastapi", note: "good for routing questions" },
  { url: "https://github.com/psf/requests",    label: "psf/requests",    note: "classic, well-documented" },
];

interface Props {
  onReady: (status: RepoStatus) => void;
}

export default function RepoSetup({ onReady }: Props) {
  const [url,     setUrl]     = useState("");
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [status,  setStatus]  = useState("");

  const index = async (repoUrl?: string) => {
    const target = (repoUrl ?? url).trim();
    if (!target) return;

    setLoading(true);
    setError(null);
    setStatus("fetching file tree from GitHub…");

    try {
      const res  = await fetch(`${API}/index`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo_url: target }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? "indexing failed");

      setStatus(`indexed ${data.file_count} files (${data.chunk_count} chunks) ✓`);
      await new Promise((r) => setTimeout(r, 500));
      onReady(data);
    } catch (e) {
      setError((e as Error).message);
      setLoading(false);
      setStatus("");
    }
  };

  return (
    <div style={{
      minHeight: "100vh",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: "40px 24px",
      background: "radial-gradient(ellipse 120% 80% at 50% -5%, #001a0a 0%, #090e13 65%)",
      fontFamily: "'IBM Plex Mono', monospace",
    }}>
      {/* Subtle grid */}
      <div style={{
        position: "fixed", inset: 0, pointerEvents: "none",
        backgroundImage: "linear-gradient(rgba(0,255,100,0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(0,255,100,0.025) 1px, transparent 1px)",
        backgroundSize: "52px 52px",
      }} />

      <div style={{ position: "relative", width: "100%", maxWidth: 580 }}>

        {/* Header */}
        <div style={{ marginBottom: 48, textAlign: "center" }}>
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 12, marginBottom: 20,
          }}>
            <div style={{
              width: 40, height: 40, borderRadius: 10,
              background: "#00ff6a0a", border: "1px solid #00ff6a22",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 20, color: "#00ff6a",
              boxShadow: "0 0 30px #00ff6a18",
            }}>
              ◈
            </div>
            <div style={{ textAlign: "left" }}>
              <div style={{ fontSize: 24, fontWeight: 700, color: "#e2fde8", letterSpacing: "-0.01em", lineHeight: 1 }}>
                Nexus
              </div>
              <div style={{ fontSize: 9, color: "#00ff6a88", letterSpacing: "0.15em", marginTop: 3 }}>
                CODEBASE INTELLIGENCE
              </div>
            </div>
          </div>

          <p style={{ fontSize: 12, color: "#3a6a4a", lineHeight: 1.8, maxWidth: 420, margin: "0 auto" }}>
            Ask questions about any public GitHub repo.<br />
            No cloning. No setup. Just a URL.
          </p>
        </div>

        {/* Input */}
        <div style={{
          display: "flex", gap: 8,
          background: "#0a1208", border: "1px solid #1a3a24",
          borderRadius: 10, padding: "5px 5px 5px 16px",
          marginBottom: 12,
          boxShadow: "0 20px 60px #00000060",
          transition: "border-color 0.2s",
        }}
          onFocusCapture={(e) => e.currentTarget.style.borderColor = "#2a5a3a"}
          onBlurCapture={(e) => e.currentTarget.style.borderColor = "#1a3a24"}
        >
          <span style={{ color: "#2a5a3a", fontSize: 12, lineHeight: "38px", flexShrink: 0, userSelect: "none" }}>
            github.com/
          </span>
          <input
            autoFocus
            value={url.replace(/^https?:\/\/github\.com\//, "")}
            onChange={(e) => setUrl("https://github.com/" + e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && index()}
            placeholder="owner/repo"
            disabled={loading}
            style={{
              flex: 1, background: "none", border: "none", outline: "none",
              fontSize: 13, color: "#c9f0d0", padding: "10px 0",
              fontFamily: "'IBM Plex Mono', monospace",
            }}
          />
          <button
            onClick={() => index()}
            disabled={loading}
            style={{
              background: loading ? "#0a1208" : "#00ff6a",
              border: "none", borderRadius: 7, padding: "9px 18px",
              color: loading ? "#2a5a3a" : "#001a0a",
              fontSize: 11, fontWeight: 700, cursor: loading ? "not-allowed" : "pointer",
              fontFamily: "'IBM Plex Mono', monospace",
              transition: "all 0.2s", flexShrink: 0,
              boxShadow: loading ? "none" : "0 4px 16px #00ff6a33",
            }}
          >
            {loading ? "indexing…" : "index →"}
          </button>
        </div>

        {/* Status / error */}
        {status && !error && (
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8, paddingLeft: 2 }}>
            <div style={{
              width: 5, height: 5, borderRadius: "50%", background: "#00ff6a",
              animation: loading ? "pulse 1s ease-in-out infinite" : "none",
              flexShrink: 0,
            }} />
            <span style={{ fontSize: 10, color: "#4a8a5a" }}>{status}</span>
          </div>
        )}
        {error && (
          <div style={{
            background: "#0d0608", border: "1px solid #3a1a1a",
            borderRadius: 7, padding: "9px 13px", marginBottom: 8,
            fontSize: 11, color: "#f87171",
          }}>
            {error}
          </div>
        )}

        {/* Example repos */}
        <div style={{ marginTop: 28 }}>
          <div style={{ fontSize: 9, color: "#1a3a24", letterSpacing: "0.12em", marginBottom: 10 }}>
            OR TRY ONE OF THESE
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {EXAMPLES.map((ex) => (
              <button
                key={ex.url}
                onClick={() => { setUrl(ex.url); index(ex.url); }}
                disabled={loading}
                style={{
                  background: "none", border: "1px solid #1a3a24",
                  borderRadius: 8, padding: "9px 14px",
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  cursor: loading ? "not-allowed" : "pointer",
                  transition: "all 0.15s", textAlign: "left",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#2a5a3a"; e.currentTarget.style.background = "#0a1208"; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#1a3a24"; e.currentTarget.style.background = "none"; }}
              >
                <span style={{ fontSize: 11, color: "#4a8a5a" }}>{ex.label}</span>
                <span style={{ fontSize: 10, color: "#2a4a34" }}>{ex.note}</span>
              </button>
            ))}
          </div>
        </div>

        {/* What it does, briefly */}
        <div style={{
          display: "grid", gridTemplateColumns: "1fr 1fr",
          gap: 8, marginTop: 36,
        }}>
          {[
            ["searches the code", "BM25 over language-aware chunks"],
            ["uses tool calling",  "Claude reads files to answer"],
            ["cites sources",      "every answer links to exact lines"],
            ["no cloning",        "GitHub API only, no local git"],
          ].map(([title, desc]) => (
            <div key={title} style={{
              background: "#0a1208", border: "1px solid #1a3a24",
              borderRadius: 7, padding: "11px 13px",
            }}>
              <div style={{ fontSize: 10, color: "#4a8a5a", marginBottom: 3 }}>{title}</div>
              <div style={{ fontSize: 9, color: "#2a4a34", lineHeight: 1.5 }}>{desc}</div>
            </div>
          ))}
        </div>
      </div>

      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }`}</style>
    </div>
  );
}
