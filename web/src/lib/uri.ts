// 前端只做四类分流（uri.md §2）：本地服务 / 外部站点 / file / 其余未知 → 终端 attach。
// 前端不维护终端 scheme 名单。
// 终端类 URI 的身份参数（?window=&block=）由 Shell 落位补全，用户输入一律剥离重写
// （uri.md §4、urlbar.md §2.2）。

export function isTerminalUri(uri: string | null | undefined): boolean {
  if (!uri) return false;
  return !/^(https?|file|settings):/i.test(uri);
}

export type TerminalParts = {
  scheme: string;
  path: string;
  window?: string;
  block?: number;
};

/** 解析终端类 URI（scheme 小写、path 去尾斜杠、缺省 /workspace）；非终端返回 null。 */
export function parseTerminal(uri: string): TerminalParts | null {
  if (!isTerminalUri(uri)) return null;
  const m = uri.match(/^([a-z][a-z0-9+.-]*):\/\/([^?]*)(?:\?(.*))?$/i);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  let path = m[2] || "";
  if (path && !path.startsWith("/")) path = "/" + path;
  path = path.replace(/\/+$/, "") || "/workspace";
  const q = new URLSearchParams(m[3] ?? "");
  const window = q.get("window") ?? undefined;
  const blockRaw = q.get("block");
  const block = blockRaw && /^\d+$/.test(blockRaw) ? Number(blockRaw) : undefined;
  return { scheme, path, window, block };
}

/** 剥离身份参数 → 构造形态（recents 存储、宫格聚合、地址栏展示都用它）。 */
export function constructForm(uri: string): string {
  const t = parseTerminal(uri);
  return t ? `${t.scheme}://${t.path}` : uri;
}

/**
 * 落位补全 → 完整形态：window = 当前 window，block = 同 window 同 scheme+path 的
 * 最小空闲号（otherUris 为布局中其余面板的 URI）。用户手填的身份参数在此被覆盖。
 */
export function completeIdentity(
  uri: string,
  wid: string,
  otherUris: (string | null)[],
): string {
  const t = parseTerminal(uri);
  if (!t) return uri;
  const used = new Set<number>();
  for (const u of otherUris) {
    if (!u) continue;
    const o = parseTerminal(u);
    if (o?.block && o.window === wid && o.scheme === t.scheme && o.path === t.path)
      used.add(o.block);
  }
  let block = 1;
  while (used.has(block)) block++;
  return `${t.scheme}://${t.path}?window=${encodeURIComponent(wid)}&block=${block}`;
}

/** 把块的虚拟 URI 解析为 iframe 的实际 src。tabKey 用于 postMessage 回指该块。 */
export function resolveUri(uri: string, tabKey: string): string {
  if (/^https?:/i.test(uri)) {
    return `/apps/browser?leaf=${encodeURIComponent(tabKey)}&url=${encodeURIComponent(uri)}`;
  }
  if (/^file:/i.test(uri)) {
    let path = "/workspace";
    try {
      const u = new URL(uri);
      path = decodeURIComponent(u.pathname) || "/workspace";
      if (u.hostname) path = "/" + u.hostname + path;
    } catch {
      /* fall through */
    }
    return `/apps/files?leaf=${encodeURIComponent(tabKey)}&path=${encodeURIComponent(path)}`;
  }
  if (/^settings:/i.test(uri)) {
    return `/apps/settings?leaf=${encodeURIComponent(tabKey)}`;
  }
  // 其余一切（未知 scheme）盲转发给 terminals API，由后端裁决
  return `/api/terminals/attach?uri=${encodeURIComponent(uri)}`;
}

/** 块标题：从 URI 取一个短标签。 */
export function uriLabel(uri: string | null): string {
  if (!uri) return "空白";
  const m = uri.match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/i);
  if (!m) return uri;
  const [, scheme, rest] = m;
  if (/^https?$/i.test(scheme)) {
    try {
      return new URL(uri).host || uri;
    } catch {
      return uri;
    }
  }
  if (/^settings$/i.test(scheme)) return "设置";
  const path = rest.split("?")[0].replace(/\/+$/, "");
  const base = path.split("/").filter(Boolean).pop();
  return base ? `${scheme}: ${base}` : `${scheme}://`;
}

/** 应用 → Shell：块内产生了新 URI。 */
export type ShellMessage =
  | { shellbase: "open"; leaf: string; uri: string }
  | { shellbase: "navigate"; leaf: string; uri: string };

export function postToShell(msg: ShellMessage): void {
  window.parent.postMessage(msg, location.origin);
}

/** 地址栏输入 → URI：无 scheme 的按 https 补全。 */
export function normalizeInput(input: string): string {
  const s = input.trim();
  if (!s) return s;
  return /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
}
