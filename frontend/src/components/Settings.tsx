import { useEffect, useState } from "react";

// In dev, Vite proxies this to localhost:8000 (see vite.config.ts).
const API = "/api";

interface Status {
  anthropic_api_key_set: boolean;
  anthropic_api_key_masked: string;
  github_token_set: boolean;
  github_token_masked: string;
  anthropic_model: string;
  anthropic_valid?: boolean | null;
}

interface Props {
  onClose: () => void;
  onSaved?: (status: Status) => void;
}

const GREEN = "#00ff6a";
const PANEL = "#0a1208";
const LINE = "#1a3a24";
const TEXT = "#e2fde8";
const MUTED = "#4a8a5a";

export default function Settings({ onClose, onSaved }: Props) {
  const [status, setStatus] = useState<Status | null>(null);
  const [anthropic, setAnthropic] = useState("");
  const [github, setGithub] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    fetch(`${API}/settings`)
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setMsg({ text: "Couldn't reach the backend.", ok: false }));
  }, []);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch(`${API}/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          anthropic_api_key: anthropic || undefined,
          github_token: github || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? "save failed");
      setStatus(data);
      setAnthropic("");
      setGithub("");
      if (data.anthropic_valid === false) {
        setMsg({ text: "Saved, but that Anthropic key didn't validate. Double-check it.", ok: false });
      } else {
        setMsg({ text: "Saved to .env. The change is live now.", ok: true });
      }
      onSaved?.(data);
    } catch (e: any) {
      setMsg({ text: e.message || "Couldn't save.", ok: false });
    } finally {
      setSaving(false);
    }
  };

  const labelStyle: React.CSSProperties = {
    display: "block", fontSize: 13, color: TEXT, marginBottom: 6, marginTop: 18,
    fontFamily: "monospace",
  };
  const inputStyle: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", padding: "10px 12px",
    background: "#001a0a", border: `1px solid ${LINE}`, borderRadius: 8,
    color: TEXT, fontFamily: "monospace", fontSize: 13, outline: "none",
  };
  const setTag = (masked: string): React.CSSProperties => ({
    fontSize: 11, color: GREEN, marginLeft: 8, fontFamily: "monospace",
  });

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 50,
        background: "rgba(0,0,0,0.6)", backdropFilter: "blur(2px)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%", maxWidth: 460, background: PANEL,
          border: `1px solid ${LINE}`, borderRadius: 14, padding: 24,
          boxShadow: "0 0 40px #00ff6a18", color: TEXT,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h2 style={{ margin: 0, fontSize: 17, fontFamily: "monospace", color: TEXT }}>Settings</h2>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", color: MUTED, fontSize: 22, cursor: "pointer", lineHeight: 1 }}
          >
            ×
          </button>
        </div>

        <p style={{ fontSize: 12, color: MUTED, marginTop: 10, lineHeight: 1.6 }}>
          Keys are stored in <code style={{ color: GREEN }}>.env</code> on the machine running the
          backend, and applied immediately. For local use only.
        </p>

        <label style={labelStyle}>
          Anthropic API key
          {status?.anthropic_api_key_set && <span style={setTag(status.anthropic_api_key_masked)}>set ({status.anthropic_api_key_masked})</span>}
        </label>
        <input
          type="password" autoComplete="off" spellCheck={false}
          placeholder="sk-ant-..." value={anthropic}
          onChange={(e) => setAnthropic(e.target.value)} style={inputStyle}
        />

        <label style={labelStyle}>
          GitHub token <span style={{ color: MUTED, fontSize: 11 }}>(optional, raises rate limit)</span>
          {status?.github_token_set && <span style={setTag(status.github_token_masked)}>set ({status.github_token_masked})</span>}
        </label>
        <input
          type="password" autoComplete="off" spellCheck={false}
          placeholder="ghp_..." value={github}
          onChange={(e) => setGithub(e.target.value)} style={inputStyle}
        />

        {msg && (
          <div style={{
            marginTop: 16, fontSize: 12, fontFamily: "monospace",
            color: msg.ok ? GREEN : "#f87171",
          }}>
            {msg.text}
          </div>
        )}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 22 }}>
          <button
            onClick={onClose}
            style={{
              padding: "9px 16px", background: "transparent", color: MUTED,
              border: `1px solid ${LINE}`, borderRadius: 8, cursor: "pointer",
              fontFamily: "monospace", fontSize: 13,
            }}
          >
            Close
          </button>
          <button
            onClick={save}
            disabled={saving || (!anthropic && !github)}
            style={{
              padding: "9px 18px",
              background: saving || (!anthropic && !github) ? "#00ff6a18" : GREEN,
              color: saving || (!anthropic && !github) ? MUTED : "#001206",
              border: "none", borderRadius: 8,
              cursor: saving || (!anthropic && !github) ? "default" : "pointer",
              fontFamily: "monospace", fontSize: 13, fontWeight: 600,
            }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
