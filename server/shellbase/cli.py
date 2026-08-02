"""shellbase 命令行。

`shellbase up` 是 pip 安装后唯一需要的命令：拉起 ttyd 子进程 + 单端口 uvicorn，
静态托管、鉴权、反向代理都在 FastAPI 里（gateway.py），不需要 nginx，也没有配置文件。
"""

import argparse
import os
import secrets
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

ASSETS = Path(__file__).resolve().parent / "_assets"

WEB_ROOT = ASSETS / "web"
TMUX_CONF = ASSETS / "deploy" / "tmux.conf"
# Docker 里是源码树布局（/opt/shellbase/bin），不是 wheel 的 _assets
ATTACH_SH = Path(os.environ.get("SHELLBASE_ATTACH_SH") or ASSETS / "bin" / "attach.sh")


def _die(msg: str) -> int:
    print(f"shellbase: {msg}", file=sys.stderr)
    return 1


def _prepare_env(args) -> str | None:
    """把 CLI 参数固化成环境变量（后端与 attach.sh 都从环境读），返回错误信息或 None。"""
    workspace = Path(
        args.workspace or os.environ.get("SHELLBASE_WORKSPACE") or Path.cwd()
    ).expanduser().resolve()
    state_dir = Path(
        os.environ.get("SHELLBASE_STATE_DIR") or workspace / ".shellbase" / "state"
    ).expanduser().resolve()
    try:
        (state_dir / "terminals").mkdir(parents=True, exist_ok=True)
        (state_dir / "windows").mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        return f"cannot create state dir {state_dir}: {exc}"

    os.environ["SHELLBASE_WORKSPACE"] = str(workspace)
    os.environ["SHELLBASE_STATE_DIR"] = str(state_dir)
    os.environ.setdefault("SHELLBASE_WEB_ROOT", str(WEB_ROOT))
    os.environ["SHELLBASE_TTYD_UPSTREAM"] = f"127.0.0.1:{args.ttyd_port}"

    # 独立 tmux socket：shellbase 的会话不与用户自己的 tmux server 混在一起，
    # 自带配置也才能确定生效（window-size latest 是多客户端协作的前提）
    os.environ.setdefault("SHELLBASE_TMUX_SOCKET", "shellbase")
    if TMUX_CONF.is_file():
        os.environ.setdefault("SHELLBASE_TMUX_CONF", str(TMUX_CONF))

    token = os.environ.get("SHELLBASE_TOKEN", "")
    if not token:
        token = secrets.token_hex(16)
        os.environ["SHELLBASE_TOKEN"] = token
        print("=" * 63)
        print(" SHELLBASE_TOKEN not set. Generated login token:")
        print(f"   {token}")
        print("=" * 63, flush=True)
    return None


def _pdeathsig() -> None:
    """让内核在父进程消失时给 ttyd 发 SIGTERM（Linux PR_SET_PDEATHSIG）。

    不能只靠父进程 finally 里收尸：uvicorn 处理完 SIGTERM 后会把信号重新抛给
    原处理器，进程直接死于信号，finally 压根不执行（连 SIGKILL 也一样）。
    """
    try:
        import ctypes

        ctypes.CDLL("libc.so.6", use_errno=True).prctl(1, signal.SIGTERM)  # PR_SET_PDEATHSIG
    except Exception:
        pass  # 非 Linux 或没有 libc：退化成只靠 finally 收尸


def _warn_no_terminal() -> None:
    missing = [b for b in ("ttyd", "tmux") if shutil.which(b) is None]
    print(
        f"shellbase: 未找到 {' 与 '.join(missing)} —— 终端块不可用，其余功能正常。\n"
        "           安装：apt install ttyd tmux（Ubuntu 24.04+），"
        "或见 https://github.com/tsl0922/ttyd/releases",
        file=sys.stderr,
    )


def _start_ttyd(args) -> subprocess.Popen | None:
    if not ATTACH_SH.is_file():
        print(f"shellbase: attach script missing: {ATTACH_SH}", file=sys.stderr)
        return None
    if not os.access(ATTACH_SH, os.X_OK):
        try:
            ATTACH_SH.chmod(0o755)
        except OSError as exc:
            print(f"shellbase: cannot make {ATTACH_SH} executable: {exc}", file=sys.stderr)
            return None

    child = subprocess.Popen(
        ["ttyd", "-i", "127.0.0.1", "-p", str(args.ttyd_port), "-W", "-a", str(ATTACH_SH)],
        preexec_fn=_pdeathsig if sys.platform == "linux" else None,
    )
    # 端口被占之类的失败是立刻发生的：与其先开门服务、一秒后再被看门狗收摊，
    # 不如当场报清楚
    time.sleep(0.4)
    if child.poll() is not None:
        print(
            f"shellbase: ttyd 启动失败（退出码 {child.returncode}）——"
            f"端口 {args.ttyd_port} 可能已被占用，可用 --ttyd-port 换一个",
            file=sys.stderr,
        )
        return None
    return child


