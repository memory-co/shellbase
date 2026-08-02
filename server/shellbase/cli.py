"""shellbase 命令行。

同一件事（ttyd 子进程 + 单端口 uvicorn，静态托管/鉴权/反代都在 gateway.py 里）
有两种跑法：

- `daemon`：前台阻塞，日志走 stdout，进程即服务本身 —— 容器的 ENTRYPOINT 用这个；
- `start` / `stop`：后台守护，PID 与日志落在 run 目录 —— pip 装完的用户用这个。

`start` 只是把 `daemon` 脱离终端拉起来再等它就绪，两条路跑的是同一份代码。
"""

import argparse
import contextlib
import os
import secrets
import shutil
import socket
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

ASSETS = Path(__file__).resolve().parent / "_assets"

# 后台实例的 PID / 日志 / 令牌：一台机器一个实例，够用且不用记路径
RUN_DIR = Path(
    os.environ.get("SHELLBASE_RUN_DIR") or Path.home() / ".shellbase"
).expanduser()
PID_FILE = RUN_DIR / "shellbase.pid"
LOG_FILE = RUN_DIR / "shellbase.log"
TOKEN_FILE = RUN_DIR / "token"

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


def _free_port() -> int:
    """让内核挑一个空闲回环端口。

    ttyd 只服务本机的网关，端口号对外没有意义，写死反而会跟用户自己跑的 ttyd
    或别的服务撞车。绑完就放，理论上有一瞬的竞争窗口，起不来会重试并明确报错。
    """
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


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


def _spawn_ttyd(port: int) -> subprocess.Popen | None:
    child = subprocess.Popen(
        ["ttyd", "-i", "127.0.0.1", "-p", str(port), "-W", "-a", str(ATTACH_SH)],
        preexec_fn=_pdeathsig if sys.platform == "linux" else None,
    )
    # 端口被占之类的失败是立刻发生的：与其先开门服务、一秒后再被看门狗收摊，
    # 不如当场发现
    time.sleep(0.4)
    if child.poll() is not None:
        return None
    return child


def _start_ttyd(requested_port: int) -> tuple[subprocess.Popen, int] | None:
    """拉起 ttyd，返回 (进程, 实际端口)。requested_port 为 0 表示自动挑。"""
    if not ATTACH_SH.is_file():
        print(f"shellbase: attach script missing: {ATTACH_SH}", file=sys.stderr)
        return None
    if not os.access(ATTACH_SH, os.X_OK):
        try:
            ATTACH_SH.chmod(0o755)
        except OSError as exc:
            print(f"shellbase: cannot make {ATTACH_SH} executable: {exc}", file=sys.stderr)
            return None

    if requested_port:
        child = _spawn_ttyd(requested_port)
        if child is None:
            print(
                f"shellbase: ttyd 启动失败——端口 {requested_port} 可能已被占用，"
                "可用 --ttyd-port 换一个（留空则自动挑）",
                file=sys.stderr,
            )
            return None
        return child, requested_port

    # 自动挑：绑完到启动之间有竞争窗口，撞上了就换一个再试
    for _ in range(5):
        port = _free_port()
        child = _spawn_ttyd(port)
        if child is not None:
            return child, port
    print("shellbase: ttyd 连续 5 次都没抢到端口，放弃", file=sys.stderr)
    return None


def _watch(child: subprocess.Popen, stop: threading.Event) -> None:
    """ttyd 意外退出就整体收摊：留着一个只剩半条命的实例比直接退出更难排查。"""
    while not stop.wait(1.0):
        code = child.poll()
        if code is not None:
            print(f"shellbase: ttyd exited with code {code}, shutting down", file=sys.stderr)
            os.kill(os.getpid(), signal.SIGTERM)
            return


def _daemon(args) -> int:
    err = _prepare_env(args)
    if err:
        return _die(err)

    import uvicorn

    ttyd = None
    if not args.no_ttyd:
        if shutil.which("ttyd") is None or shutil.which("tmux") is None:
            _warn_no_terminal()          # 降级运行：终端块不可用，其余照常
        else:
            started = _start_ttyd(args.ttyd_port)
            if started is None:
                return 1                 # 装了却起不来 = 配置问题，别装作没事
            ttyd, ttyd_port = started
            # 网关在 import 时读这个变量，必须赶在 uvicorn 之前落定
            os.environ["SHELLBASE_TTYD_UPSTREAM"] = f"127.0.0.1:{ttyd_port}"
            print(f"shellbase: ttyd on 127.0.0.1:{ttyd_port}", flush=True)
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


# ---- 后台守护：start / stop ----

def _running_pid() -> int | None:
    """读 PID 文件并确认进程还活着；陈旧的文件顺手清掉。"""
    try:
        pid = int(PID_FILE.read_text().strip())
    except (OSError, ValueError):
        return None
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        PID_FILE.unlink(missing_ok=True)
        return None
    except PermissionError:
        return pid  # 别人的进程占着同一个 PID：交给调用方判断
    return pid


def _persistent_token() -> str:
    """后台实例的令牌落盘复用：重启一次就换令牌，浏览器里存的地址全废。

    环境变量优先；文件不存在才新生成。想轮换就删掉这个文件。
    """
    token = os.environ.get("SHELLBASE_TOKEN", "").strip()
    if token:
        return token
    try:
        saved = TOKEN_FILE.read_text().strip()
        if saved:
            return saved
    except OSError:
        pass
    token = secrets.token_hex(16)
    try:
        TOKEN_FILE.write_text(token)
        TOKEN_FILE.chmod(0o600)
    except OSError as exc:
        print(f"shellbase: 令牌无法写入 {TOKEN_FILE}（{exc}），本次启动后不可复用",
              file=sys.stderr)
    return token


