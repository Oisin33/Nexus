import { useState, useMemo } from "react";

interface TreeNode {
  name: string;
  path: string;
  isFile: boolean;
  ext: string;
  children: Record<string, TreeNode>;
}

interface Props {
  files: string[];
  referencedPaths: Set<string>;
  onFileClick: (path: string) => void;
  activeFile: string | null;
}

// Convert flat list of paths into a nested tree structure.
// e.g. ["src/api/auth.py", "src/models/user.py"] becomes a proper tree.
function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: "", path: "", isFile: false, ext: "", children: {} };

  for (const p of paths) {
    const parts = p.split("/");
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!node.children[part]) {
        const isFile = i === parts.length - 1;
        const nodePath = parts.slice(0, i + 1).join("/");
        const ext = isFile ? (part.includes(".") ? part.split(".").pop()! : "") : "";
        node.children[part] = { name: part, path: nodePath, isFile, ext, children: {} };
      }
      node = node.children[part];
    }
  }

  return root;
}

// Sort so directories always come before files, then alphabetically.
function sortedEntries(children: Record<string, TreeNode>): TreeNode[] {
  return Object.values(children).sort((a, b) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

const EXT_COLOR: Record<string, string> = {
  py: "#4e9eff",   ts: "#4e9eff",  tsx: "#4e9eff",  js: "#fbbf24",
  jsx: "#fbbf24",  rs: "#f97316", go: "#06b6d4",    java: "#f87171",
  kt: "#a855f7",   rb: "#f43f5e", md: "#94a3b8",    json: "#6b7a99",
  yaml: "#6b7a99", yml: "#6b7a99",sql: "#10b981",   sh: "#22d3ee",
  css: "#c084fc",  scss: "#c084fc",html: "#fb923c",
};

function fileColor(ext: string): string {
  return EXT_COLOR[ext] || "#6b7a99";
}

// Renders a single node in the file tree. Directories expand/collapse on click.
// Folders with referenced descendants are highlighted so you can see at a glance
// which parts of the codebase the agent looked at.
function TreeNodeComponent({
  node,
  depth,
  referencedPaths,
  onFileClick,
  activeFile,
  defaultOpen,
}: {
  node: TreeNode;
  depth: number;
  referencedPaths: Set<string>;
  onFileClick: (path: string) => void;
  activeFile: string | null;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const entries = sortedEntries(node.children);
  const isActive = activeFile === node.path;
  const isReferenced = referencedPaths.has(node.path);

  // Is any descendant referenced? If so, the folder should be visually highlighted.
  const hasReferencedChild = useMemo(() => {
    if (!node.isFile) {
      const check = (n: TreeNode): boolean =>
        referencedPaths.has(n.path) || Object.values(n.children).some(check);
      return check(node);
    }
    return false;
  }, [node, referencedPaths]);

  const indent = depth * 12;

  if (node.isFile) {
    return (
      <div
        onClick={() => onFileClick(node.path)}
        title={node.path}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          paddingLeft: indent + 16, paddingRight: 10,
          paddingTop: 3, paddingBottom: 3,
          cursor: "pointer",
          background: isActive ? "#00ff6a18" : "transparent",
          borderLeft: isActive ? "2px solid #00ff6a" : "2px solid transparent",
          borderRadius: "0 4px 4px 0",
          transition: "background 0.1s",
        }}
        onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "#ffffff08"; }}
        onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
      >
        <span style={{ fontSize: 10, color: fileColor(node.ext), flexShrink: 0, opacity: 0.8 }}>■</span>
        <span style={{
          fontSize: 11,
          color: isActive ? "#e2fde8" : isReferenced ? "#00ff6a" : "#5a8a6a",
          fontWeight: isReferenced ? 600 : 400,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          transition: "color 0.1s",
        }}>
          {node.name}
        </span>
        {isReferenced && (
          <span style={{ width: 4, height: 4, borderRadius: "50%", background: "#00ff6a", flexShrink: 0, marginLeft: "auto" }} />
        )}
      </div>
    );
  }

  return (
    <div>
      <div
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex", alignItems: "center", gap: 5,
          paddingLeft: indent + 4, paddingRight: 10,
          paddingTop: 3, paddingBottom: 3,
          cursor: "pointer",
        }}
        onMouseEnter={(e) => e.currentTarget.style.background = "#ffffff05"}
        onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
      >
        <span style={{ fontSize: 8, color: "#2a5a3a", width: 10, textAlign: "center" }}>
          {open ? "▾" : "▸"}
        </span>
        <span style={{
          fontSize: 11, fontWeight: 500,
          color: hasReferencedChild ? "#4aaa6a" : "#3a6a4a",
        }}>
          {node.name}/
        </span>
      </div>
      {open && entries.map((child) => (
        <TreeNodeComponent
          key={child.path}
          node={child}
          depth={depth + 1}
          referencedPaths={referencedPaths}
          onFileClick={onFileClick}
          activeFile={activeFile}
          defaultOpen={depth < 1}
        />
      ))}
    </div>
  );
}

export default function FileTree({ files, referencedPaths, onFileClick, activeFile }: Props) {
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    if (!filter) return files;
    const q = filter.toLowerCase();
    return files.filter((f) => f.toLowerCase().includes(q));
  }, [files, filter]);

  const tree = useMemo(() => buildTree(filtered), [filtered]);
  const entries = sortedEntries(tree.children);

  return (
    <div style={{
      display: "flex", flexDirection: "column", height: "100%",
      fontFamily: "'IBM Plex Mono', monospace",
      borderRight: "1px solid #1a3a24",
    }}>
      {/* Filter input */}
      <div style={{ padding: "8px 10px", borderBottom: "1px solid #1a3a24" }}>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter files…"
          style={{
            width: "100%", background: "#060d09",
            border: "1px solid #1a3a24", borderRadius: 5,
            padding: "5px 8px", fontSize: 11,
            color: "#5a8a6a", outline: "none",
            fontFamily: "'IBM Plex Mono', monospace",
          }}
          onFocus={(e) => e.currentTarget.style.borderColor = "#2a5a3a"}
          onBlur={(e) => e.currentTarget.style.borderColor = "#1a3a24"}
        />
      </div>

      {/* Tree */}
      <div style={{
        flex: 1, overflowY: "auto", paddingTop: 6, paddingBottom: 20,
        scrollbarWidth: "thin", scrollbarColor: "#1a3a24 transparent",
      }}>
        {entries.map((node) => (
          <TreeNodeComponent
            key={node.path}
            node={node}
            depth={0}
            referencedPaths={referencedPaths}
            onFileClick={onFileClick}
            activeFile={activeFile}
            defaultOpen={entries.length < 6}
          />
        ))}
        {filtered.length === 0 && (
          <div style={{ fontSize: 11, color: "#2a4a34", padding: "12px 16px" }}>
            no matches
          </div>
        )}
      </div>

      <div style={{
        padding: "8px 12px", borderTop: "1px solid #1a3a24",
        fontSize: 9, color: "#2a4a34", letterSpacing: "0.06em",
      }}>
        {files.length} files indexed
      </div>
    </div>
  );
}
