import { ChevronDown, Columns2, CornerDownLeft, RotateCw, Rows2, X } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";
import type { Panel } from "@/lib/grid";
import { isEditableUri, resolveUri, type AppCommand } from "@/lib/uri";

const HIDE_DELAY = 250;

/**
 * 一个网格面板：内容占满，控制条按需从顶部滑出覆盖在 iframe 上。
 * 常态只在右上角留一个小圆角方格作为触发点（design.md §3.6）。
 */
export const PanelView = React.memo(function PanelView({
  wid,
  panel,
  onSplit,
  onClose,
}: {
  wid: string;
  panel: Panel;
  onSplit: (dir: "row" | "col") => void;
  onClose: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState(panel.uri ?? "");
  const frame = React.useRef<HTMLIFrameElement>(null);
  const hideTimer = React.useRef<number | undefined>(undefined);
  const focused = React.useRef(false);
  const editable = isEditableUri(panel.uri);

  // 面板 URI 被外部改变（应用内导航、协作同步）时同步输入框
  React.useEffect(() => setDraft(panel.uri ?? ""), [panel.uri]);

  // 可编辑（浏览器）面板：iframe 只在首次挂载时用 uri 定 src，之后的跳转
  // 一律走 postMessage，避免地址栏输入把整个应用重新加载一遍。
  // 不可编辑（终端/文件等）面板：uri 就是身份，变了必须重挂。
  const initialSrc = React.useRef(resolveUri(panel.uri, wid, panel.id));
  const src = editable
    ? initialSrc.current
    : resolveUri(panel.uri, wid, panel.id);

  const post = (cmd: AppCommand) =>
    frame.current?.contentWindow?.postMessage(cmd, location.origin);

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

  const submit = () => {
    const url = draft.trim();
    if (!url || !editable) return;
    post({ shellbase: "go", url });
  };

  const reload = () => {
    if (editable && panel.uri) post({ shellbase: "reload" });
    else if (frame.current) frame.current.src = frame.current.src;
  };

  return (
    <div
      className="relative min-h-0 min-w-0 overflow-hidden rounded-md border border-border bg-background"
      style={{
        gridColumn: `${panel.x + 1} / span ${panel.w}`,
        gridRow: `${panel.y + 1} / span ${panel.h}`,
      }}
    >
      <iframe
        ref={frame}
        src={src}
        title={panel.uri ?? "launcher"}
        className="h-full w-full border-0 bg-background"
      />

      {/* 触发方格：常态右上角，展开后变为提交/收起 */}
      <button
        className={cn(
          "absolute right-1 top-1 z-20 flex h-[22px] w-[22px] items-center justify-center rounded-md border border-border/60 bg-card/70 text-muted-foreground backdrop-blur transition-all hover:bg-card hover:text-foreground",
          open && "border-border bg-card text-foreground",
        )}
        onMouseEnter={show}
        onMouseLeave={scheduleHide}
        onClick={() => (open && editable ? submit() : setOpen((v) => !v))}
        title={open ? (editable ? "跳转" : "收起") : "面板控制"}
      >
        {open ? (
          editable ? (
            <CornerDownLeft className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )
        ) : (
          <span className="block h-2 w-2 rounded-[3px] bg-current" />
        )}
      </button>

      {/* 控制条：覆盖在 iframe 上方，不挤压内容 */}
      <div
        className={cn(
          "absolute inset-x-0 top-0 z-10 flex h-8 items-center gap-1 border-b border-border bg-card/95 px-1.5 pr-8 backdrop-blur transition-all duration-150",
          open
            ? "translate-y-0 opacity-100"
            : "pointer-events-none -translate-y-full opacity-0",
        )}
        onMouseEnter={show}
        onMouseLeave={scheduleHide}
      >
        <button
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-destructive"
          onClick={onClose}
          title="关闭"
        >
          <X className="h-3.5 w-3.5" />
        </button>
        <button
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={reload}
          title="刷新"
        >
          <RotateCw className="h-3.5 w-3.5" />
        </button>

        <input
          className={cn(
            "h-6 min-w-0 flex-1 rounded border border-input bg-background px-2 font-mono text-[11px] outline-none focus:ring-1 focus:ring-ring",
            !editable && "cursor-default text-muted-foreground",
          )}
          value={draft}
          readOnly={!editable}
          placeholder={editable ? "输入网址回车跳转" : ""}
          onChange={(e) => editable && setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") {
              focused.current = false;
              setOpen(false);
            }
          }}
          onFocus={() => {
            focused.current = true;
            show();
          }}
          onBlur={() => {
            focused.current = false;
            scheduleHide();
          }}
        />

        <button
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => { setOpen(false); onSplit("col"); }}
          title="上下分割"
        >
          <Rows2 className="h-3.5 w-3.5" />
        </button>
        <button
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => { setOpen(false); onSplit("row"); }}
          title="左右分割"
        >
          <Columns2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
});
