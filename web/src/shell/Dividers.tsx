import { useState } from "react";
import { COLS, ROWS, dividers, type GridRoot } from "@/lib/grid";
import { useShell } from "@/lib/store";

/**
 * 分割线拖拽覆盖层：把 grid 里的内部边渲染成可拖热区。
 * 拖动期间盖一层全屏透明遮罩，防止鼠标滑进 iframe 后事件丢失（iframe 画布经典坑）。
 */
export function Dividers({
  grid,
  container,
}: {
  grid: GridRoot;
  container: React.RefObject<HTMLDivElement>;
}) {
  const [dragging, setDragging] = useState(false);

  const start = (
    e: React.PointerEvent,
    axis: "x" | "y",
    pos: number,
  ) => {
    e.preventDefault();
    const box = container.current?.getBoundingClientRect();
    if (!box) return;
    const unit = axis === "x" ? box.width / COLS : box.height / ROWS;
    const origin = axis === "x" ? e.clientX : e.clientY;
    let applied = 0;
    setDragging(true);

    const move = (ev: PointerEvent) => {
      const now = axis === "x" ? ev.clientX : ev.clientY;
      const target = Math.round((now - origin) / unit);
      const delta = target - applied;
      if (delta !== 0) {
        useShell.getState().drag(axis, pos, delta);
        applied = target;
      }
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      setDragging(false);
      if (applied !== 0) useShell.getState().save();
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };

  return (
    <>
      {dividers(grid).map((d) => {
        // 用与面板相同的网格坐标定位，热区在网格线上 ±几px
        const style: React.CSSProperties =
          d.axis === "x"
            ? {
                gridColumn: `${d.pos + 1}`,
                gridRow: `${d.from + 1} / ${d.to + 1}`,
                cursor: "col-resize",
                marginLeft: "-3px",
                width: "6px",
                justifySelf: "start",
              }
            : {
                gridColumn: `${d.from + 1} / ${d.to + 1}`,
                gridRow: `${d.pos + 1}`,
                cursor: "row-resize",
                marginTop: "-3px",
                height: "6px",
                alignSelf: "start",
              };
        return (
          <div
            key={`${d.axis}-${d.pos}-${d.from}`}
            className="z-10 self-stretch hover:bg-primary/40"
            style={style}
            onPointerDown={(e) => start(e, d.axis, d.pos)}
          />
        );
      })}
      {dragging && (
        <div className="fixed inset-0 z-50 cursor-inherit" style={{ cursor: "inherit" }} />
      )}
    </>
  );
}
