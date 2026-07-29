import {
  Actions,
  DockLocation,
  Layout,
  type Action,
  type TabNode,
  type TabSetNode,
} from "flexlayout-react";
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
import { api, recordRecent } from "@/lib/api";
import { newTab } from "@/lib/flexmodel";
import { useWindowDoc, useWindowList } from "@/lib/queries";
import { useShell } from "@/lib/store";
import { isTerminalUri, type ShellMessage } from "@/lib/uri";
import { wsUrl } from "@/lib/api";
import { BlockFrame } from "./BlockFrame";

function widFromHash(): string {
  const m = location.hash.match(/^#w\/([a-z0-9-]{1,64})/);
  return m ? m[1] : "main";
}

function firstTabset(model: NonNullable<ReturnType<typeof useShell.getState>["model"]>) {
  let ts: TabSetNode | null = model.getActiveTabset() ?? null;
  if (!ts) {
    model.visitNodes((n) => {
      if (!ts && n.getType() === "tabset") ts = n as TabSetNode;
    });
  }
  return ts;
}

export function Shell() {
  const [wid, setWid] = useState(widFromHash);
  const { data: doc } = useWindowDoc(wid);
  const { data: windows } = useWindowList();
  const model = useShell((s) => s.model);
  const saving = useShell((s) => s.saving);

  // 初次加载 / 切换 window → 建 model；后续更新由 WS reconcile 驱动
  useEffect(() => {
    if (!doc) return;
    const s = useShell.getState();
    if (s.wid !== wid || !s.model) s.init(wid, doc.root, doc.version);
  }, [doc, wid]);

  useEffect(() => {
    const onHash = () => setWid(widFromHash());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  // deep link：#w/<wid>?open=<uri>
  const openConsumed = useRef(false);
  useEffect(() => {
    if (!model || openConsumed.current) return;
    const q = location.hash.split("?")[1];
    const uri = q ? new URLSearchParams(q).get("open") : null;
    if (!uri) return;
    openConsumed.current = true;
    history.replaceState(null, "", `#w/${wid}`);
    const ts = firstTabset(model);
    if (ts) {
      model.doAction(
        Actions.addNode(newTab(uri), ts.getId(), DockLocation.CENTER, -1, true),
      );
      recordRecent(uri);
      useShell.getState().save();
    }
  }, [model, wid]);

  // watch：版本广播 → 拉最新 reconcile（collab.md §3）
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
      if (ev.data.shellbase === "open") s.openInTab(ev.data.leaf, ev.data.uri);
      else if (ev.data.shellbase === "navigate")
        s.navigateTab(ev.data.leaf, ev.data.uri);
    };
    addEventListener("message", onMsg);
    return () => removeEventListener("message", onMsg);
  }, []);

  const factory = useCallback(
    (node: TabNode) => {
      const uri = (node.getConfig()?.uri ?? null) as string | null;
      return <BlockFrame wid={wid} tabId={node.getId()} uri={uri} />;
    },
    [wid],
  );

  // 关闭 tab 前：终端类块先销毁会话（关闭即销毁，backend.md §4.2）
  const onAction = useCallback(
    (action: Action): Action | undefined => {
      if (action.type === Actions.DELETE_TAB && model) {
        const node = model.getNodeById(action.data.node) as TabNode | undefined;
        const cfg = (node?.getConfig() ?? {}) as { uri?: string };
        const uri = cfg.uri;
        if (isTerminalUri(uri)) {
          const clients = 0;
          if (!confirm(`关闭并销毁会话？\n${uri}`)) return undefined;
          api(
            `/api/windows/${wid}/terminals?uri=${encodeURIComponent(uri!)}`,
            { method: "DELETE" },
          ).catch(() => {});
          void clients;
        }
      }
      return action;
    },
    [model, wid],
  );

  const addBlock = () => {
    if (!model) return;
    const ts = firstTabset(model);
    if (!ts) return;
    model.doAction(
      Actions.addNode(newTab(null), ts.getId(), DockLocation.CENTER, -1, true),
    );
    useShell.getState().save();
  };

  const newWindow = () => {
    const id = prompt("新 window 的 id（小写字母/数字/短横线）：");
    if (id && /^[a-z0-9-]{1,64}$/.test(id)) location.hash = `#w/${id}`;
    else if (id) alert("id 不合法");
  };

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
        <Button variant="secondary" size="sm" onClick={addBlock}>
          <Plus className="h-4 w-4" /> 新块
        </Button>
      </header>
      <div className="relative flex-1">
        {model && (
          <Layout
            model={model}
            factory={factory}
            onAction={onAction}
            onModelChange={() => useShell.getState().save()}
          />
        )}
      </div>
    </div>
  );
}
