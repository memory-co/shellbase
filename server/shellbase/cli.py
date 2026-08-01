"""shellbase 命令行：起后端、暴露随包分发的静态产物与 nginx 配置。

pip 包只提供后端与资源，进程编排（nginx / ttyd / tmux）由使用者自己配置，
Docker 镜像里那套编排见 deploy/supervisord.conf。
"""

import argparse
import os
import sys
from pathlib import Path

ASSETS = Path(__file__).resolve().parent / "_assets"

WEB_ROOT = ASSETS / "web"
NGINX_TMPL = ASSETS / "deploy" / "nginx.conf.tmpl"
TMUX_CONF = ASSETS / "deploy" / "tmux.conf"
ATTACH_SH = ASSETS / "bin" / "attach.sh"


def _serve(args) -> int:
    import uvicorn

    uvicorn.run("shellbase.main:app", host=args.host, port=args.port)
    return 0


def _paths(_args) -> int:
    for label, path in (
        ("web-root", WEB_ROOT),
        ("nginx-template", NGINX_TMPL),
        ("tmux-conf", TMUX_CONF),
        ("attach-sh", ATTACH_SH),
    ):
        mark = "" if path.exists() else "  (missing)"
        print(f"{label}\t{path}{mark}")
    return 0


def _nginx_conf(args) -> int:
    """渲染 nginx 配置：只替换 ${SHELLBASE_*} 占位，nginx 自身的 $var 原样保留。"""
    if not NGINX_TMPL.exists():
        print(f"nginx template not found: {NGINX_TMPL}", file=sys.stderr)
        return 1

    run_dir = Path(args.run_dir).expanduser().resolve()
    web_root = Path(args.web_root).expanduser().resolve()
    text = NGINX_TMPL.read_text(encoding="utf-8")
    for name, value in (
        ("SHELLBASE_PORT", str(args.port)),
        ("SHELLBASE_RUN_DIR", str(run_dir)),
        ("SHELLBASE_WEB_ROOT", str(web_root)),
    ):
        text = text.replace("${" + name + "}", value)

    if args.output:
        out = Path(args.output).expanduser()
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text, encoding="utf-8")
        print(f"wrote {out}", file=sys.stderr)
    else:
        sys.stdout.write(text)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="shellbase", description="shellbase backend & assets"
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_serve = sub.add_parser("serve", help="启动 FastAPI 后端（默认只监听回环）")
    p_serve.add_argument("--host", default=os.environ.get("SHELLBASE_HOST", "127.0.0.1"))
    p_serve.add_argument(
        "--port", type=int, default=int(os.environ.get("SHELLBASE_API_PORT", "8000"))
    )
    p_serve.set_defaults(func=_serve)

    p_paths = sub.add_parser("paths", help="打印随包分发的静态产物与配置路径")
    p_paths.set_defaults(func=_paths)

    p_nginx = sub.add_parser("nginx-conf", help="按本机路径渲染 nginx 配置")
    p_nginx.add_argument(
        "--port", type=int, default=int(os.environ.get("SHELLBASE_PORT", "8080"))
    )
    p_nginx.add_argument(
        "--run-dir",
        default=os.environ.get("SHELLBASE_RUN_DIR", "~/.shellbase/run"),
        help="nginx pid / 临时文件目录（需可写）",
    )
    p_nginx.add_argument(
        "--web-root", default=str(WEB_ROOT), help="前端静态产物目录"
    )
    p_nginx.add_argument("-o", "--output", help="写入文件而非标准输出")
    p_nginx.set_defaults(func=_nginx_conf)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
