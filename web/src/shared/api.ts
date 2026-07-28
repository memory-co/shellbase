export class ApiError extends Error {
  constructor(
    public status: number,
    public error: string,
    message: string,
    public body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export async function api<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(path, {
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  if (res.status === 401) {
    window.top?.location.assign("/login");
    throw new ApiError(401, "unauthorized", "unauthorized");
  }
  if (!res.ok) {
    let body: Record<string, unknown> = {};
    try {
      body = await res.json();
    } catch {
      /* non-json error */
    }
    throw new ApiError(
      res.status,
      String(body.error ?? res.status),
      String(body.message ?? res.statusText),
      body,
    );
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  return (ct.includes("json") ? res.json() : res.text()) as Promise<T>;
}

export function wsUrl(path: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${path}`;
}

// ---- recents：前端本地，不跨设备（launcher.md §3.1） ----

export type Recent = { uri: string; last_opened: string; count: number };
const RECENTS_KEY = "shellbase.recents";
const RECENTS_MAX = 200;

export function loadRecents(): Recent[] {
  try {
    return JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function recordRecent(uri: string): void {
  const list = loadRecents().filter((r) => r.uri !== uri);
  const prev = loadRecents().find((r) => r.uri === uri);
  list.unshift({
    uri,
    last_opened: new Date().toISOString(),
    count: (prev?.count ?? 0) + 1,
  });
  localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, RECENTS_MAX)));
}

export function removeRecent(uri: string | null): void {
  if (uri === null) {
    localStorage.removeItem(RECENTS_KEY);
    return;
  }
  localStorage.setItem(
    RECENTS_KEY,
    JSON.stringify(loadRecents().filter((r) => r.uri !== uri)),
  );
}
