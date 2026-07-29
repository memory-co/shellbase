import { createRoot } from "react-dom/client";
import "@/index.css";
import { AppProviders } from "@/lib/query";

const params = new URLSearchParams(location.search);
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

/**
 * 纯渲染：地址栏在 Shell 的面板控制条上，跳转即用新 url 重挂本页面（uri.md §3）。
 * 本应用只负责把 url 变成一个内层 iframe。
 */
function BrowserApp() {
  if (!START) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        在面板右上角展开地址栏，输入网址开始浏览。
        <br />
        localhost 地址走容器内代理；外部站点若拒绝被嵌入（X-Frame-Options），会显示空白。
      </div>
    );
  }
  return (
    <iframe
      src={toSrc(START)}
      title={START}
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
