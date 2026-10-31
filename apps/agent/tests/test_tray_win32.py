"""As chamadas do Windows da bandeja: instância única, tamanho do ícone e carga do `.ico`."""

import ctypes
import sys
import uuid
from pathlib import Path

import pytest
from PIL import Image

from uniover_agent.adapters.tray_assets import assets_dir
from uniover_agent.adapters.tray_win32 import (
    SingleInstance,
    load_icon_handle,
    mutex_name,
    own_image_path,
    small_icon_size,
)

windows_only = pytest.mark.skipif(sys.platform != "win32", reason="chamadas do Windows")


def test_each_installation_folder_has_its_own_mutex() -> None:
    assert mutex_name(Path("C:/A")) != mutex_name(Path("C:/B"))
    assert mutex_name(Path("C:/A")) == mutex_name(Path("c:/a"))
    assert mutex_name(Path("C:/A")).startswith("Local\\UniOverTray-")


@windows_only
def test_a_second_tray_finds_out_it_is_not_the_first() -> None:
    name = f"Local\\UniOverTrayTest-{uuid.uuid4().hex}"

    first = SingleInstance(name)
    second = SingleInstance(name)

    assert first.first is True
    assert second.first is False


@windows_only
def test_the_small_icon_size_is_one_the_icon_files_have() -> None:
    assert small_icon_size() in {16, 20, 24, 32, 40, 48, 64}
    assert own_image_path().lower().endswith(".exe")


@windows_only
def test_the_ico_is_loaded_at_the_exact_size_asked() -> None:
    destroy = ctypes.windll.user32.DestroyIcon  # type: ignore[attr-defined,unused-ignore]
    for size in (16, 20, 24, 32):
        handle = load_icon_handle(assets_dir() / "connected.ico", size)
        assert handle
        destroy(ctypes.c_void_p(handle))


@windows_only
def test_a_missing_ico_gives_no_handle(tmp_path: Path) -> None:
    assert load_icon_handle(tmp_path / "nao-existe.ico", 16) is None


@windows_only
def test_the_icon_takes_the_exact_size_instead_of_the_default_32() -> None:
    from uniover_agent.adapters.tray import SharpIcon  # noqa: PLC0415

    icon = SharpIcon("teste", Image.new("RGBA", (16, 16)))
    icon.ico_file = assets_dir() / "error-attention.ico"
    icon.icon_size = 24

    icon._assert_icon_handle()
    first = icon._icon_handle

    assert first
    # Já carregado: não carrega de novo.
    icon._assert_icon_handle()
    assert icon._icon_handle == first
    icon._release_icon()


@windows_only
def test_without_an_ico_file_the_icon_falls_back_to_pystray() -> None:
    from uniover_agent.adapters.tray import SharpIcon  # noqa: PLC0415

    icon = SharpIcon("teste", Image.new("RGBA", (16, 16), (255, 0, 0, 255)))

    icon._assert_icon_handle()

    assert icon._icon_handle
    icon._release_icon()


@windows_only
def test_the_icon_id_sent_to_the_shell_is_fixed_and_the_structure_is_complete(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """O `_message` trocado monta o pedido do pystray só com `hID` fixo (sem tocar no Shell)."""
    from pystray._util import win32  # type: ignore[import-untyped]  # noqa: PLC0415

    sent: list[tuple[int, object]] = []
    monkeypatch.setattr(win32, "Shell_NotifyIcon", lambda code, data: sent.append((code, data)))
    from uniover_agent.adapters.tray import SharpIcon  # noqa: PLC0415

    first = SharpIcon("um", Image.new("RGBA", (16, 16)))
    second = SharpIcon("dois", Image.new("RGBA", (16, 16)))
    for icon in (first, second):
        icon._hwnd = 4242
        icon._message(win32.NIM_MODIFY, win32.NIF_TIP, szTip="UniOver: conectado")

    assert [code for code, _ in sent] == [win32.NIM_MODIFY, win32.NIM_MODIFY]
    ids = {getattr(data, "hID") for _, data in sent}  # noqa: B009 - campos da estrutura do Windows
    assert ids == {1}, "o id não pode mudar entre objetos nem entre execuções"
    data = sent[0][1]
    assert data.cbSize == ctypes.sizeof(win32.NOTIFYICONDATAW)  # type: ignore[attr-defined]
    assert data.hWnd == 4242  # type: ignore[attr-defined]
    assert data.uFlags == win32.NIF_TIP  # type: ignore[attr-defined]
    assert data.szTip == "UniOver: conectado"  # type: ignore[attr-defined]
