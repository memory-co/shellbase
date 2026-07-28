// 布局树：服务端只存 {type,dir,ratio,children|uri}（windows.md）；
// 客户端为每个叶子附加稳定 id 与 src（iframe 装载地址，navigate 时不重载）。

import { resolveUri } from "../shared/uri";

export type ServerNode =
  | { type: "leaf"; uri: string | null }
  | { type: "split"; dir: "row" | "col"; ratio: number; children: ServerNode[] };

export type Leaf = { type: "leaf"; id: string; uri: string | null; src: string };
export type Split = {
  type: "split";
  id: string;
  dir: "row" | "col";
  ratio: number;
  children: [Node, Node];
};
export type Node = Leaf | Split;

let seq = 0;
export const nextId = () => `n${++seq}`;

export function makeLeaf(uri: string | null, wid: string): Leaf {
  const id = nextId();
  return { type: "leaf", id, uri, src: resolveUri(uri, wid, id) };
}

/** 服务端树 → 客户端树；按 uri 复用旧叶子（含 src），避免 iframe 重载。 */
export function fromServer(node: ServerNode, wid: string, prev: Node | null): Node {
  const pool: Leaf[] = [];
  const collect = (n: Node | null) => {
    if (!n) return;
    if (n.type === "leaf") pool.push(n);
    else n.children.forEach(collect);
  };
  collect(prev);

  const build = (n: ServerNode): Node => {
    if (n.type === "leaf") {
      const i = pool.findIndex((l) => l.uri === n.uri);
      if (i >= 0) return pool.splice(i, 1)[0];
      return makeLeaf(n.uri, wid);
    }
    return {
      type: "split",
      id: nextId(),
      dir: n.dir,
      ratio: n.ratio,
      children: [build(n.children[0]), build(n.children[1])],
    };
  };
  return build(node);
}

export function toServer(node: Node): ServerNode {
  if (node.type === "leaf") return { type: "leaf", uri: node.uri };
  return {
    type: "split",
    dir: node.dir,
    ratio: node.ratio,
    children: node.children.map(toServer),
  };
}

export function findLeaf(node: Node, id: string): Leaf | null {
  if (node.type === "leaf") return node.id === id ? node : null;
  for (const c of node.children) {
    const hit = findLeaf(c, id);
    if (hit) return hit;
  }
  return null;
}

export function mapTree(node: Node, fn: (n: Node) => Node): Node {
  const mapped =
    node.type === "split"
      ? {
          ...node,
          children: [
            mapTree(node.children[0], fn),
            mapTree(node.children[1], fn),
          ] as [Node, Node],
        }
      : node;
  return fn(mapped);
}

/** 关闭叶子：父分割坍缩为兄弟节点。根叶子关闭 → 变回启动页。 */
export function removeLeaf(node: Node, id: string, wid: string): Node {
  if (node.type === "leaf") {
    return node.id === id ? makeLeaf(null, wid) : node;
  }
  const [a, b] = node.children;
  if (a.type === "leaf" && a.id === id) return b;
  if (b.type === "leaf" && b.id === id) return a;
  return {
    ...node,
    children: [removeLeaf(a, id, wid), removeLeaf(b, id, wid)] as [Node, Node],
  };
}

/** deep link：在第一个空叶子打开 uri；没有空叶子则分割根。 */
export function openInTree(node: Node, uri: string, wid: string): Node {
  let done = false;
  const fill = (n: Node): Node => {
    if (done) return n;
    if (n.type === "leaf") {
      if (n.uri === null) {
        done = true;
        return makeLeaf(uri, wid);
      }
      return n;
    }
    return { ...n, children: [fill(n.children[0]), fill(n.children[1])] as [Node, Node] };
  };
  const filled = fill(node);
  if (done) return filled;
  return {
    type: "split",
    id: nextId(),
    dir: "row",
    ratio: 0.5,
    children: [filled, makeLeaf(uri, wid)],
  };
}

export function splitLeaf(node: Node, id: string, dir: "row" | "col", wid: string): Node {
  if (node.type === "leaf") {
    if (node.id !== id) return node;
    return {
      type: "split",
      id: nextId(),
      dir,
      ratio: 0.5,
      children: [node, makeLeaf(null, wid)],
    };
  }
  return {
    ...node,
    children: [
      splitLeaf(node.children[0], id, dir, wid),
      splitLeaf(node.children[1], id, dir, wid),
    ] as [Node, Node],
  };
}
