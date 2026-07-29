import type { IJsonModel, IJsonTabNode } from "flexlayout-react";
import { uriLabel } from "./uri";

// window.root 存 FlexLayout 的 IJsonModel。每个 tab 的 config.uri 承载块的虚拟 URI。

export const GLOBAL = {
  tabEnableRename: false,
  tabSetEnableMaximize: true,
  tabSetMinWidth: 120,
  tabSetMinHeight: 80,
  splitterSize: 4,
  enableEdgeDock: true,
};

export function emptyModel(): IJsonModel {
  return {
    global: GLOBAL,
    borders: [],
    layout: {
      type: "row",
      weight: 100,
      children: [{ type: "tabset", weight: 100, children: [newTab(null)] }],
    },
  };
}

let tabSeq = 0;
export function newTab(uri: string | null): IJsonTabNode {
  return {
    type: "tab",
    id: `t${Date.now().toString(36)}_${tabSeq++}`,
    name: uriLabel(uri),
    component: "block",
    config: { uri },
    enableClose: true,
  };
}

/** model 是否已含 FlexLayout 结构（旧版二叉树/空对象则回退到 emptyModel）。 */
export function normalizeModel(root: unknown): IJsonModel {
  const r = root as IJsonModel | undefined;
  return r && r.layout ? r : emptyModel();
}
