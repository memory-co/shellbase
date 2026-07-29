import {
  FileText,
  Globe,
  Search,
  Settings,
  Sparkles,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "@/index.css";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { loadRecents, removeRecent, type AppDef } from "@/lib/api";
import { AppProviders } from "@/lib/query";
import { useApps, useTerminals } from "@/lib/queries";
import { isTerminalUri, postToShell } from "@/lib/uri";

const params = new URLSearchParams(location.search);
const WID = params.get("window") ?? "main";
const LEAF = params.get("leaf") ?? "";

function open(uri: string) {
  postToShell({ shellbase: "open", leaf: LEAF, uri });
}

const ICON: Record<string, ReactNode> = {
  bash: <SquareTerminal />,
  file: <FileText />,
  https: <Globe />,
  claude: <Sparkles />,
  codex: <Sparkles />,
  settings: <Settings />,
};

function timeago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

function Launcher() {
  const { data: apps } = useApps();
  const { data: terminals } = useTerminals(WID);
  const [recents, setRecents] = useState(loadRecents);
  const [picking, setPicking] = useState<AppDef | null>(null);
  const [param, setParam] = useState("");
  const [direct, setDirect] = useState("");

  const aliveUris = useMemo(
    () =>
      new Set(
        (terminals ?? [])
          .filter((t) => t.status === "alive" && t.uri)
          .map((t) => t.uri!),
      ),
    [terminals],
  );

  const gridApps = [
    ...(apps ?? []),
    { scheme: "settings", type: "builtin", title: "设置" } as AppDef,
  ];

  const pick = (app: AppDef) => {
    setPicking(app);
    setParam(
      app.type === "terminal"
        ? "/workspace"
        : app.scheme === "file"
          ? "/workspace"
          : app.scheme === "settings"
            ? ""
            : "https://localhost:",
    );
  };

  const confirmPick = () => {
    if (!picking) return;
    const v = param.trim();
    if (picking.scheme === "settings") open("settings://");
    else if (picking.type === "terminal")
      open(`${picking.scheme}://${v || "/workspace"}`);
    else if (picking.scheme === "file") open(`file://${v || "/workspace"}`);
    else if (v) open(v);
    setPicking(null);
  };

  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col gap-6 overflow-auto p-6 scrollbar-thin">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="h-10 pl-9 font-mono"
          placeholder="URI 直达：bash:// · codex:///workspace/proj · file:///workspace · https://…"
          value={direct}
          onChange={(e) => setDirect(e.target.value)}
          onKeyDown={(e) =>
            e.key === "Enter" && direct.trim() && open(direct.trim())
          }
        />
      </div>

      <div>
        <Label className="mb-2 block">应用</Label>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-2">
          {gridApps.map((a) => (
            <button
              key={a.scheme}
              onClick={() => pick(a)}
              className="flex flex-col items-center gap-2 rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary/50 hover:bg-accent [&_svg]:h-6 [&_svg]:w-6 [&_svg]:text-primary"
            >
              {ICON[a.scheme] ?? <SquareTerminal />}
              <span className="text-sm font-medium">{a.title}</span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {a.scheme}://
              </span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center">
          <Label>最近使用</Label>
          <div className="flex-1" />
          {recents.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                removeRecent(null);
                setRecents([]);
              }}
            >
              <Trash2 className="h-3.5 w-3.5" /> 清空
            </Button>
          )}
        </div>
        <div className="flex flex-col gap-0.5">
          {recents.length === 0 && (
            <p className="text-sm text-muted-foreground">还没有记录</p>
          )}
          {recents.map((r) => (
            <div
              key={r.uri}
              className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent"
            >
              <button
                className="flex-1 truncate text-left font-mono text-xs hover:text-primary"
                onClick={() => open(r.uri)}
              >
                {r.uri}
              </button>
              {isTerminalUri(r.uri) && aliveUris.has(r.uri) && (
                <Tooltip>
                  <TooltipTrigger render={<Badge variant="success">存活</Badge>} />
                  <TooltipContent>现场仍在，点击即重入</TooltipContent>
                </Tooltip>
              )}
              <span className="text-xs text-muted-foreground">
                {timeago(r.last_opened)}
              </span>
              <button
                className="text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                onClick={() => {
                  removeRecent(r.uri);
                  setRecents(loadRecents());
                }}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>

      <Dialog open={!!picking} onOpenChange={(o) => !o && setPicking(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{picking?.title}</DialogTitle>
          </DialogHeader>
          {picking?.scheme !== "settings" && (
            <Input
              autoFocus
              className="font-mono"
              value={param}
              placeholder={picking?.type === "terminal" ? "工作目录" : "地址 / 路径"}
              onChange={(e) => setParam(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && confirmPick()}
            />
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPicking(null)}>
              取消
            </Button>
            <Button onClick={confirmPick}>打开</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <AppProviders>
    <Launcher />
  </AppProviders>,
);
