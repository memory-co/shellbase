import { ChevronDown, Columns2, RotateCw, Rows2, X } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";
import type { Panel } from "@/lib/grid";
import { deleteTerminal } from "@/lib/queries";
import { useShell } from "@/lib/store";
import { constructForm, isTerminalUri, resolveUri } from "@/lib/uri";
import { UrlBar } from "./UrlBar";

const HIDE_DELAY = 250;

/**
 * 一个网格面板：内容占满，控制条按需从顶部滑出覆盖在 iframe 上。
 * 常态只在右上角留一个小圆角方格作为触发点（design.md §3.6）。
 * 空白面板（uri = null）不装 iframe，直接渲染居中的 rich URL bar（urlbar.md §1）。
 */
export const PanelView = React.memo(function PanelView({
  panel,
  onSplit,
  onClose,
}: {
  panel: Panel;
  onSplit: (dir: "row" | "col") => void;
  onClose: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const frame = React.useRef<HTMLIFrameElement>(null);
  const hideTimer = React.useRef<number | undefined>(undefined);
  const focused = React.useRef(false);

  // src 由 (uri, reloadKey) 决定：uri 变（地址栏跳转）或刷新都重挂 iframe。
  const [reloadKey, setReloadKey] = React.useState(0);
  const src = React.useMemo(
    () => (panel.uri ? resolveUri(panel.uri, panel.id) : null),
    // reloadKey 参与依赖以强制重算/重挂
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [panel.uri, panel.id, reloadKey],
  );

  const show = () => {
    window.clearTimeout(hideTimer.current);
    setOpen(true);
  };
  // 离开 bar/方格即收起（输入框聚焦时例外，失焦后再收）
  const scheduleHide = () => {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (!focused.current) setOpen(false);
    }, HIDE_DELAY);
  };

  // URL bar 确认：终端块换 URI = 销毁重建，先确认再注销旧现场（urlbar.md §2.1）
  const openUri = (uri: string) => {
    if (isTerminalUri(panel.uri)) {
      if (
        !confirm(
          `当前终端现场将被销毁重建，内容会丢失：\n${panel.uri}\n确认继续？`,
        )
      )
        return;
      deleteTerminal(panel.uri!).catch(() => {});
    }
    setOpen(false);
    useShell.getState().setUri(panel.id, uri);
  };

  const onBarFocus = (f: boolean) => {
    focused.current = f;
    if (f) show();
    else scheduleHide();
  };

  const reload = () => setReloadKey((k) => k + 1);

  return (
    <div
      className="relative min-h-0 min-w-0 overflow-hidden rounded-md border border-border bg-background"
      style={{
        gridColumn: `${panel.x + 1} / span ${panel.w}`,
        gridRow: `${panel.y + 1} / span ${panel.h}`,
      }}
    >
      {src ? (
        <iframe
          ref={frame}
          src={src}
          title={panel.uri ?? "blank"}
          className="h-full w-full border-0 bg-background"
        />
      ) : (
        /* 空白面板 = 一条自动聚焦的 rich URL bar，就是块的全部内容 */
        <div className="flex h-full items-start justify-center overflow-auto p-6 pt-[18vh] scrollbar-thin">
          <div className="w-full max-w-xl">
            <UrlBar variant="blank" autoFocus onOpen={openUri} />
          </div>
        </div>
      )}

      {/* 触发方格：常态右上角，展开后变为收起 */}
      <button
        className={cn(
          "absolute right-1.5 top-1.5 z-20 flex h-7 w-7 items-center justify-center rounded-md border border-border/60 bg-card/70 text-muted-foreground backdrop-blur transition-all hover:bg-card hover:text-foreground",
          open && "border-border bg-card text-foreground",
        )}
        onMouseEnter={show}
        onMouseLeave={scheduleHide}
        onClick={() => setOpen((v) => !v)}
        title={open ? "收起" : "面板控制"}
      >
        {open ? (
          <ChevronDown className="h-4 w-4" />
        ) : (
          <span className="block h-[11px] w-[11px] rounded-[3px] bg-current" />
        )}
      </button>

      {/* 悬停缓冲区：bar 下方再延伸一个 bar 高度，避免横向移动时轻微下滑就误收 */}
      {open && (
        <div
          className="absolute inset-x-0 top-10 z-10 h-10"
          onMouseEnter={show}
          onMouseLeave={scheduleHide}
        />
      )}

      {/* 控制条：覆盖在 iframe 上方，不挤压内容 */}
      <div
        className={cn(
          "absolute inset-x-0 top-0 z-10 flex h-10 items-center gap-1 border-b border-border bg-card/95 px-2 pr-10 backdrop-blur transition-all duration-150",
          open
            ? "translate-y-0 opacity-100"
            : "pointer-events-none -translate-y-full opacity-0",
        )}
        onMouseEnter={show}
        onMouseLeave={scheduleHide}
      >
        <button
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-destructive"
          onClick={onClose}
          title="关闭"
        >
          <X className="h-4 w-4" />
        </button>
        <button
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={reload}
          title="刷新"
        >
          <RotateCw className="h-4 w-4" />
        </button>

        {/* 统一地址栏 = rich URL bar；placeholder 展示当前 URI 的构造形态 */}
        <UrlBar
          variant="bar"
          placeholder={panel.uri ? constructForm(panel.uri) : undefined}
          onOpen={openUri}
          onFocusChange={onBarFocus}
        />

        <button
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => { setOpen(false); onSplit("col"); }}
          title="上下分割"
        >
          <Rows2 className="h-4 w-4" />
        </button>
        <button
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => { setOpen(false); onSplit("row"); }}
          title="左右分割"
        >
          <Columns2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
});
