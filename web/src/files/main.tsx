import { EditorView, basicSetup } from "codemirror";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../shared/style.css";
import "./files.css";
import { api, wsUrl } from "../shared/api";
import { postToShell } from "../shared/uri";

type Entry = {
  name: string;
  type: "dir" | "file";
  size: number | null;
  mtime: string;
};

const params = new URLSearchParams(location.search);
const LEAF = params.get("leaf") ?? "";
const START = params.get("path") ?? "/workspace";

function FilesApp() {
  const [dir, setDir] = useState(START);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [file, setFile] = useState<string | null>(null);
  const [mtime, setMtime] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("");
  const editorHost = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  const refresh = useCallback(async (d: string) => {
    const r = await api<{ entries: Entry[] }>(
      `/api/files/tree?path=${encodeURIComponent(d)}`,
    );
    setEntries(r.entries);
  }, []);

  const enterDir = useCallback(
    (d: string) => {
      setDir(d);
      refresh(d).catch((e) => setStatus(String(e.message)));
      postToShell({ shellbase: "navigate", leaf: LEAF, uri: `file://${d}` });
    },
    [refresh],
  );

  useEffect(() => {
    // 起始 path 可能直接是文件：进入父目录并打开它
    (async () => {
      try {
        await refresh(START);
      } catch {
        const parent = START.replace(/\/[^/]+$/, "") || "/workspace";
        setDir(parent);
        await refresh(parent).catch(() => setStatus("路径不可用"));
        openFile(START);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 文件变更推送 → 刷新当前目录（files.md watch）
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    const connect = () => {
      ws = new WebSocket(
        wsUrl(`/api/files/watch?path=${encodeURIComponent(dir)}`),
      );
      let pending: number | undefined;
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.type === "ping") ws?.send(JSON.stringify({ type: "pong" }));
          if (m.type === "fs") {
            clearTimeout(pending);
            pending = window.setTimeout(() => refresh(dir).catch(() => {}), 300);
          }
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        if (!closed) setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      closed = true;
      ws?.close();
    };
  }, [dir, refresh]);

  const openFile = async (path: string) => {
    const res = await fetch(`/api/files/content?path=${encodeURIComponent(path)}`);
    if (!res.ok) {
      setStatus("打开失败");
      return;
    }
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("json")) {
      const meta = await res.json();
      if (meta.binary) {
        location.assign(`/api/files/download?path=${encodeURIComponent(path)}`);
        return;
      }
    }
    const text = await res.text();
    setFile(path);
    setMtime(res.headers.get("X-File-Mtime"));
    setDirty(false);
    viewRef.current?.destroy();
    viewRef.current = new EditorView({
      doc: text,
      parent: editorHost.current!,
      extensions: [
        basicSetup,
        EditorView.darkTheme.of(true),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) setDirty(true);
        }),
      ],
    });
  };

  const saveFile = async () => {
    if (!file || !viewRef.current) return;
    try {
      const r = await api<{ mtime: string }>("/api/files/content", {
        method: "PUT",
        body: JSON.stringify({
          path: file,
          content: viewRef.current.state.doc.toString(),
          base_mtime: mtime,
        }),
      });
      setMtime(r.mtime);
      setDirty(false);
      setStatus("已保存");
    } catch (e: unknown) {
      const err = e as { error?: string };
      setStatus(
        err.error === "mtime_conflict"
          ? "保存冲突：文件已被终端修改，请另存或重新打开"
          : "保存失败",
      );
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        saveFile();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    const fd = new FormData();
    fd.set("path", dir);
    for (const f of Array.from(list)) fd.append("files", f);
    await fetch("/api/files/upload", { method: "POST", body: fd });
    refresh(dir);
  };

  const mkdir = async () => {
    const name = prompt("新目录名：");
    if (!name) return;
    await api("/api/files/mkdir", {
      method: "POST",
      body: JSON.stringify({ path: `${dir}/${name}` }),
    });
    refresh(dir);
  };

  const del = async (path: string, isDir: boolean) => {
    if (!confirm(`删除 ${path}？`)) return;
    await api("/api/files/delete", {
      method: "POST",
      body: JSON.stringify({ path, recursive: isDir }),
    });
    refresh(dir);
  };

  const parent = dir.replace(/\/[^/]+$/, "") || "/";
  return (
    <div className="files">
      <div className="sidebar">
        <div className="toolbar row">
          <button onClick={() => enterDir(parent)} title="上一级">↑</button>
          <button onClick={mkdir} title="新建目录">+📁</button>
          <label className="upload" title="上传">
            ⇪<input type="file" multiple onChange={(e) => upload(e.target.files)} />
          </label>
          <a
            className="dl"
            href={`/api/files/download?path=${encodeURIComponent(dir)}`}
            title="下载当前目录 zip"
          >
            ⇩
          </a>
        </div>
        <div className="cwd muted" title={dir}>{dir}</div>
        <div className="list">
          {entries.map((e) => {
            const full = `${dir === "/" ? "" : dir}/${e.name}`;
            return (
              <div key={e.name} className="entry row">
                <button
                  className="entry-name grow"
                  onClick={() => (e.type === "dir" ? enterDir(full) : openFile(full))}
                >
                  {e.type === "dir" ? "🗀" : "🗎"} {e.name}
                </button>
                {e.type === "file" && (
                  <a href={`/api/files/download?path=${encodeURIComponent(full)}`}>⇩</a>
                )}
                <button onClick={() => del(full, e.type === "dir")}>✕</button>
              </div>
            );
          })}
        </div>
      </div>
      <div className="editor-pane">
        <div className="toolbar row">
          <span className="grow muted">
            {file ?? "选择左侧文件开始编辑"}
            {dirty ? " ●" : ""}
          </span>
          <span className="muted">{status}</span>
          <button onClick={saveFile} disabled={!file}>保存 (⌘S)</button>
        </div>
        <div ref={editorHost} className="editor" />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<FilesApp />);
