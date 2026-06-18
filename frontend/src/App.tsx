import { useEffect, useState } from "react";
import type { RepoStatus } from "./types";
import RepoSetup from "./components/RepoSetup";
import ChatInterface from "./components/ChatInterface";
import Settings from "./components/Settings";

export default function App() {
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [keySet, setKeySet] = useState<boolean | null>(null);

  const refreshKeyStatus = () =>
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => setKeySet(!!s.anthropic_api_key_set))
      .catch(() => {});

  useEffect(() => {
    refreshKeyStatus();
  }, []);

  const onChat = status?.status === "ready";

  return (
    <>
      {/* Settings is reachable from the landing screen (the chat screen has its
          own top corners occupied). Set your key here before indexing a repo. */}
      {!onChat && (
        <button
          onClick={() => setShowSettings(true)}
          title="Settings"
          style={{
            position: "fixed", top: 14, right: 14, zIndex: 40,
            width: 38, height: 38, borderRadius: 9,
            background: "#00ff6a0a", border: "1px solid #00ff6a22",
            color: "#00ff6a", cursor: "pointer", fontSize: 17,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          ⚙
        </button>
      )}

      {!onChat && keySet === false && (
        <button
          onClick={() => setShowSettings(true)}
          style={{
            position: "fixed", top: 14, left: "50%", transform: "translateX(-50%)",
            zIndex: 40, padding: "8px 16px", borderRadius: 8,
            background: "#3a1a1a", border: "1px solid #f8717155",
            color: "#f8b4b4", cursor: "pointer", fontFamily: "monospace", fontSize: 12,
          }}
        >
          No Anthropic API key set. Click to add one.
        </button>
      )}

      {showSettings && (
        <Settings
          onClose={() => {
            setShowSettings(false);
            refreshKeyStatus();
          }}
          onSaved={() => refreshKeyStatus()}
        />
      )}

      {onChat
        ? <ChatInterface status={status} onReset={() => setStatus(null)} />
        : <RepoSetup onReady={setStatus} />}
    </>
  );
}
