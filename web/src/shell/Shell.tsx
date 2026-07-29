import { LayoutGrid, Loader2, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api, recordRecent, wsUrl } from "@/lib/api";
import { COLS, ROWS, newId, type Panel } from "@/lib/grid";
import { useWindowList } from "@/lib/queries";
import { useShell } from "@/lib/store";
import { type ShellMessage } from "@/lib/uri";
import { PanelView } from "./PanelView";
import { Dividers } from "./Dividers";

function widFromHash(): string {
  const m = location.hash.match(/^#w\/([a-z0-9-]{1,64})/);
  return m ? m[1] : "main";
}

export function Shell() {
  const [wid, setWid] = useState(widFromHash);
  const { data: windows } = useWindowList();
  const grid = useShell((s) => s.grid);
  const saving = useShell((s) => s.saving);
  const canvas = useRef<HTMLDivElement>(null);

  // 加载 / 切换 window
  useEffect(() => {
    let cancelled = false;
    api<{ version: number; root: unknown }>(`/api/windows/${wid}`).then((doc) => {
      if (!cancelled) useShell.getState().init(wid, doc.root, doc.version);
    });
    return () => {
      cancelled = true;
    };
  }, [wid]);

  useEffect(() => {
    const onHash = () => setWid(widFromHash());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  // deep link：#w/<wid>?open=<uri> —— 分割第一个面板并装载
  const openConsumed = useRef(false);
  useEffect(() => {
    if (openConsumed.current) return;
    const q = location.hash.split("?")[1];
    const uri = q ? new URLSearchParams(q).get("open") : null;
    if (!uri) return;
    const s = useShell.getState();
    if (!s.grid.panels.length) return;
    openConsumed.current = true;
    history.replaceState(null, "", `#w/${wid}`);
    const first = s.grid.panels[0];
    s.split(first.id, "row");
    // 分割后新面板是最后一个，装载 uri
    const after = useShell.getState().grid.panels;
    const created = after[after.length - 1];
    if (created) s.setUri(created.id, uri);
  }, [wid]);

  // watch：版本广播 → 拉最新 reconcile
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let delay = 1000;
    const connect = () => {
      ws = new WebSocket(wsUrl(`/api/windows/${wid}/watch`));
      ws.onmessage = async (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "ping") ws?.send(JSON.stringify({ type: "pong" }));
          if (msg.type === "window_updated") {
            const s = useShell.getState();
            if (msg.version > s.version) {
              const d = await api<{ version: number; root: unknown }>(
                `/api/windows/${wid}`,
              );
              s.reconcile(d.root, d.version);
            }
          }
          if (msg.type === "window_deleted") location.hash = "#w/main";
        } catch {
          /* ignore */
        }
      };
      ws.onopen = () => (delay = 1000);
      ws.onclose = () => {
        if (!closed) setTimeout(connect, (delay = Math.min(delay * 2, 15000)));
      };
    };
    connect();
    return () => {
      closed = true;
      ws?.close();
    };
  }, [wid]);

  // 应用块 postMessage：open（启动页选定）/ navigate（应用内导航）
  useEffect(() => {
    const onMsg = (ev: MessageEvent<ShellMessage>) => {
      if (ev.origin !== location.origin || !ev.data?.shellbase) return;
      const s = useShell.getState();
      if (ev.data.shellbase === "open") s.setUri(ev.data.leaf, ev.data.uri);
      else if (ev.data.shellbase === "navigate")
        s.navigate(ev.data.leaf, ev.data.uri);
    };
    addEventListener("message", onMsg);
    return () => removeEventListener("message", onMsg);
  }, []);

  const newWindow = () => {
    const id = prompt("新 window 的 id（小写字母/数字/短横线）：");
    if (id && /^[a-z0-9-]{1,64}$/.test(id)) location.hash = `#w/${id}`;
    else if (id) alert("id 不合法");
  };

  const close = useCallback(async (panel: Panel) => {
    if (panel.uri && !/^(https?|file|settings):/i.test(panel.uri)) {
      if (!confirm(`关闭并销毁会话？\n${panel.uri}`)) return;
      api(
        `/api/windows/${wid}/terminals?uri=${encodeURIComponent(panel.uri)}`,
        { method: "DELETE" },
      ).catch(() => {});
    }
    useShell.getState().close(panel.id);
  }, [wid]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-10 flex-none items-center gap-2 border-b border-border bg-card px-3">
        <span className="flex items-center gap-1.5 font-semibold">
          <LayoutGrid className="h-4 w-4 text-primary" />
          shellbase
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="sm" className="font-mono text-xs">
                #{wid}
              </Button>
            }
          />
          <DropdownMenuContent>
            {(windows ?? []).map((w) => (
              <DropdownMenuItem
                key={w.id}
                onClick={() => (location.hash = `#w/${w.id}`)}
              >
                <span className="font-mono">{w.name}</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {w.blocks}
                </span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={newWindow}>
              <Plus /> 新建 window
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex-1" />
        {saving && (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        )}
      </header>

      <div
        ref={canvas}
        className="relative grid flex-1 gap-0.5 p-0.5"
        style={{
          gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${ROWS}, minmax(0, 1fr))`,
        }}
      >
        {grid.panels.map((p) => (
          <PanelView
            key={p.id}
            wid={wid}
            panel={p}
            onSplit={(dir) => useShell.getState().split(p.id, dir)}
            onClose={() => close(p)}
          />
        ))}
        <Dividers grid={grid} container={canvas} />
      </div>
    </div>
  );
}