def _health_ok(port: int) -> bool:
    import urllib.error
    import urllib.request

    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/api/system/health", timeout=2
        ) as resp:
            return resp.status == 200
    except (urllib.error.URLError, OSError):
        return False


def _start(args) -> int:
    pid = _running_pid()
    if pid is not None:
        return _die(f"已经在运行（pid {pid}）。先 `shellbase stop`，或看 {LOG_FILE}")

    try:
        RUN_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        return _die(f"无法创建 run 目录 {RUN_DIR}: {exc}")

    token = _persistent_token()
    env = dict(os.environ, SHELLBASE_TOKEN=token)

    argv = [
        sys.executable, "-m", "shellbase.cli", "daemon",
        "--host", args.host, "--port", str(args.port),
        "--ttyd-port", str(args.ttyd_port),
    ]
    if args.workspace:
        argv += ["--workspace", args.workspace]
    if args.no_ttyd:
        argv.append("--no-ttyd")

    log = open(LOG_FILE, "a", buffering=1)
    log.write(f"\n===== shellbase start {time.strftime('%Y-%m-%d %H:%M:%S')} =====\n")
    try:
        child = subprocess.Popen(
            argv, env=env, stdout=log, stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            start_new_session=True,   # 脱离终端：关掉 ssh 也不会被带走
        )
    except OSError as exc:
        log.close()
        return _die(f"启动失败: {exc}")
    finally:
        log.close()

    PID_FILE.write_text(str(child.pid))

    # 等就绪：起不来就把日志尾巴摆出来，不要只丢一个 pid 让人自己去猜
    for _ in range(60):
        if child.poll() is not None:
            PID_FILE.unlink(missing_ok=True)
            print(f"shellbase: 启动失败（退出码 {child.returncode}），日志尾部：",
                  file=sys.stderr)
            _tail_log()
            return 1
        if _health_ok(args.port):
            break
        time.sleep(0.5)
    else:
        print(f"shellbase: 30 秒内没有就绪，进程还在（pid {child.pid}），日志尾部：",
              file=sys.stderr)
        _tail_log()
        return 1

    host = "127.0.0.1" if args.host in ("0.0.0.0", "::") else args.host
    print(f"shellbase 已启动（pid {child.pid}）")
    print(f"  地址   http://{host}:{args.port}")
    print(f"  令牌   {token}")
    print(f"  日志   {LOG_FILE}")
    print(f"  停止   shellbase stop")
    return 0


def _tail_log(lines: int = 15) -> None:
    try:
        tail = LOG_FILE.read_text(errors="replace").splitlines()[-lines:]
    except OSError:
        return
    for line in tail:
        print(f"  | {line}", file=sys.stderr)


def _stop(args) -> int:
    pid = _running_pid()
    if pid is None:
        print("shellbase: 没有在运行的实例")
        return 0

    try:
        os.kill(pid, signal.SIGTERM)
    except OSError as exc:
        return _die(f"无法给 pid {pid} 发信号: {exc}")

    for _ in range(int(args.timeout * 2)):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            PID_FILE.unlink(missing_ok=True)
            print(f"shellbase 已停止（pid {pid}）")
            return 0
        time.sleep(0.5)

    print(f"shellbase: {args.timeout}s 内没退出，强制结束（pid {pid}）", file=sys.stderr)
    with contextlib.suppress(OSError):
        os.kill(pid, signal.SIGKILL)
    time.sleep(0.5)
    PID_FILE.unlink(missing_ok=True)
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


def _add_run_args(p, default_host: str) -> None:
    """daemon 与 start 接受同一组参数：start 只是把它们原样转给 daemon。"""
    p.add_argument(
        "--host", default=os.environ.get("SHELLBASE_HOST", default_host),
        help=f"监听地址，默认 {default_host}",
    )
    p.add_argument(
        "--port", type=int,
        default=int(os.environ.get("SHELLBASE_PORT") or os.environ.get("PORT") or 8080),
        help="监听端口，默认 8080",
    )
    p.add_argument(
        "--workspace", help="工作区目录，默认取 $SHELLBASE_WORKSPACE 或当前目录"
    )
    p.add_argument(
        "--ttyd-port", type=int, default=int(os.environ.get("SHELLBASE_TTYD_PORT") or 0),
        help="ttyd 的回环端口，默认 0 = 自动挑一个空闲端口",
    )
    p.add_argument("--no-ttyd", action="store_true", help="不拉起 ttyd（自己管）")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="shellbase", description="shellbase：浏览器里的融合终端平台"
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_daemon = sub.add_parser(
        "daemon", aliases=["up"],
        help="前台阻塞运行（容器 ENTRYPOINT 用这个，日志走 stdout）",
    )
    _add_run_args(p_daemon, "0.0.0.0")
    p_daemon.set_defaults(func=_daemon)

    p_start = sub.add_parser("start", help="后台启动并等待就绪（pip 安装后用这个）")
    _add_run_args(p_start, "0.0.0.0")
    p_start.set_defaults(func=_start)

    p_stop = sub.add_parser("stop", help="停止后台实例")
    p_stop.add_argument(
        "--timeout", type=float, default=15.0,
        help="等待优雅退出的秒数，超时后 SIGKILL（默认 15）",
    )
    p_stop.set_defaults(func=_stop)

    p_serve = sub.add_parser("serve", help="只起 HTTP 服务，不拉 ttyd（自己编排进程时用）")
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
