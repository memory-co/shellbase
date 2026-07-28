import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../shared/style.css";
import "./browser.css";
import { postToShell } from "../shared/uri";

const params = new URLSearchParams(location.search);
const LEAF = params.get("leaf") ?? "";
const START = params.get("url") ?? "";

/** localhost/127.0.0.1 → nginx 通配代理 /proxy/<port>/…（uri.md §3），其余直连 */
function toSrc(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
      const port = u.port || "80";
      return `/proxy/${port}${u.pathname}${u.search}`;
    }
    return raw;
  } catch {
    return raw;
  }
}

function normalize(input: string): string {
  const s = input.trim();
  if (!s) return s;
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s}`;
}

function BrowserApp() {
  const [addr, setAddr] = useState(START);
  const [current, setCurrent] = useState(START ? toSrc(START) : "");
  const hist = useRef<string[]>(START ? [START] : []);
  const pos = useRef(START ? 0 : -1);
  const [, force] = useState(0);

  const go = (raw: string, push = true) => {
    const url = normalize(raw);
    if (!url) return;
    setAddr(url);
    setCurrent(toSrc(url));
    if (push) {
      hist.current = hist.current.slice(0, pos.current + 1);
      hist.current.push(url);
      pos.current = hist.current.length - 1;
    }
    // 当前 URL 随布局树持久化（design.md §3.4）
    postToShell({ shellbase: "navigate", leaf: LEAF, uri: url });
    force((n) => n + 1);
  };

  const back = () => {
    if (pos.current > 0) {
      pos.current -= 1;
      go(hist.current[pos.current], false);
    }
  };
  const fwd = () => {
    if (pos.current < hist.current.length - 1) {
      pos.current += 1;
      go(hist.current[pos.current], false);
    }
  };

  return (
    <div className="browser">
      <div className="addrbar row">
        <button onClick={back} disabled={pos.current <= 0}>←</button>
        <button onClick={fwd} disabled={pos.current >= hist.current.length - 1}>→</button>
        <button onClick={() => current && setCurrent(toSrc(addr) + "")}>⟳</button>
        <input
          className="grow"
          value={addr}
          placeholder="https://localhost:5173 或任意网址"
          onChange={(e) => setAddr(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go(addr)}
        />
        <button onClick={() => go(addr)}>前往</button>
        {current && (
          <a href={normalize(addr)} target="_blank" rel="noreferrer" title="新窗口打开">
            ↗
          </a>
        )}
      </div>
      {current ? (
        <iframe src={current} sandbox="allow-scripts allow-same-origin allow-forms" />
      ) : (
        <div className="empty muted">
          输入地址开始浏览。localhost 地址走容器内代理；外部站点若拒绝被嵌入
          （X-Frame-Options），请用右上角"新窗口打开"。
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<BrowserApp />);