def _watch(child: subprocess.Popen, stop: threading.Event) -> None:
    """ttyd 意外退出就整体收摊：留着一个只剩半条命的实例比直接退出更难排查。"""
    while not stop.wait(1.0):
        code = child.poll()
        if code is not None:
            print(f"shellbase: ttyd exited with code {code}, shutting down", file=sys.stderr)
            os.kill(os.getpid(), signal.SIGTERM)
            return


def _up(args) -> int:
    err = _prepare_env(args)
    if err:
        return _die(err)

    import uvicorn

    ttyd = None
    if not args.no_ttyd:
        if shutil.which("ttyd") is None or shutil.which("tmux") is None:
            _warn_no_terminal()          # 降级运行：终端块不可用，其余照常
        else:
            ttyd = _start_ttyd(args)
            if ttyd is None:
                return 1                 # 装了却起不来 = 配置问题，别装作没事
    stop = threading.Event()
    watcher = None
    if ttyd is not None:
        watcher = threading.Thread(target=_watch, args=(ttyd, stop), daemon=True)
        watcher.start()

    print(
        f"shellbase: workspace={os.environ['SHELLBASE_WORKSPACE']} "
        f"listening on http://{args.host}:{args.port}",
        flush=True,
    )
    try:
        # 兜底：万一还有连接赖着不走，10 秒后强制收摊，别让 Ctrl-C 看起来没反应
        uvicorn.run(
            "shellbase.main:app",
            host=args.host,
            port=args.port,
            timeout_graceful_shutdown=10,
        )
    finally:
        stop.set()
        if ttyd is not None and ttyd.poll() is None:
            print(f"shellbase: stopping ttyd (pid {ttyd.pid})", file=sys.stderr, flush=True)
            ttyd.terminate()
            try:
                ttyd.wait(timeout=5)
            except subprocess.TimeoutExpired:
                ttyd.kill()
                ttyd.wait(timeout=5)
    return 0


def _serve(args) -> int:
    """只起 HTTP 服务，不管 ttyd（本地开发、或自己编排进程时用）。"""
    import uvicorn

    os.environ.setdefault("SHELLBASE_WEB_ROOT", str(WEB_ROOT))
    uvicorn.run("shellbase.main:app", host=args.host, port=args.port)
    return 0


def _paths(_args) -> int:
    for label, path in (
        ("web-root", Path(os.environ.get("SHELLBASE_WEB_ROOT", WEB_ROOT))),
        ("tmux-conf", TMUX_CONF),
        ("attach-sh", ATTACH_SH),
    ):
        mark = "" if Path(path).exists() else "  (missing)"
        print(f"{label}\t{path}{mark}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="shellbase", description="shellbase：浏览器里的融合终端平台"
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_up = sub.add_parser("up", help="拉起完整服务（ttyd + HTTP 网关），pip 安装后用这个")
    p_up.add_argument(
        "--host", default=os.environ.get("SHELLBASE_HOST", "0.0.0.0"),
        help="监听地址，默认 0.0.0.0",
    )
    p_up.add_argument(
        "--port", type=int,
        default=int(os.environ.get("SHELLBASE_PORT") or os.environ.get("PORT") or 8080),
        help="监听端口，默认 8080",
    )
    p_up.add_argument(
        "--workspace", help="工作区目录，默认取 $SHELLBASE_WORKSPACE 或当前目录"
    )
    p_up.add_argument("--ttyd-port", type=int, default=7681, help="ttyd 回环端口")
    p_up.add_argument("--no-ttyd", action="store_true", help="不拉起 ttyd（自己管）")
    p_up.set_defaults(func=_up)

    p_serve = sub.add_parser("serve", help="只起 HTTP 服务，不拉 ttyd")
    p_serve.add_argument("--host", default=os.environ.get("SHELLBASE_HOST", "127.0.0.1"))
    p_serve.add_argument(
        "--port", type=int, default=int(os.environ.get("SHELLBASE_PORT") or 8000)
    )
    p_serve.set_defaults(func=_serve)

    p_paths = sub.add_parser("paths", help="打印随包分发的前端产物 / tmux.conf / attach.sh")
    p_paths.set_defaults(func=_paths)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
