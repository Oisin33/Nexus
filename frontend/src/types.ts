// types.ts

export interface RepoStatus {
  status: "empty" | "ready";
  owner?: string;
  repo?: string;
  branch?: string;
  file_count?: number;
  chunk_count?: number;
  url?: string;
}

export interface Source {
  path: string;
  lines: string;
  symbol: string | null;
}

export interface ToolEvent {
  type: "tool_start" | "tool_result";
  tool: string;
  input?: Record<string, unknown>;
  content?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  toolEvents?: ToolEvent[];
  timestamp: number;
  streaming?: boolean;
}

export type AgentEvent =
  | { type: "tool_start";  tool: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool: string; content: string }
  | { type: "text";        delta: string }
  | { type: "done";        sources: Source[] };
