import { useCallback, useEffect, useRef, useState } from "react";
import { api, recordRecent, wsUrl } from "../shared/api";
import { isTerminalUri, resolveUri, type ShellMessage } from "../shared/uri";
import {
  findLeaf,
  fromServer,
  mapTree,
  openInTree,
  removeLeaf,
  splitLeaf,
  toServer,
  type Leaf,
  type Node,
  type ServerNode,
  type Split,
} from "./tree";

type WindowDoc = {
  id: string;
  name: string;
  version: number;
  root: ServerNode;
};

function widFromHash(): string {
  const m = location.hash.match(/^#w\/([a-z0-9-]{1,64})/);
  return m ? m[1] : "main";
}

export function Shell() {
  const [wid, setWid] = useState(widFromHash);
  const [tree, setTree] = useState<Node | null>(null);
  const [windows, setWindows] = useState<{ id: string; name: string }[]>([]);
  const versionRef = useRef(0);
  const treeRef = useRef<Node | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  treeRef.current = tree;

  const load = useCallback(async (id: string, keepPrev: boolean) => {
    const doc = await api<WindowDoc>(`/api/windows/${id}`);
    versionRef.current = doc.version;
    setTree((prev) => fromServer(doc.root, id, keepPrev ? prev : null));
  }, []);

  // ---- 持久化：防抖 500ms 全量 PUT；409 → 拉最新（windows.md） ----
  const save = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      const t = treeRef.current;
      if (!t) return;
      try {
        const next = versionRef.current + 1;
        await api(`/api/windows/${wid}`, {
          method: "PUT",
          body: JSON.stringify({ version: next, root: toServer(t) }),
        });
        versionRef.current = next;
      } catch {
        load(wid, true);
      }
    }, 500);
  }, [wid, load]);

  // ---- 初始加载 / 切换 window ----
  useEffect(() => {
    load(wid, false);
    api<{ windows: { id: string; name: string }[] }>("/api/windows").then((r) =>
      setWindows(r.windows),
    );
  }, [wid, load]);

  // ---- deep link：#w/<wid>?open=<uri>（uri.md §5） ----
  const openConsumed = useRef(false);
  useEffect(() => {
    if (!tree || openConsumed.current) return;
    const q = location.hash.split("?")[1];
    const uri = q ? new URLSearchParams(q).get("open") : null;
    if (!uri) return;
    openConsumed.current = true;
    history.replaceState(null, "", `#w/${wid}`);
    recordRecent(uri);
    setTree((t) => (t ? openInTree(t, uri, wid) : t));
    save();
  }, [tree, wid, save]);

  useEffect(() => {
    const onHash = () => setWid(widFromHash());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  // ---- watch：版本广播，收到更新即拉新树（collab.md §3） ----
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let delay = 1000;
    const connect = () => {
      ws = new WebSocket(wsUrl(`/api/windows/${wid}/watch`));
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "ping") ws?.send(JSON.stringify({ type: "pong" }));
          if (msg.type === "window_updated" && msg.version > versionRef.current)
            load(wid, true);
          if (msg.type === "window_deleted") location.hash = "#w/main";
        } catch {
          /* ignore */
        }
      };
      ws.onopen = () => {
        delay = 1000;
      };
      ws.onclose = () => {
        if (!closed) setTimeout(connect, (delay = Math.min(delay * 2, 15000)));
      };
    };
    connect();
    return () => {
      closed = true;
      ws?.close();
    };
  }, [wid, load]);

  // ---- 应用块的 postMessage（open / navigate） ----
  useEffect(() => {
    const onMsg = (ev: MessageEvent<ShellMessage>) => {
      if (ev.origin !== location.origin || !ev.data?.shellbase) return;
      const { leaf, uri } = ev.data;
      if (ev.data.shellbase === "open") {
        recordRecent(uri);
        setTree((t) =>
          t
            ? mapTree(t, (n) =>
                n.type === "leaf" && n.id === leaf
                  ? { ...n, uri, src: resolveUri(uri, wid, n.id) }
                  : n,
              )
            : t,
        );
        save();
      } else if (ev.data.shellbase === "navigate") {
        // 只更新持久化的 uri，不动 iframe src（浏览器/文件应用自身在导航）
        setTree((t) =>
          t
            ? mapTree(t, (n) =>
                n.type === "leaf" && n.id === leaf ? { ...n, uri } : n,
              )
            : t,
        );
        save();
      }
    };
    addEventListener("message", onMsg);
    return () => removeEventListener("message", onMsg);
  }, [wid, save]);

  // ---- 块操作 ----
  const doSplit = (id: string, dir: "row" | "col") => {
    setTree((t) => (t ? splitLeaf(t, id, dir, wid) : t));
    save();
  };

  const doClose = async (id: string) => {
    const t = treeRef.current;
    const leaf = t && findLeaf(t, id);
    if (!leaf) return;
    if (isTerminalUri(leaf.uri)) {
      // 关闭即销毁（backend.md §4.2）
      if (!confirm(`关闭并销毁会话？\n${leaf.uri}`)) return;
      try {
        await api(
          `/api/windows/${wid}/terminals?uri=${encodeURIComponent(leaf.uri!)}`,
          { method: "DELETE" },
        );
      } catch {
        /* 已消亡也继续移除块 */
      }
    }
    setTree((cur) => (cur ? removeLeaf(cur, id, wid) : cur));
    save();
  };

  const setRatio = (id: string, ratio: number) => {
    setTree((t) =>
      t
        ? mapTree(t, (n) =>
            n.type === "split" && n.id === id
              ? { ...n, ratio: Math.min(0.9, Math.max(0.1, ratio)) }
              : n,
          )
        : t,
    );
  };

  const newWindow = () => {
    const id = prompt("新 window 的 id（小写字母/数字/短横线）：");
    if (id && /^[a-z0-9-]{1,64}$/.test(id)) location.hash = `#w/${id}`;
    else if (id) alert("id 不合法");
  };

  if (!tree) return <div className="shell-loading">加载中…</div>;
  return (
    <div className="shell">
      <div className="topbar row">
        <span className="brand">shellbase</span>
        <span className="muted">/#w/{wid}</span>
        <span className="grow" />
        <select
          value={wid}
          onChange={(e) => (location.hash = `#w/${e.target.value}`)}
        >
          {windows.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
          {windows.every((w) => w.id !== wid) && (
            <option value={wid}>{wid}</option>
          )}
        </select>
        <button onClick={newWindow}>+ window</button>
      </div>
      <div className="canvas">
        <TreeView
          node={tree}
          onSplit={doSplit}
          onClose={doClose}
          onRatio={setRatio}
          onRatioDone={save}
        />
      </div>
    </div>
  );
}

