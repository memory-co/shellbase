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

// ---- 类型（对齐 docs/v1/api） ----

export type WindowSummary = {
  id: string;
  name: string;
  updated_at: string;
  blocks: number;
};

export type WindowDoc = {
  id: string;
  name: string;
  version: number;
  updated_at: string;
  root: unknown; // FlexLayout IJsonModel
};

export type Terminal = {
  window: string | null;
  uri: string | null;
  kind: "plain" | "agent" | "external";
  cwd: string | null;
  cmd: string | null;
  status: "alive" | "exited";
  created_at: string | null;
  last_attached: string | null;
  clients: number;
};

export type AppDef = {
  scheme: string;
  type: "terminal" | "builtin" | "url";
  title: string;
  cmd?: string | null;
  extra?: boolean;
};

export type FileEntry = {
  name: string;
  type: "dir" | "file";
  size: number | null;
  mtime: string;
  mode?: string;
  children?: FileEntry[] | null;
};

export type EnvVar = { preview: string; length: number };
export type EnvDoc = { updated_at: string; vars: Record<string, EnvVar> };

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
  const prev = loadRecents().find((r) => r.uri === uri);
  const list = loadRecents().filter((r) => r.uri !== uri);
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
