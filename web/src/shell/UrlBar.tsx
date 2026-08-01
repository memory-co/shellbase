import {
  FileText,
  Globe,
  Settings,
  Sparkles,
  SquareTerminal,
  X,
} from "lucide-react";
import * as React from "react";
import { loadRecents, removeRecent, type Recent } from "@/lib/api";
import { useApps } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { normalizeInput } from "@/lib/uri";

/**
 * Rich URL bar（urlbar.md）：一个输入框、两种下拉状态。
 * 聚焦未输入 → 应用宫格（最近使用的 scheme，注册表兜底）+ recents；
 * 开始输入 → 宫格消失，recents 就地变为 autocomplete。
 * 一切产出都是构造形态 URI，身份参数由 Shell 落位补全（永远新开）。
 */
export function UrlBar({
  variant,
  placeholder,
  autoFocus,
  onOpen,
  onFocusChange,
}: {
  variant: "blank" | "bar";
  placeholder?: string;
  autoFocus?: boolean;
  onOpen: (uri: string) => void;
  onFocusChange?: (focused: boolean) => void;
}) {
  const [text, setText] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(-1);
  const [recents, setRecents] = React.useState<Recent[]>([]);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const { data: apps } = useApps();

  const refresh = () => setRecents(loadRecents());

  // 宫格：recents 按 scheme 聚合取最近 10 个；毫无记录时退化到注册表（urlbar.md §2）
  const gridSchemes = React.useMemo(() => {
    const seen: string[] = [];
    for (const r of recents) {
      const s = r.uri.split(":")[0].toLowerCase();
      if (s && !seen.includes(s)) seen.push(s);
      if (seen.length >= 10) break;
    }
    if (seen.length) return seen;
    return [
      ...(apps ?? []).map((a) => a.scheme),
      "settings",
    ].filter((s, i, arr) => arr.indexOf(s) === i);
  }, [recents, apps]);

  const titles = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const a of apps ?? []) m.set(a.scheme, a.title);
    m.set("settings", "设置");
    return m;
  }, [apps]);

  // autocomplete：子串匹配（scheme、路径分段都参与）
  const matches = React.useMemo(() => {
    const q = text.trim().toLowerCase();
    if (!q) return [];
    return recents.filter((r) => r.uri.toLowerCase().includes(q)).slice(0, 8);
  }, [text, recents]);

  const typing = text.trim() !== "";

  const submit = (raw: string) => {
    const uri = normalizeInput(raw);
    if (!uri) return;
    setText("");
    setOpen(false);
    inputRef.current?.blur();
    onOpen(uri);
  };

  // 点宫格 = 预填该应用的 URI 模板，光标留在参数位，recents 随前缀过滤
  const pickScheme = (scheme: string) => {
    if (scheme === "settings") return submit("settings://");
    const prefill =
      scheme === "file"
        ? "file:///workspace"
        : scheme === "https" || scheme === "http"
          ? "https://localhost:"
          : `${scheme}:///workspace`;
    setText(prefill);
    setActive(-1);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, -1));
    } else if (e.key === "Enter") {
      const chosen = active >= 0 ? matches[active]?.uri : text;
      if (chosen?.trim()) submit(chosen);
    } else if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  const dropdown = open && (
    <div
      className={cn(
        "flex flex-col gap-3 overflow-auto p-3 scrollbar-thin",
        variant === "bar" &&
          "absolute inset-x-0 top-full z-30 mt-1 max-h-72 rounded-md border border-border bg-card shadow-lg",
      )}
      // 按下即选：抢在 input blur 之前处理
      onMouseDown={(e) => e.preventDefault()}
    >
      {!typing && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-1.5">
          {gridSchemes.map((s) => (
            <button
              key={s}
              onClick={() => pickScheme(s)}
              className="flex flex-col items-center gap-1 rounded-md border border-border bg-background p-2.5 transition-colors hover:border-primary/50 hover:bg-accent [&_svg]:h-5 [&_svg]:w-5 [&_svg]:text-primary"
            >
              {SCHEME_ICON[s] ?? <SquareTerminal />}
              <span className="max-w-full truncate font-mono text-[11px] text-muted-foreground">
                {titles.get(s) ?? `${s}://`}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-0.5">
        {(typing ? matches : recents.slice(0, 8)).map((r, i) => (
          <div
            key={r.uri}
            className={cn(
              "group flex items-center gap-2 rounded px-2 py-1 hover:bg-accent",
              typing && i === active && "bg-accent",
            )}
          >
            <button
              className="flex-1 truncate text-left font-mono text-xs"
              onClick={() => submit(r.uri)}
            >
              {r.uri}
            </button>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {timeago(r.last_opened)}
            </span>
            <button
              className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
              onClick={() => {
                removeRecent(r.uri);
                refresh();
              }}
              title="从最近使用中移除"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        {typing && matches.length === 0 && (
          <p className="px-2 py-1 text-xs text-muted-foreground">
            回车直接打开：{normalizeInput(text)}
          </p>
        )}
        {!typing && recents.length === 0 && (
          <p className="px-2 py-1 text-xs text-muted-foreground">
            还没有记录——直接输入 URI，或点上方应用
          </p>
        )}
      </div>
    </div>
  );

  return (
    <div className={cn("min-w-0", variant === "bar" ? "relative flex-1" : "w-full")}>
      <input
        ref={inputRef}
        autoFocus={autoFocus}
        className={cn(
          "w-full rounded border border-input bg-background font-mono outline-none focus:ring-1 focus:ring-ring",
          variant === "blank" ? "h-10 px-3 text-sm" : "h-7 px-2.5 text-[13px]",
        )}
        value={text}
        placeholder={
          placeholder ??
          "bash:// · codex:///workspace/proj · file:///workspace · https://…"
        }
        onChange={(e) => {
          setText(e.target.value);
          setActive(-1);
        }}
        onKeyDown={onKeyDown}
        onFocus={() => {
          refresh();
          setOpen(true);
          onFocusChange?.(true);
        }}
        onBlur={() => {
          setOpen(false);
          onFocusChange?.(false);
        }}
      />
      {dropdown}
    </div>
  );
}

const SCHEME_ICON: Record<string, React.ReactNode> = {
  bash: <SquareTerminal />,
  file: <FileText />,
  http: <Globe />,
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
