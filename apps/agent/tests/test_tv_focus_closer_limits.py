"""Modo Foco: o que nunca é fechado por nome exato e o teto de fechamentos por varredura."""

import pytest

from uniover_agent.core.tv.focus_closer import can_close_in_focus

from .test_tv_focus_closer import STREAM, build, stopped, tv


@pytest.mark.parametrize(
    "package", ["com.google.android.tv", "com.google.android.googlequicksearchbox"]
)
def test_the_google_tv_and_google_app_packages_are_never_closed(package: str) -> None:
    assert can_close_in_focus(package) is False


async def test_a_sweep_beyond_the_cap_closes_the_first_sixty_and_logs_the_cut(
    caplog: pytest.LogCaptureFixture,
) -> None:
    packages = [f"com.exemplo.app{index:03d}" for index in range(65)]
    adb = tv(STREAM, *packages)
    closer, _, reports = build(adb)

    with caplog.at_level("INFO", logger="uniover_agent.core.tv.focus_closer"):
        await closer.on_focus(STREAM)

    assert stopped(adb) == packages[:60]
    assert len(reports[0][0]) == 60
    assert "65 apps elegíveis" in caplog.text
    assert "60 primeiros" in caplog.text
