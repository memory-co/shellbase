import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@/index.css";
import { AppProviders } from "@/lib/query";
import { onShellCommand, postToShell } from "@/lib/uri";

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

/** 地址栏在 Shell 的面板控制条上（统一地址栏）；本应用只负责渲染与跳转。 */
function BrowserApp() {
  const [src, setSrc] = useState(START ? toSrc(START) : "");
  const [addr, setAddr] = useState(START);
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(
    () =>
      onShellCommand((cmd) => {
        if (cmd.shellbase === "go") {
          const url = normalize(cmd.url);
          if (!url) return;
          setAddr(url);
          setSrc(toSrc(url));
          postToShell({ shellbase: "navigate", leaf: LEAF, uri: url });
        } else if (cmd.shellbase === "reload" && frame.current) {
          // 重设同一个 src 触发内页重载
          const cur = frame.current.src;
          frame.current.src = "about:blank";
          requestAnimationFrame(() => {
            if (frame.current) frame.current.src = cur;
          });
        }
      }),
    [],
  );

  if (!src) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        在面板右上角展开地址栏，输入网址开始浏览。
        <br />
        localhost 地址走容器内代理；外部站点若拒绝被嵌入（X-Frame-Options），
        会显示空白。
      </div>
    );
  }

  return (
    <iframe
      ref={frame}
      src={src}
      title={addr}
      className="h-full w-full border-0 bg-white"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <AppProviders>
    <BrowserApp />
  </AppProviders>,
);
