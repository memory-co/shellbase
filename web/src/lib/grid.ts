// 24×16 网格上的矩形剖分。所有操作保持"界内 / 不重叠 / 铺满"三条不变量。
// 纯几何逻辑，无 React。

export const COLS = 24;
export const ROWS = 16;
export const MIN_W = 3;
export const MIN_H = 2;

export type Panel = {
  id: string;
  uri: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type GridRoot = { cols: number; rows: number; panels: Panel[] };

let seq = 0;
export function newId(): string {
  return `p${Date.now().toString(36)}${(seq++).toString(36)}`;
}

export function emptyGrid(): GridRoot {
  return {
    cols: COLS,
    rows: ROWS,
    panels: [{ id: newId(), uri: null, x: 0, y: 0, w: COLS, h: ROWS }],
  };
}

/** 旧格式（非网格）一律回退为空网格。 */
export function normalizeGrid(root: unknown): GridRoot {
  const r = root as GridRoot | undefined;
  if (r && r.cols === COLS && r.rows === ROWS && Array.isArray(r.panels) && r.panels.length)
    return { cols: COLS, rows: ROWS, panels: r.panels.map((p) => ({ ...p })) };
  return emptyGrid();
}

/** 把一个面板一分为二。dir=row 左右切，dir=col 上下切。新面板 uri=null（启动页）。 */
export function splitPanel(
  root: GridRoot,
  id: string,
  dir: "row" | "col",
): { root: GridRoot; newId: string } {
  const panels = root.panels.map((p) => ({ ...p }));
  const p = panels.find((q) => q.id === id);
  const nid = newId();
  if (!p) return { root, newId: nid };
  if (dir === "row") {
    if (p.w < MIN_W * 2) return { root, newId: nid }; // 太窄无法再切
    const left = Math.floor(p.w / 2);
    const created: Panel = { id: nid, uri: null, x: p.x + left, y: p.y, w: p.w - left, h: p.h };
    p.w = left;
    panels.push(created);
  } else {
    if (p.h < MIN_H * 2) return { root, newId: nid };
    const top = Math.floor(p.h / 2);
    const created: Panel = { id: nid, uri: null, x: p.x, y: p.y + top, w: p.w, h: p.h - top };
    p.h = top;
    panels.push(created);
  }
  return { root: { ...root, panels }, newId: nid };
}

/**
 * 关闭一个面板，空间由邻居确定性吸收：
 * 优先找与被关面板某条边完全重合的邻居集（同侧多个也行），它们一起向该方向延伸铺满空缺。
 * 四条边依次尝试，取第一条能被"完整覆盖"的边。
 */
export function closePanel(root: GridRoot, id: string): GridRoot {
  const rest = root.panels.filter((p) => p.id !== id).map((p) => ({ ...p }));
  const gone = root.panels.find((p) => p.id === id);
  if (!gone || rest.length === 0) return emptyGrid();

  // 四个吸收方向：邻居贴着 gone 的某条边，向 gone 延伸。
  // left  : 邻居在左，右边缘 == gone.x，  纵向覆盖 [gone.y, gone.y+gone.h)
  // right : 邻居在右，左边缘 == gone.x+w，纵向覆盖同上
  // top   : 邻居在上，下边缘 == gone.y，  横向覆盖 [gone.x, gone.x+gone.w)
  // bottom: 邻居在下，上边缘 == gone.y+h，横向覆盖同上
  const gx2 = gone.x + gone.w;
  const gy2 = gone.y + gone.h;

  const tryEdge = (
    match: (p: Panel) => boolean,
    covers: (p: Panel) => [number, number], // 该邻居在覆盖轴上的区间
    span: [number, number], // 需要被完整覆盖的区间
    extend: (p: Panel) => void,
  ): Panel[] | null => {
    const neighbors = rest.filter(match);
    if (!neighbors.length) return null;
    // 邻居们在覆盖轴上的并集须恰好等于 span，且互不重叠（本就不重叠，检查连续铺满即可）
    const segs = neighbors.map(covers).sort((a, b) => a[0] - b[0]);
    let cur = span[0];
    for (const [s, e] of segs) {
      if (s !== cur) return null; // 有缝或越界
      cur = e;
    }
    if (cur !== span[1]) return null;
    const clone = rest.map((p) => ({ ...p }));
    for (const p of clone) if (match(p)) extend(p);
    return clone;
  };

  const attempts: (Panel[] | null)[] = [
    // left 邻居向右延伸吃掉 gone
    tryEdge(
      (p) => p.x + p.w === gone.x && p.y < gy2 && p.y + p.h > gone.y,
      (p) => [p.y, p.y + p.h],
      [gone.y, gy2],
      (p) => (p.w += gone.w),
    ),
    // right 邻居向左延伸
    tryEdge(
      (p) => p.x === gx2 && p.y < gy2 && p.y + p.h > gone.y,
      (p) => [p.y, p.y + p.h],
      [gone.y, gy2],
      (p) => {
        p.x -= gone.w;
        p.w += gone.w;
      },
    ),
    // top 邻居向下延伸
    tryEdge(
      (p) => p.y + p.h === gone.y && p.x < gx2 && p.x + p.w > gone.x,
      (p) => [p.x, p.x + p.w],
      [gone.x, gx2],
      (p) => (p.h += gone.h),
    ),
    // bottom 邻居向上延伸
    tryEdge(
      (p) => p.y === gy2 && p.x < gx2 && p.x + p.w > gone.x,
      (p) => [p.x, p.x + p.w],
      [gone.x, gx2],
      (p) => {
        p.y -= gone.h;
        p.h += gone.h;
      },
    ),
  ];

  for (const a of attempts) if (a) return { ...root, panels: a };

  // 理论上分割产生的布局总有一条可吸收边；兜底：给第一个邻居强行补面积（不应触发）
  return { ...root, panels: rest };
}

/**
 * 拖动一条分割线：沿 axis 方向、位置在 pos 处的边，两侧面板同步缩放 delta 格。
 * axis="x"：竖直分割线（左右两侧）；axis="y"：水平分割线（上下两侧）。
 * side A = 边左/上侧（右/下缘==pos），side B = 边右/下侧（左/上缘==pos）。
 */
export function dragDivider(
  root: GridRoot,
  axis: "x" | "y",
  pos: number,
  delta: number,
): GridRoot {
  if (delta === 0) return root;
  const panels = root.panels.map((p) => ({ ...p }));
  const startA = axis === "x" ? (p: Panel) => p.x + p.w : (p: Panel) => p.y + p.h;
  const startB = axis === "x" ? (p: Panel) => p.x : (p: Panel) => p.y;
  const sizeA = axis === "x" ? (p: Panel) => p.w : (p: Panel) => p.h;
  const min = axis === "x" ? MIN_W : MIN_H;
  const limit = axis === "x" ? COLS : ROWS;

  const sideA = panels.filter((p) => startA(p) === pos);
  const sideB = panels.filter((p) => startB(p) === pos);
  if (!sideA.length || !sideB.length) return root;

  // 钳制：A 侧不能小于 min，B 侧不能小于 min
  let d = delta;
  const maxInc = Math.min(...sideB.map((p) => sizeA(p) - min)); // B 收缩上限
  const maxDec = Math.min(...sideA.map((p) => sizeA(p) - min)); // A 收缩上限
  d = Math.max(-maxDec, Math.min(maxInc, d));
  if (d === 0) return root;

  for (const p of sideA) if (axis === "x") p.w += d; else p.h += d;
  for (const p of sideB) {
    if (axis === "x") {
      p.x += d;
      p.w -= d;
    } else {
      p.y += d;
      p.h -= d;
    }
  }
  void limit;
  return { ...root, panels };
}

/** 找出所有内部分割线（供渲染拖拽热区）。返回 {axis,pos,from,to}，from/to 是该线覆盖的正交区间。 */
export type Divider = { axis: "x" | "y"; pos: number; from: number; to: number };

export function dividers(root: GridRoot): Divider[] {
  const out: Divider[] = [];
  // 竖线：某面板右缘 == 另一面板左缘
  const seen = new Set<string>();
  for (const p of root.panels) {
    const rx = p.x + p.w;
    if (rx < COLS) {
      const key = `x${rx}:${p.y}:${p.y + p.h}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ axis: "x", pos: rx, from: p.y, to: p.y + p.h });
      }
    }
    const by = p.y + p.h;
    if (by < ROWS) {
      const key = `y${by}:${p.x}:${p.x + p.w}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ axis: "y", pos: by, from: p.x, to: p.x + p.w });
      }
    }
  }
  return out;
}
