// 前端只做四类分流（uri.md §2）：本地服务 / 外部站点 / file / 其余未知 → 终端 attach。
// 前端不维护终端 scheme 名单。

export function isTerminalUri(uri: string | null | undefined): boolean {
  if (!uri) return false;
  return !/^(https?|file|settings):/i.test(uri);
}

/** 把块的虚拟 URI 解析为 iframe 的实际 src。tabKey 用于 postMessage 回指该块。 */
export function resolveUri(
  uri: string | null,
  wid: string,
  tabKey: string,
): string {
  if (!uri) {
    return `/apps/launcher?window=${encodeURIComponent(wid)}&leaf=${encodeURIComponent(tabKey)}`;
  }
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
  return `/api/windows/${encodeURIComponent(wid)}/terminals/attach?uri=${encodeURIComponent(uri)}`;
}

/** 块标题：从 URI 取一个短标签。 */
export function uriLabel(uri: string | null): string {
  if (!uri) return "启动页";
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

/** 终端类以外的 scheme 是否可在地址栏里编辑跳转。 */
export function isEditableUri(uri: string | null): boolean {
  return !uri || /^https?:/i.test(uri);
}

/** 地址栏输入 → URI：无 scheme 的按 https 补全。 */
export function normalizeInput(input: string): string {
  const s = input.trim();
  if (!s) return s;
  return /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
}