type TreeProps = {
  node: Node;
  onSplit: (id: string, dir: "row" | "col") => void;
  onClose: (id: string) => void;
  onRatio: (id: string, ratio: number) => void;
  onRatioDone: () => void;
};

function TreeView(props: TreeProps) {
  const { node } = props;
  if (node.type === "leaf") return <LeafView {...props} node={node} />;
  return <SplitView {...props} node={node} />;
}

function SplitView(props: TreeProps & { node: Split }) {
  const { node, onRatio, onRatioDone } = props;
  const ref = useRef<HTMLDivElement>(null);

  const startDrag = (ev: React.PointerEvent) => {
    ev.preventDefault();
    const el = ref.current!;
    const rect = el.getBoundingClientRect();
    const move = (e: PointerEvent) => {
      const ratio =
        node.dir === "row"
          ? (e.clientX - rect.left) / rect.width
          : (e.clientY - rect.top) / rect.height;
      onRatio(node.id, ratio);
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      onRatioDone();
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };

  return (
    <div ref={ref} className={`split ${node.dir}`}>
      <div className="pane" style={{ flexBasis: `${node.ratio * 100}%` }}>
        <TreeView {...props} node={node.children[0]} />
      </div>
      <div className={`divider ${node.dir}`} onPointerDown={startDrag} />
      <div className="pane" style={{ flexBasis: `${(1 - node.ratio) * 100}%` }}>
        <TreeView {...props} node={node.children[1]} />
      </div>
    </div>
  );
}

function LeafView(props: TreeProps & { node: Leaf }) {
  const { node, onSplit, onClose } = props;
  return (
    <div className="leaf">
      <div className="leaf-bar row">
        <span className="leaf-uri grow" title={node.uri ?? "启动页"}>
          {node.uri ?? "启动页"}
        </span>
        {node.uri && (
          <button
            title="复制定位符"
            onClick={() =>
              navigator.clipboard.writeText(
                `${location.origin}/#w/${widFromHash()}?open=${encodeURIComponent(node.uri!)}`,
              )
            }
          >
            ⧉
          </button>
        )}
        <button title="左右分割" onClick={() => onSplit(node.id, "row")}>
          ◫
        </button>
        <button title="上下分割" onClick={() => onSplit(node.id, "col")}>
          ⬓
        </button>
        <button title="关闭块" onClick={() => onClose(node.id)}>
          ✕
        </button>
      </div>
      <div className="leaf-body">
        <iframe key={node.id} src={node.src} title={node.uri ?? "launcher"} />
      </div>
    </div>
  );
}
