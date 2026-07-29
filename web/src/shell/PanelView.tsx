import { Columns2, Copy, Rows2, X } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Panel } from "@/lib/grid";
import { resolveUri, uriLabel } from "@/lib/uri";

/** 一个网格面板：顶部细工具条 + 装载块 URI 的 iframe。 */
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
  const src = resolveUri(panel.uri, wid, panel.id);
  return (
    <div
      className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md border border-border bg-background"
      style={{
        gridColumn: `${panel.x + 1} / span ${panel.w}`,
        gridRow: `${panel.y + 1} / span ${panel.h}`,
      }}
    >
      <div className="flex h-6 flex-none items-center gap-0.5 border-b border-border bg-card px-1.5">
        <span className="flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {uriLabel(panel.uri)}
        </span>
        {panel.uri && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="h-5 w-5 text-muted-foreground"
                  onClick={() =>
                    navigator.clipboard.writeText(
                      `${location.origin}/#w/${wid}?open=${encodeURIComponent(panel.uri!)}`,
                    )
                  }
                >
                  <Copy className="h-3 w-3" />
                </Button>
              }
            />
            <TooltipContent>复制定位符</TooltipContent>
          </Tooltip>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className="h-5 w-5 text-muted-foreground"
          title="左右分割"
          onClick={() => onSplit("row")}
        >
          <Columns2 className="h-3 w-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="h-5 w-5 text-muted-foreground"
          title="上下分割"
          onClick={() => onSplit("col")}
        >
          <Rows2 className="h-3 w-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="h-5 w-5 text-muted-foreground hover:text-destructive"
          title="关闭"
          onClick={onClose}
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
      <iframe
        src={src}
        title={panel.uri ?? "launcher"}
        className="min-h-0 flex-1 border-0 bg-background"
      />
    </div>
  );
});
