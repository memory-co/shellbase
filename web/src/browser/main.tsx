import { ArrowLeft, ArrowRight, ExternalLink, RotateCw } from "lucide-react";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@/index.css";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AppProviders } from "@/lib/query";
import { postToShell } from "@/lib/uri";

const params = new URLSearchParams(location.search);
const LEAF = params.get("leaf") ?? "";
const START = params.get("url") ?? "";

/** localhost/127.0.0.1 → nginx 通配代理 /proxy/<port>/…（uri.md §3），其余直连 */
function toSrc(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
      return `/proxy/${u.port || "80"}${u.pathname}${u.search}`;
    }
    return raw;
  } catch {
    return raw;
  }
}

function normalize(input: string): string {
  const s = input.trim();
  if (!s) return s;
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

function BrowserApp() {
  const [addr, setAddr] = useState(START);
  const [src, setSrc] = useState(START ? toSrc(START) : "");
  const hist = useRef<string[]>(START ? [START] : []);
  const pos = useRef(START ? 0 : -1);
  const [, force] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);

  const go = (raw: string, push = true) => {
    const url = normalize(raw);
    if (!url) return;
    setAddr(url);
    setSrc(toSrc(url));
    if (push) {
      hist.current = hist.current.slice(0, pos.current + 1);
      hist.current.push(url);
      pos.current = hist.current.length - 1;
    }
    postToShell({ shellbase: "navigate", leaf: LEAF, uri: url });
    force((n) => n + 1);
  };

  const back = () => pos.current > 0 && go(hist.current[--pos.current], false);
  const fwd = () =>
    pos.current < hist.current.length - 1 &&
    go(hist.current[++pos.current], false);

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex flex-none items-center gap-1 border-b border-border bg-card px-2 py-1.5">
        <Button variant="ghost" size="icon-sm" onClick={back} disabled={pos.current <= 0}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={fwd}
          disabled={pos.current >= hist.current.length - 1}
        >
          <ArrowRight className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => frame.current && (frame.current.src = src)}
          disabled={!src}
        >
          <RotateCw className="h-4 w-4" />
        </Button>
        <Input
          className="h-7 flex-1 font-mono text-xs"
          value={addr}
          placeholder="https://localhost:5173 或任意网址"
          onChange={(e) => setAddr(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go(addr)}
        />
        {src && (
          <Button
            variant="ghost"
            size="icon-sm"
            title="在新窗口打开"
            render={
              <a href={normalize(addr)} target="_blank" rel="noreferrer">
                <ExternalLink className="h-4 w-4" />
              </a>
            }
          />
        )}
      </div>
      {src ? (
        <iframe
          ref={frame}
          src={src}
          title="browser"
          className="flex-1 bg-white"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        />
      ) : (
        <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
          输入地址开始浏览。localhost 地址走容器内代理；外部站点若拒绝被嵌入（X-Frame-Options），请用右上角在新窗口打开。
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <AppProviders>
    <BrowserApp />
  </AppProviders>,
);
