"""Gravações do `agent.toml` de threads diferentes (a faixa da TV e o laço principal)."""

import threading
import tomllib
from pathlib import Path

from uniover_agent.adapters.local_config import update_config

ROUNDS = 60


def test_concurrent_updates_keep_every_key_and_never_fail(tmp_path: Path) -> None:
    path = tmp_path / "agent.toml"
    update_config(path, {"tv_cleanup_keep": ["a", "b"]})
    start = threading.Barrier(2)
    errors: list[BaseException] = []

    def writer(key: str) -> None:
        start.wait()
        try:
            for round_number in range(ROUNDS):
                update_config(path, {key: f"{key}-{round_number}"})
        except BaseException as exc:
            errors.append(exc)

    threads = [threading.Thread(target=writer, args=(key,)) for key in ("tv_mac", "tv_host")]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(30)

    assert errors == []
    data = tomllib.loads(path.read_text(encoding="utf-8"))
    assert data == {
        "tv_cleanup_keep": ["a", "b"],
        "tv_mac": f"tv_mac-{ROUNDS - 1}",
        "tv_host": f"tv_host-{ROUNDS - 1}",
    }
