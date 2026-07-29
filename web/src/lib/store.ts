import { Actions, Model } from "flexlayout-react";
import type { IJsonModel } from "flexlayout-react";
import { create } from "zustand";
import { api, recordRecent } from "./api";
import { normalizeModel } from "./flexmodel";
import { uriLabel } from "./uri";

// Shell 布局状态归 Zustand；读（windows/terminals/apps）走 TanStack Query。
// 保存：防抖全量 PUT，version 单调递增，409/失败时拉最新覆盖（windows.md §4.2）。

type ShellState = {
  wid: string;
  version: number;
  model: Model | null;
  /** 浏览器/文件应用内部导航的旁路 uri：不重载 iframe，仅影响持久化。 */
  overrides: Record<string, string>;
  saving: boolean;

  init: (wid: string, root: unknown, version: number) => void;
  reconcile: (root: unknown, version: number) => void;
  openInTab: (tabId: string, uri: string) => void;
  navigateTab: (tabId: string, uri: string) => void;
  toJson: () => IJsonModel;
  save: () => void;
};

let saveTimer: number | undefined;

function applyOverrides(json: IJsonModel, overrides: Record<string, string>) {
  const walk = (node: unknown) => {
    const n = node as {
      type?: string;
      id?: string;
      config?: { uri?: string | null };
      children?: unknown[];
    };
    if (n.type === "tab" && n.id && overrides[n.id] !== undefined) {
      n.config = { ...(n.config ?? {}), uri: overrides[n.id] };
    }
    n.children?.forEach(walk);
  };
  walk(json.layout);
  (json.borders ?? []).forEach((b) =>
    (b as { children?: unknown[] }).children?.forEach(walk),
  );
  return json;
}

export const useShell = create<ShellState>((set, get) => ({
  wid: "main",
  version: 0,
  model: null,
  overrides: {},
  saving: false,

  init: (wid, root, version) =>
    set({
      wid,
      model: Model.fromJson(normalizeModel(root)),
      version,
      overrides: {},
    }),

  reconcile: (root, version) => {
    if (version <= get().version) return;
    set({ model: Model.fromJson(normalizeModel(root)), version, overrides: {} });
  },

  openInTab: (tabId, uri) => {
    const { model, overrides } = get();
    if (!model) return;
    const rest = { ...overrides };
    delete rest[tabId];
    set({ overrides: rest });
    model.doAction(
      Actions.updateNodeAttributes(tabId, {
        name: uriLabel(uri),
        config: { uri },
      }),
    );
    recordRecent(uri);
    get().save();
  },

  navigateTab: (tabId, uri) => {
    set((s) => ({ overrides: { ...s.overrides, [tabId]: uri } }));
    get().save();
  },

  toJson: () => applyOverrides(get().model!.toJson(), get().overrides),

  save: () => {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(async () => {
      const { wid, version } = get();
      const next = version + 1;
      try {
        set({ saving: true });
        await api(`/api/windows/${wid}`, {
          method: "PUT",
          body: JSON.stringify({ version: next, root: get().toJson() }),
        });
        set({ version: next, saving: false });
      } catch {
        set({ saving: false });
        try {
          const doc = await api<{ version: number; root: unknown }>(
            `/api/windows/${wid}`,
          );
          get().reconcile(doc.root, doc.version);
        } catch {
          /* ignore */
        }
      }
    }, 400);
  },
}));
