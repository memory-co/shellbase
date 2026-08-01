import { create } from "zustand";
import { api, recordRecent } from "./api";
import {
  closePanel,
  dragDivider,
  emptyGrid,
  normalizeGrid,
  splitPanel,
  type GridRoot,
} from "./grid";
import { completeIdentity, constructForm } from "./uri";

// Shell 布局状态归 Zustand；读（windows/terminals/apps）走 TanStack Query。
// 保存：防抖全量 PUT，version 单调递增，409/失败时拉最新覆盖（windows.md §4.2）。

type ShellState = {
  wid: string;
  version: number;
  grid: GridRoot;
  saving: boolean;

  init: (wid: string, root: unknown, version: number) => void;
  reconcile: (root: unknown, version: number) => void;
  setUri: (panelId: string, uri: string) => void; // URL bar 落位（终端类自动补全身份参数）
  navigate: (panelId: string, uri: string) => void; // 应用内导航（不重载）
  split: (panelId: string, dir: "row" | "col") => void;
  close: (panelId: string) => void;
  drag: (axis: "x" | "y", pos: number, delta: number) => void;
  save: () => void;
};

let saveTimer: number | undefined;

export const useShell = create<ShellState>((set, get) => ({
  wid: "main",
  version: 0,
  grid: emptyGrid(),
  saving: false,

  init: (wid, root, version) =>
    set({ wid, grid: normalizeGrid(root), version }),

  reconcile: (root, version) => {
    if (version <= get().version) return;
    set({ grid: normalizeGrid(root), version });
  },

  setUri: (panelId, uri) => {
    // 落位补全：剥离用户手填的身份参数，重写 window/block（urlbar.md §2.2）
    const s = get();
    const others = s.grid.panels
      .filter((p) => p.id !== panelId)
      .map((p) => p.uri);
    const full = completeIdentity(uri, s.wid, others);
    set((st) => ({
      grid: {
        ...st.grid,
        panels: st.grid.panels.map((p) =>
          p.id === panelId ? { ...p, uri: full } : p,
        ),
      },
    }));
    recordRecent(constructForm(full)); // recents 存构造形态（urlbar.md §3.1）
    get().save();
  },

  navigate: (panelId, uri) => {
    // 仅更新持久化的 uri，不触发 iframe 重载（面板 id/位置不变）
    set((s) => ({
      grid: {
        ...s.grid,
        panels: s.grid.panels.map((p) =>
          p.id === panelId ? { ...p, uri } : p,
        ),
      },
    }));
    get().save();
  },

  split: (panelId, dir) => {
    set((s) => ({ grid: splitPanel(s.grid, panelId, dir).root }));
    get().save();
  },

  close: (panelId) => {
    set((s) => ({ grid: closePanel(s.grid, panelId) }));
    get().save();
  },

  drag: (axis, pos, delta) => {
    set((s) => ({ grid: dragDivider(s.grid, axis, pos, delta) }));
  },

  save: () => {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(async () => {
      const { wid, version, grid } = get();
      const next = version + 1;
      try {
        set({ saving: true });
        await api(`/api/windows/${wid}`, {
          method: "PUT",
          body: JSON.stringify({ version: next, root: grid }),
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
