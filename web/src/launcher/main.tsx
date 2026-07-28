import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "../shared/style.css";
import "./launcher.css";
import {
  api,
  loadRecents,
  removeRecent,
  type Recent,
} from "../shared/api";
import { isTerminalUri, postToShell } from "../shared/uri";

type App = {
  scheme: string;
  type: "terminal" | "builtin" | "url";
  title: string;
  cmd?: string | null;
  extra?: boolean;
};

const params = new URLSearchParams(location.search);
const WID = params.get("window") ?? "main";
const LEAF = params.get("leaf") ?? "";

function open(uri: string) {
  postToShell({ shellbase: "open", leaf: LEAF, uri });
}

const ICONS: Record<string, string> = {
  bash: ">_",
  file: "🗀",
  https: "🌐",
  claude: "✳",
  codex: "◆",
};

function Launcher() {
  const [apps, setApps] = useState<App[]>([]);
  const [recents, setRecents] = useState<Recent[]>(loadRecents);
  const [alive, setAlive] = useState<Set<string>>(new Set());
  const [picking, setPicking] = useState<App | null>(null);
  const [param, setParam] = useState("");
  const [direct, setDirect] = useState("");

  useEffect(() => {
    api<{ apps: App[] }>("/api/apps").then((r) => setApps(r.apps));
    api<{ terminals: { uri: string | null; status: string }[] }>(
      `/api/terminals?window=${WID}`,
    ).then((r) =>
      setAlive(
        new Set(
          r.terminals
            .filter((t) => t.status === "alive" && t.uri)
            .map((t) => t.uri!),
        ),
      ),
    );
  }, []);

  const isAlive = useMemo(
    () => (uri: string) => alive.has(uri) || alive.has(normalizeGuess(uri)),
    [alive],
  );

  const pick = (app: App) => {
    setPicking(app);
    setParam(
      app.type === "terminal" ? "/workspace"
      : app.scheme === "file" ? "/workspace"
      : "https://localhost:",
    );
  };

  const confirmPick = () => {
    if (!picking) return;
    const v = param.trim();
    if (picking.type === "terminal") open(`${picking.scheme}://${v || "/workspace"}`);
    else if (picking.scheme === "file") open(`file://${v || "/workspace"}`);
    else if (v) open(v);
    setPicking(null);
  };

  return (
    <div className="launcher">
      <div className="uribar row">
        <input
          className="grow"
          placeholder="URI 直达：bash:// · codex:///workspace/proj · file:///workspace · https://…"
          value={direct}
          onChange={(e) => setDirect(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && direct.trim() && open(direct.trim())}
        />
        <button onClick={() => direct.trim() && open(direct.trim())}>打开</button>
      </div>

      <div className="section-title">应用</div>
      <div className="grid">
        {apps.map((a) => (
          <button key={a.scheme} className="app" onClick={() => pick(a)}>
            <span className="app-icon">{ICONS[a.scheme] ?? "▣"}</span>
            <span>{a.title}</span>
            <span className="muted">{a.scheme}://</span>
          </button>
        ))}
      </div>

      {picking && (
        <div className="pickbar row">
          <span>{picking.title}</span>
          <input
            className="grow"
            autoFocus
            value={param}
            placeholder={picking.type === "terminal" ? "工作目录" : "地址 / 路径"}
            onChange={(e) => setParam(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && confirmPick()}
          />
          <button onClick={confirmPick}>打开</button>
          <button onClick={() => setPicking(null)}>取消</button>
        </div>
      )}

      <div className="section-title row">
        <span>最近使用</span>
        <span className="grow" />
        {recents.length > 0 && (
          <button
            onClick={() => {
              removeRecent(null);
              setRecents([]);
            }}
          >
            清空
          </button>
        )}
      </div>
      <div className="recents">
        {recents.length === 0 && <div className="muted">还没有记录</div>}
        {recents.map((r) => (
          <div key={r.uri} className="recent row">
            <button className="recent-uri grow" onClick={() => open(r.uri)}>
              {r.uri}
            </button>
            {isTerminalUri(r.uri) && isAlive(r.uri) && (
              <span className="dot" title="现场仍存活，点击即重入" />
            )}
            <span className="muted">{timeago(r.last_opened)}</span>
            <button
              onClick={() => {
                removeRecent(r.uri);
                setRecents(loadRecents());
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 粗略对齐后端规范化（bash:// ↔ bash:///workspace），仅用于存活圆点匹配 */
function normalizeGuess(uri: string): string {
  const m = uri.match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/i);
  if (!m) return uri;
  const [, scheme, rest] = m;
  const [pathPart, query] = rest.split("?");
  let path = pathPart.replace(/\/+$/, "");
  if (path && !path.startsWith("/")) path = "/" + path;
  if (!path) path = "/workspace";
  return `${scheme.toLowerCase()}://${path}${query ? "?" + query : ""}`;
}

function timeago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

createRoot(document.getElementById("root")!).render(<Launcher />);
