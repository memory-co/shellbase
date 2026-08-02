"""cli_status — `shellbase status` 场景. See README.md."""
from __future__ import annotations

import argparse
import json
import os
import time

import pytest

from shellbase import cli


@pytest.fixture
def run_dir(tmp_path, monkeypatch):
    """把 run 目录整体挪到临时目录，别碰跑测试的人自己的 ~/.shellbase。"""
    monkeypatch.setattr(cli, "RUN_DIR", tmp_path)
    monkeypatch.setattr(cli, "PID_FILE", tmp_path / "shellbase.pid")
    monkeypatch.setattr(cli, "STATE_FILE", tmp_path / "instance.json")
    monkeypatch.setattr(cli, "TOKEN_FILE", tmp_path / "token")
    monkeypatch.setattr(cli, "LOG_FILE", tmp_path / "shellbase.log")
    return tmp_path


def write_instance(run_dir, **over):
    doc = {
        "pid": os.getpid(),          # 当前进程：天然「活着」
        "host": "0.0.0.0",
        "port": 8080,
        "ttyd_port": 41234,
        "workspace": "/root/workspace",
        "state_dir": "/root/workspace/.shellbase/state",
        "started_at": time.time() - 3725,
        **over,
    }
    (run_dir / "instance.json").write_text(json.dumps(doc))
    return doc


def status(json_out=False) -> int:
    return cli._status(argparse.Namespace(json=json_out))


def test_not_running_says_so(run_dir, capsys):
    assert status() == 1
    assert "未在运行" in capsys.readouterr().out

    assert status(json_out=True) == 1
    assert json.loads(capsys.readouterr().out) == {"running": False}


def test_stale_files_are_cleaned_up(run_dir, capsys):
    """kill -9 之后文件还在，但实例已经没了 —— 不清掉的话下次 start 会被幽灵拦住。"""
    dead = 2**31 - 1                                   # 几乎不可能存在的 pid
    write_instance(run_dir, pid=dead)
    (run_dir / "shellbase.pid").write_text(str(dead))

    assert status() == 1
    assert "未在运行" in capsys.readouterr().out
    assert not (run_dir / "instance.json").exists()
    assert not (run_dir / "shellbase.pid").exists()


def test_running_reports_what_start_printed(run_dir, capsys, monkeypatch):
    monkeypatch.setattr(cli, "_health_ok", lambda port: True)
    monkeypatch.setattr(cli, "_token_accepted", lambda port, token: True)
    (run_dir / "token").write_text("tok-live")
    write_instance(run_dir)

    assert status() == 0
    out = capsys.readouterr().out
    assert "运行中" in out
    assert "http://127.0.0.1:8080" in out          # 0.0.0.0 展示成可点的回环地址
    assert "tok-live" in out
    assert "/root/workspace" in out
    assert "41234" in out
    assert "1小时2分" in out                        # started_at 是 3725 秒前
    assert "健康     ok" in out


def test_saved_token_is_verified_not_assumed(run_dir, capsys, monkeypatch):
    """落盘的令牌被 SHELLBASE_TOKEN 盖过时，不能把旧值当答案端出去。"""
    monkeypatch.setattr(cli, "_health_ok", lambda port: True)
    monkeypatch.setattr(cli, "_token_accepted", lambda port, token: False)
    (run_dir / "token").write_text("tok-stale")
    write_instance(run_dir)

    status()
    out = capsys.readouterr().out
    assert "tok-stale" not in out
    assert "SHELLBASE_TOKEN" in out


def test_json_token_is_null_when_unverifiable(run_dir, capsys, monkeypatch):
    """给脚本的字段不塞人话。"""
    monkeypatch.setattr(cli, "_health_ok", lambda port: True)
    monkeypatch.setattr(cli, "_token_accepted", lambda port, token: False)
    (run_dir / "token").write_text("tok-stale")
    write_instance(run_dir)

    assert status(json_out=True) == 0
    doc = json.loads(capsys.readouterr().out)
    assert doc["running"] is True
    assert doc["token"] is None
    assert doc["url"] == "http://127.0.0.1:8080"
    assert doc["ttyd_port"] == 41234


def test_unhealthy_instance_is_still_reported(run_dir, capsys, monkeypatch):
    """进程在、端口不应答：要说出来，而不是干脆说没在跑。"""
    monkeypatch.setattr(cli, "_health_ok", lambda port: False)
    monkeypatch.setattr(cli, "_token_accepted", lambda port, token: True)
    write_instance(run_dir)

    assert status() == 0
    assert "无响应" in capsys.readouterr().out


@pytest.mark.parametrize("seconds,expected", [
    (5, "5秒"),
    (90, "1分30秒"),
    (3725, "1小时2分"),
    (200_000, "2天7小时"),
])
def test_duration_reads_like_a_human(seconds, expected):
    assert cli._human_duration(seconds) == expected
