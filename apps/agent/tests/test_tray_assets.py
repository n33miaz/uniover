"""Os `.ico` da bandeja: oito tamanhos por estado e quadros próprios para 16, 20 e 24 px."""

import math
import struct
import sys
from datetime import UTC, datetime, timedelta
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image

from uniover_agent.adapters.tray import SharpIcon, assets_dir
from uniover_agent.core.tray_model import TrayInputs, view_of

SIZES = {16, 20, 24, 32, 40, 48, 64, 256}
STATES = {
    "connected": (0x1F, 0x8A, 0x4C),
    "reconnecting": (0xC2, 0x6A, 0x00),
    "error": (0xC6, 0x28, 0x28),
    "updating": (0x1F, 0x6F, 0xD1),
}
SEAL = (0xD9, 0x2D, 0x20)
WHITE = (255, 255, 255)


def frames(path: Path) -> dict[int, Image.Image]:
    """Os quadros do `.ico` lidos do cabeçalho, sem a escolha automática do Pillow."""
    data = path.read_bytes()
    reserved, kind, count = struct.unpack_from("<HHH", data, 0)
    assert (reserved, kind) == (0, 1)
    found: dict[int, Image.Image] = {}
    for index in range(count):
        width, height, _, _, planes, bits, length, offset = struct.unpack_from(
            "<BBBBHHII", data, 6 + 16 * index
        )
        side = width or 256
        assert (height or 256) == side
        assert (planes, bits) == (1, 32)
        image = Image.open(BytesIO(data[offset : offset + length])).convert("RGBA")
        assert image.size == (side, side), "o quadro não tem o tamanho que o cabeçalho diz"
        found[side] = image
    return found


def rgb(image: Image.Image, x: int, y: int) -> tuple[int, int, int]:
    pixel = image.getpixel((x, y))
    assert isinstance(pixel, tuple)
    return (pixel[0], pixel[1], pixel[2])


def alpha(image: Image.Image, x: int, y: int) -> int:
    pixel = image.getpixel((x, y))
    assert isinstance(pixel, tuple)
    return pixel[3]


@pytest.mark.parametrize("state", STATES)
@pytest.mark.parametrize("seal", [False, True])
def test_every_state_has_all_eight_sizes(state: str, seal: bool) -> None:
    name = f"{state}-attention" if seal else state

    assert set(frames(assets_dir() / f"{name}.ico")) == SIZES


@pytest.mark.parametrize("state", STATES)
def test_the_disc_takes_the_color_of_the_state_at_every_size(state: str) -> None:
    for size, image in frames(assets_dir() / f"{state}.ico").items():
        # Um pixel no meio da borda esquerda do disco, longe da marca.
        assert rgb(image, size // 12 + 1, size // 2) == STATES[state], size
        # Os cantos ficam transparentes: o disco é redondo.
        assert alpha(image, 0, 0) == 0, size
        assert alpha(image, size - 1, 0) == 0, size


def test_the_small_frames_are_drawn_on_the_pixel_grid() -> None:
    """16, 20 e 24 têm desenho próprio: as ondas são pixels brancos puros, sem borrão."""
    connected = frames(assets_dir() / "connected.ico")

    # 16 px: ondas de 1 px de largura (colunas 3 e 12) e ponto no centro.
    for y in range(6, 10):
        assert rgb(connected[16], 3, y) == WHITE
        assert rgb(connected[16], 12, y) == WHITE
        assert alpha(connected[16], 3, y) == 255
    # Nada de meio-tom entre a onda e o disco: a coluna ao lado é a cor do estado, inteira.
    assert rgb(connected[16], 2, 7) == STATES["connected"]
    assert rgb(connected[16], 13, 7) == STATES["connected"]
    # 20 e 24 px: ondas de 2 px.
    for size, columns in ((20, (14, 15, 4, 5)), (24, (17, 18, 5, 6))):
        for column in columns:
            assert rgb(connected[size], column, size // 2) == WHITE, (size, column)


def test_the_seal_sits_in_the_lower_right_corner_and_overlaps_the_disc() -> None:
    plain = frames(assets_dir() / "connected.ico")
    sealed = frames(assets_dir() / "connected-attention.ico")

    for size in (16, 20, 24):
        # Centro do selo: perto do canto inferior direito, mas dentro do quadro.
        x = y = round(size * 0.78)
        assert rgb(sealed[size], x, y) == SEAL, size
        assert rgb(plain[size], x, y) != SEAL, size
        # O selo passa da borda do disco: na diagonal, logo depois da borda, só ele desenha.
        outside = math.ceil(size / 2 + (size / 2 + 0.75) * math.sqrt(0.5) - 0.5)
        assert alpha(sealed[size], outside, outside) > 150, size
        assert alpha(plain[size], outside, outside) < 40, size
        # E não está colado: o lado esquerdo do disco continua só com a cor do estado.
        assert rgb(sealed[size], size // 12 + 1, size // 2) == STATES["connected"], size


def test_every_icon_the_tray_can_ask_for_exists() -> None:
    now = datetime.now(UTC)
    names = {
        view_of(
            TrayInputs(
                now=now,
                connected=connected,
                since=now - offset,
                update_outcome=outcome,
                update_checked_at=now,
            )
        ).icon_file
        for connected in (True, False)
        for offset in (timedelta(0), timedelta(days=1))
        for outcome in ("not_checked", "updating", "failed", "blocked", "rolled_back", "updated")
    }

    assert names
    assert all((assets_dir() / name).is_file() for name in names), names


def test_the_vector_sources_and_the_generator_are_versioned() -> None:
    folder = assets_dir()

    for source in ("tray-16.svg", "tray-20.svg", "tray-24.svg", "tray-64.svg"):
        assert (folder / source).read_text(encoding="utf-8").lstrip().startswith("<svg")
    assert (folder.parents[1] / "tools" / "build_tray_icons.mjs").is_file()


@pytest.mark.skipif(sys.platform != "win32", reason="o pystray só usa estas peças no Windows")
def test_the_private_pystray_hooks_we_override_still_exist() -> None:
    """Trocamos `_assert_icon_handle` e `_message` do pystray; se um dia sumirem, falha aqui."""
    import pystray  # type: ignore[import-untyped]  # noqa: PLC0415

    for name in ("_assert_icon_handle", "_message", "_update_icon", "_release_icon"):
        assert callable(getattr(pystray.Icon, name, None)), name
    assert issubclass(SharpIcon, pystray.Icon)


def test_the_image_handed_to_pystray_is_the_frame_closest_to_the_tray_size() -> None:
    from uniover_agent.adapters.tray import _frame  # noqa: PLC0415

    folder = assets_dir()

    assert _frame(folder / "connected.ico", 16).size == (16, 16)
    assert _frame(folder / "connected.ico", 24).size == (24, 24)
    assert _frame(folder / "connected.ico", 22).size in {(20, 20), (24, 24)}
    assert _frame(folder / "error-attention.ico", 1000).size == (256, 256)
