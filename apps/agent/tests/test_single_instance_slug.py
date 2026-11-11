"""A trava da identidade: o mesmo `agent_id` não roda em duas pastas de instalação ao mesmo tempo"""

import subprocess
import sys
import time
import uuid
from pathlib import Path

import pytest

from uniover_agent.adapters import single_instance

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="a trava é um mutex do Windows")

HOLDER = """
import sys, time
from uniover_agent.adapters.single_instance import acquire_slug
print("held" if acquire_slug(sys.argv[1]) else "refused", flush=True)
time.sleep(60)
"""


def test_the_name_depends_only_on_the_identity() -> None:
    first = single_instance.slug_mutex_name("pc-de-casa")
    assert first == single_instance.slug_mutex_name(" PC-de-casa ")
    assert first != single_instance.slug_mutex_name("pc-do-raphael")
    assert first.startswith("Local\\UniOver-AgentSlug-")


def test_a_second_process_with_the_same_identity_is_refused_and_another_identity_is_not(
    tmp_path: Path,
) -> None:
    slug = f"pc-teste-{uuid.uuid4().hex[:12]}"
    holder = subprocess.Popen(  # noqa: S603 - o próprio interpretador do teste
        [sys.executable, "-c", HOLDER, slug],
        stdout=subprocess.PIPE,
        text=True,
        cwd=tmp_path,
    )
    try:
        assert holder.stdout is not None
        assert holder.stdout.readline().strip() == "held"
        assert single_instance.acquire_slug(slug) is False
        assert single_instance.acquire_slug(f"{slug}-outro") is True
    finally:
        holder.kill()
        holder.wait(timeout=10)
    # Com o dono morto a trava some sozinha (o Windows a solta).
    deadline = time.monotonic() + 10
    taken = False
    while time.monotonic() < deadline and not taken:
        taken = single_instance.acquire_slug(slug)
        time.sleep(0.2)
    assert taken


def test_the_process_that_holds_the_slug_is_not_refused_by_itself() -> None:
    slug = f"pc-teste-{uuid.uuid4().hex[:12]}"
    assert single_instance.acquire_slug(slug) is True
    assert single_instance.acquire_slug(slug) is True
