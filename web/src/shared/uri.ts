// 前端只做四类分流（uri.md §2）：本地服务 / 外部站点 / file / 其余未知 → 终端 attach。
// 前端不维护终端 scheme 名单。

export function isTerminalUri(uri: string | null): boolean {
  if (!uri) return false;
  return !/^(https?|file):/i.test(uri);
}

export function resolveUri(uri: string | null, wid: string, leaf: string): string {
  if (!uri) {
    return `/apps/launcher?window=${encodeURIComponent(wid)}&leaf=${encodeURIComponent(leaf)}`;
  }
  if (/^https?:/i.test(uri)) {
    return `/apps/browser?leaf=${encodeURIComponent(leaf)}&url=${encodeURIComponent(uri)}`;
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
    return `/apps/files?leaf=${encodeURIComponent(leaf)}&path=${encodeURIComponent(path)}`;
  }
  // 其余一切（未知 scheme）盲转发给 terminals API，由后端裁决
  return `/api/windows/${encodeURIComponent(wid)}/terminals/attach?uri=${encodeURIComponent(uri)}`;
}

export type ShellMessage =
  | { shellbase: "open"; leaf: string; uri: string }
  | { shellbase: "navigate"; leaf: string; uri: string };

export function postToShell(msg: ShellMessage): void {
  window.parent.postMessage(msg, location.origin);
}
