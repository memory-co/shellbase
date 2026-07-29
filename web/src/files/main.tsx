import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, basicSetup } from "codemirror";
import {
  ChevronUp,
  Download,
  File as FileIcon,
  Folder,
  FolderPlus,
  Save,
  Trash2,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@/index.css";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { api, wsUrl, type FileEntry } from "@/lib/api";
import { AppProviders } from "@/lib/query";
import { postToShell } from "@/lib/uri";

const params = new URLSearchParams(location.search);
const LEAF = params.get("leaf") ?? "";
const START = params.get("path") ?? "/workspace";

function langFor(path: string) {
  if (/\.(ts|tsx|js|jsx|mjs)$/.test(path)) return [javascript({ typescript: true })];
  if (/\.py$/.test(path)) return [python()];
  if (/\.json$/.test(path)) return [json()];
  if (/\.(md|markdown)$/.test(path)) return [markdown()];
  return [];
}

function FilesApp() {
  const [dir, setDir] = useState(START);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [file, setFile] = useState<string | null>(null);
  const [mtime, setMtime] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);

  const refresh = useCallback(async (d: string) => {
    const r = await api<{ entries: FileEntry[] }>(
      `/api/files/tree?path=${encodeURIComponent(d)}`,
    );
    setEntries(r.entries);
  }, []);

  const enterDir = useCallback(
    (d: string) => {
      setDir(d);
      refresh(d).catch(() => toast.error("目录不可用"));
      postToShell({ shellbase: "navigate", leaf: LEAF, uri: `file://${d}` });
    },
    [refresh],
  );

  const openFile = useCallback(async (path: string) => {
    const res = await fetch(`/api/files/content?path=${encodeURIComponent(path)}`);
    if (!res.ok) return toast.error("打开失败");
    if ((res.headers.get("content-type") ?? "").includes("json")) {
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
    view.current?.destroy();
    view.current = new EditorView({
      doc: text,
      parent: host.current!,
      extensions: [
        basicSetup,
        oneDark,
        ...langFor(path),
        EditorView.theme({ "&": { height: "100%", fontSize: "12px" } }),
        EditorView.updateListener.of((u) => u.docChanged && setDirty(true)),
      ],
    });
  }, []);

  useEffect(() => {
    refresh(START).catch(() => {
      const parent = START.replace(/\/[^/]+$/, "") || "/workspace";
      setDir(parent);
      refresh(parent).catch(() => toast.error("路径不可用"));
      openFile(START);
    });
  }, [refresh, openFile]);

  // fs watch：目录变更实时刷新
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let pending: number | undefined;
    const connect = () => {
      ws = new WebSocket(wsUrl(`/api/files/watch?path=${encodeURIComponent(dir)}`));
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
      ws.onclose = () => !closed && setTimeout(connect, 3000);
    };
    connect();
    return () => {
      closed = true;
      ws?.close();
    };
  }, [dir, refresh]);

  const saveFile = useCallback(async () => {
    if (!file || !view.current) return;
    try {
      const r = await api<{ mtime: string }>("/api/files/content", {
        method: "PUT",
        body: JSON.stringify({
          path: file,
          content: view.current.state.doc.toString(),
          base_mtime: mtime,
        }),
      });
      setMtime(r.mtime);
      setDirty(false);
      toast.success("已保存");
    } catch (e) {
      const err = e as { error?: string };
      toast.error(
        err.error === "mtime_conflict" ? "保存冲突：文件已被终端修改" : "保存失败",
      );
    }
  }, [file, mtime]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        saveFile();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [saveFile]);

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    const fd = new FormData();
    fd.set("path", dir);
    for (const f of Array.from(list)) fd.append("files", f);
    await fetch("/api/files/upload", { method: "POST", body: fd });
    toast.success(`已上传 ${list.length} 个文件`);
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
    toast.success("已删除");
    refresh(dir);
  };

  const parent = dir.replace(/\/[^/]+$/, "") || "/";
  return (
    <div className="flex h-full bg-background">
      <aside className="flex w-64 flex-none flex-col border-r border-border">
        <div className="flex items-center gap-0.5 border-b border-border bg-card px-2 py-1.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button variant="ghost" size="icon-sm" onClick={() => enterDir(parent)}>
                  <ChevronUp className="h-4 w-4" />
                </Button>
              }
            />
            <TooltipContent>上一级</TooltipContent>
          </Tooltip>
          <Button variant="ghost" size="icon-sm" onClick={mkdir} title="新建目录">
            <FolderPlus className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            title="上传"
            render={
              <label>
                <Upload className="h-4 w-4" />
                <input
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => upload(e.target.files)}
                />
              </label>
            }
          />
          <Button
            variant="ghost"
            size="icon-sm"
            title="下载当前目录"
            render={
              <a href={`/api/files/download?path=${encodeURIComponent(dir)}`}>
                <Download className="h-4 w-4" />
              </a>
            }
          />
        </div>
        <div
          className="truncate border-b border-border px-2 py-1 font-mono text-[11px] text-muted-foreground"
          title={dir}
        >
          {dir}
        </div>
        <div className="flex-1 overflow-auto p-1 scrollbar-thin">
          {entries.map((e) => {
            const full = `${dir === "/" ? "" : dir}/${e.name}`;
            return (
              <div
                key={e.name}
                className="group flex items-center gap-1 rounded px-1.5 py-1 hover:bg-accent"
              >
                <button
                  className="flex flex-1 items-center gap-1.5 truncate text-left text-xs"
                  onClick={() => (e.type === "dir" ? enterDir(full) : openFile(full))}
                >
                  {e.type === "dir" ? (
                    <Folder className="h-3.5 w-3.5 shrink-0 text-primary" />
                  ) : (
                    <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate">{e.name}</span>
                </button>
                <button
                  className="text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
                  onClick={() => del(full, e.type === "dir")}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-1.5">
          <span className="flex-1 truncate font-mono text-xs text-muted-foreground">
            {file ?? "选择左侧文件开始编辑"}
            {dirty && <span className="ml-1 text-primary">●</span>}
          </span>
          <Button size="sm" onClick={saveFile} disabled={!file || !dirty}>
            <Save className="h-3.5 w-3.5" /> 保存
          </Button>
        </div>
        <div ref={host} className="min-h-0 flex-1 overflow-auto" />
      </section>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <AppProviders>
    <FilesApp />
  </AppProviders>,
);
