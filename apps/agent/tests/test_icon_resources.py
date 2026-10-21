"""Imagem quadrada de reserva do ícone adaptativo, lida de `aapt2 dump resources`."""

import pytest

from uniover_agent.core.tv.icon_resources import parse_icon_fallbacks

from .support_icons import RESOURCES_CINEVS, RESOURCES_SPOTIFY

CINEVS_XML = "res/BW.xml"
SPOTIFY_XML = "res/mipmap-anydpi-v26/spotify_icon.xml"


def test_the_cinevs_webp_fallbacks_come_from_the_largest_density_down() -> None:
    assert parse_icon_fallbacks(RESOURCES_CINEVS, [CINEVS_XML]) == (
        "res/sK.webp",
        "res/Sn.webp",
        "res/qs.webp",
        "res/MO.webp",
        "res/d2.webp",
    )


def test_the_spotify_png_fallbacks_are_read_even_with_the_type_suffix() -> None:
    assert parse_icon_fallbacks(RESOURCES_SPOTIFY, [SPOTIFY_XML]) == (
        "res/mipmap-xxxhdpi-v4/spotify_icon.png",
        "res/mipmap-xxhdpi-v4/spotify_icon.png",
        "res/mipmap-xhdpi-v4/spotify_icon.png",
        "res/mipmap-hdpi-v4/spotify_icon.png",
        "res/mipmap-mdpi-v4/spotify_icon.png",
    )


def test_the_neighbour_layers_and_banners_never_leak_into_the_fallbacks() -> None:
    cinevs = parse_icon_fallbacks(RESOURCES_CINEVS, [CINEVS_XML])
    spotify = parse_icon_fallbacks(RESOURCES_SPOTIFY, [SPOTIFY_XML])
    for layer in ("res/Nt.webp", "res/13.webp", "res/9Q.webp", "res/iE.webp", "res/5c.webp"):
        assert layer not in cinevs
    assert "res/Ec.png" not in cinevs
    assert not [path for path in spotify if "foreground" in path or "background" in path]
    assert "res/banner.png" not in spotify


def test_a_resource_without_the_adaptive_xml_is_not_a_fallback() -> None:
    assert parse_icon_fallbacks(RESOURCES_CINEVS, ["res/outro.xml"]) == ()
    assert parse_icon_fallbacks(RESOURCES_CINEVS, []) == ()


@pytest.mark.parametrize("text", ["", "lixo\nsem formato\n", "Package name=a.b id=7f\n"])
def test_text_without_any_resource_gives_nothing_and_never_raises(text: str) -> None:
    assert parse_icon_fallbacks(text, [CINEVS_XML]) == ()


def test_variants_of_the_drawing_are_not_the_icon() -> None:
    text = """\
Package name=com.a.b id=7f
  type mipmap id=0e entryCount=1
    resource 0x7f0e0000 mipmap/ic
      (hdpi) (file) res/hdpi.png type=PNG
      (night-xhdpi) (file) res/night.png type=PNG
      (pt-rBR-xxhdpi) (file) res/portugues.png type=PNG
      (ldrtl-xxxhdpi-v17) (file) res/direita.png type=PNG
      (xhdpi-v4) (file) res/xhdpi.png type=PNG
      (anydpi-v26) (file) res/ic.xml type=XML
"""
    assert parse_icon_fallbacks(text, ["res/ic.xml"]) == ("res/xhdpi.png", "res/hdpi.png")


def test_unqualified_and_any_density_images_come_last() -> None:
    text = """\
Package name=com.a.b id=7f
  type drawable id=08 entryCount=1
    resource 0x7f080001 drawable/ic
      () (file) res/padrao.png type=PNG
      (nodpi) (file) res/nodpi.webp
      (mdpi) (file) res/mdpi.png type=PNG
      (anydpi-v26) (file) res/ic.xml type=XML
"""
    assert parse_icon_fallbacks(text, ["res/ic.xml"]) == (
        "res/mdpi.png",
        "res/padrao.png",
        "res/nodpi.webp",
    )


def test_only_images_with_a_safe_name_and_a_known_extension_are_kept() -> None:
    text = """\
Package name=com.a.b id=7f
  type mipmap id=0e entryCount=1
    resource 0x7f0e0000 mipmap/ic
      (xhdpi) (file) res/ok.png type=PNG
      (xxhdpi) (file) res/figura.jpg
      (xxxhdpi) (file) ../fora.png type=PNG
      (anydpi-v26) (file) res/ic.xml type=XML
"""
    assert parse_icon_fallbacks(text, ["res/ic.xml"]) == ("res/ok.png",)


def test_the_block_is_closed_at_the_next_resource_even_when_the_xml_comes_first() -> None:
    text = """\
Package name=com.a.b id=7f
  type mipmap id=0e entryCount=2
    resource 0x7f0e0000 mipmap/ic
      (anydpi-v26) (file) res/ic.xml type=XML
      (xhdpi) (file) res/ic.png type=PNG
    resource 0x7f0e0001 mipmap/ic_foreground
      (xhdpi) (file) res/camada.png type=PNG
"""
    assert parse_icon_fallbacks(text, ["res/ic.xml"]) == ("res/ic.png",)


def test_resources_of_other_types_are_not_searched() -> None:
    text = """\
Package name=com.a.b id=7f
  type raw id=0f entryCount=1
    resource 0x7f0f0000 raw/ic
      (xhdpi) (file) res/cru.png type=PNG
      (anydpi-v26) (file) res/ic.xml type=XML
"""
    assert parse_icon_fallbacks(text, ["res/ic.xml"]) == ()
