"""Leitura do `aapt2 dump badging`: escolha dos candidatos a ícone e conferência do conteúdo."""

import pytest

from uniover_agent.core.tv.icon_badging import (
    MAX_IMAGE_SIDE,
    BadgingInfo,
    ImageInfo,
    image_info,
    is_raster_entry,
    is_xml_entry,
    parse_badging,
)

from .support_icons import (
    BADGING_ADAPTIVE_WITH_BANNER,
    BADGING_ALL_XML,
    BADGING_DENSITIES,
    BADGING_SPOTIFY,
    png_bytes,
    webp_bytes,
)


def test_a_real_badging_with_only_xml_icons_has_no_candidate_and_ignores_the_banner() -> None:
    info = parse_badging(BADGING_ADAPTIVE_WITH_BANNER)
    # `res/Ec.png` é o `banner` 16:9 do lançador da TV: nunca candidato a ícone.
    assert info == BadgingInfo("com.cnvs.apptv", 50, (), ("res/BW.xml",))


def test_the_spotify_badging_also_leaves_only_the_adaptive_xml() -> None:
    info = parse_badging(BADGING_SPOTIFY)
    assert info.version_code == 2340200
    assert info.candidates == ()
    assert info.adaptive == ("res/mipmap-anydpi-v26/spotify_icon.xml",)


def test_png_icons_come_from_the_largest_density_down_and_any_density_xml_is_adaptive() -> None:
    info = parse_badging(BADGING_DENSITIES)
    assert info.package == "com.exemplo.player"
    assert info.version_code == 7
    assert info.candidates == (
        "res/mipmap-xxxhdpi-v4/ic_launcher.png",
        "res/mipmap-xxhdpi-v4/ic_launcher.png",
        "res/mipmap-xhdpi-v4/ic_launcher.png",
        "res/mipmap-mdpi-v4/ic_launcher.png",
    )
    assert info.adaptive == ("res/mipmap-anydpi-v26/ic_launcher.xml",)


def test_when_everything_is_xml_there_is_no_candidate() -> None:
    info = parse_badging(BADGING_ALL_XML)
    assert info == BadgingInfo("com.exemplo.xml", 3, (), ("res/a.xml", "res/b.xml"))


def test_an_any_density_png_is_the_last_choice_among_the_icons() -> None:
    text = (
        "package: name='com.a.b' versionCode='1'\n"
        "application-icon-65534:'res/any.png'\n"
        "application-icon-160:'res/mdpi.png'\n"
    )
    assert parse_badging(text).candidates == ("res/mdpi.png", "res/any.png")


def test_no_banner_is_ever_a_candidate_and_the_activity_icons_come_last() -> None:
    text = (
        "package: name='com.a.b' versionCode='1'\n"
        "application: label='A' icon='res/x.xml' banner='res/app_banner.webp'\n"
        "launchable-activity: name='com.a.b.Main'  label='' icon='res/activity.png'\n"
        "leanback-launchable-activity: name='com.a.b.Tv'  label='' icon='res/tv.png' "
        "banner='res/tv_banner.png'\n"
    )
    info = parse_badging(text)
    assert info.candidates == ("res/activity.png", "res/tv.png")
    assert info.adaptive == ("res/x.xml",)


def test_the_application_icon_line_is_used_when_no_density_lines_exist() -> None:
    text = "package: name='com.a.b' versionCode='9'\napplication: label='A' icon='res/solo.png'\n"
    assert parse_badging(text).candidates == ("res/solo.png",)


def test_repeated_entries_appear_once() -> None:
    text = (
        "package: name='com.a.b' versionCode='1'\n"
        "application-icon-160:'res/i.png'\n"
        "application-icon-320:'res/i.png'\n"
        "application: label='A' icon='res/i.png'\n"
    )
    assert parse_badging(text).candidates == ("res/i.png",)


@pytest.mark.parametrize("text", ["", "lixo qualquer\nsem formato\n", "package:\n"])
def test_text_without_anything_useful_gives_empty_candidates_and_never_raises(text: str) -> None:
    info = parse_badging(text)
    assert info.candidates == ()
    assert info.adaptive == ()
    assert info.version_code is None


def test_version_code_is_optional_in_the_package_line() -> None:
    info = parse_badging("package: name='com.a.b' versionName='1'\n")
    assert (info.package, info.version_code) == ("com.a.b", None)


def test_only_the_first_package_line_counts() -> None:
    text = "package: name='com.a.b' versionCode='1'\npackage: name='outro.x' versionCode='2'\n"
    info = parse_badging(text)
    assert (info.package, info.version_code) == ("com.a.b", 1)


def test_labels_with_escaped_quotes_do_not_break_the_attributes() -> None:
    text = "application: label='Maria\\'s TV' icon='res/a.png' banner='res/b.png'\n"
    assert parse_badging(text).candidates == ("res/a.png",)


def test_crlf_output_from_windows_is_read() -> None:
    text = BADGING_ADAPTIVE_WITH_BANNER.replace("\n", "\r\n")
    assert parse_badging(text).adaptive == ("res/BW.xml",)


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("res/Ec.png", True),
        ("r/a/b.WEBP", True),
        ("res/BW.xml", False),
        ("res/photo.jpg", False),
        ("../res/a.png", False),
        ("res/../../a.png", False),
        ("/res/a.png", False),
        ("res\\a.png", False),
        ("res/a\x00.png", False),
        ("res/a\n.png", False),
        ("", False),
    ],
)
def test_entry_names_are_safe_images_only(path: str, expected: bool) -> None:
    assert is_raster_entry(path) is expected


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("res/BW.xml", True),
        ("res/mipmap-anydpi-v26/ic.XML", True),
        ("res/Ec.png", False),
        ("../res/a.xml", False),
        ("/res/a.xml", False),
        ("", False),
    ],
)
def test_entry_names_of_adaptive_icons_are_safe_xml_only(path: str, expected: bool) -> None:
    assert is_xml_entry(path) is expected


# --- tipo e dimensões pelo cabeçalho ------------------------------------------------------------


def test_the_type_goes_by_content_not_by_extension() -> None:
    assert image_info(png_bytes()) == ImageInfo("image/png", 4, 4)
    assert image_info(webp_bytes()) == ImageInfo("image/webp", 64, 64)
    assert image_info(b"<?xml version='1.0'?><vector/>") is None
    assert image_info(b"") is None
    assert image_info(b"GIF89a" + b"\x00" * 30) is None


def test_a_png_reports_its_size_and_squareness() -> None:
    square = image_info(png_bytes(192, 192))
    assert square == ImageInfo("image/png", 192, 192)
    assert square is not None
    assert square.is_square
    banner = image_info(png_bytes(320, 180))
    assert banner == ImageInfo("image/png", 320, 180)
    assert banner is not None
    assert not banner.is_square


@pytest.mark.parametrize("kind", ["VP8L", "VP8 ", "VP8X"])
def test_the_three_webp_kinds_report_their_size(kind: str) -> None:
    assert image_info(webp_bytes(96, kind=kind)) == ImageInfo("image/webp", 96, 96)
    banner = image_info(webp_bytes(320, 180, kind=kind))
    assert banner == ImageInfo("image/webp", 320, 180)
    assert banner is not None
    assert not banner.is_square


def test_the_webp_size_uses_the_real_dimension_bits() -> None:
    # 14 bits por lado no sem perda; 3 bytes por lado no estendido (valor menos um).
    assert image_info(webp_bytes(16384, 1, kind="VP8L")) is None  # acima do teto
    assert image_info(webp_bytes(4096, 4096, kind="VP8L")) == ImageInfo("image/webp", 4096, 4096)
    assert image_info(webp_bytes(4096, 4096, kind="VP8X")) == ImageInfo("image/webp", 4096, 4096)


def test_an_animated_webp_is_not_an_icon() -> None:
    assert image_info(webp_bytes(64, kind="VP8X", animated=True)) is None


def test_a_webp_with_a_broken_or_unknown_header_is_refused() -> None:
    good = webp_bytes(64, kind="VP8 ")
    broken_start_code = good[:23] + b"\x00\x00\x00" + good[26:]
    assert image_info(broken_start_code) is None
    lossless = webp_bytes(64)
    assert image_info(lossless[:20] + b"\x00" + lossless[21:]) is None  # sem a assinatura
    assert image_info(good[:25]) is None  # truncado
    assert image_info(good[:12] + b"ALPH" + good[16:]) is None  # tipo de bloco desconhecido
    assert image_info(webp_bytes(64, kind="VP8 ")[:26] + b"\x00" * 4) is None  # lado zero


def test_a_png_header_with_absurd_or_missing_dimensions_is_refused() -> None:
    assert image_info(png_bytes(MAX_IMAGE_SIDE + 1, 2)) is None
    assert image_info(png_bytes(MAX_IMAGE_SIDE, 2)) is not None
    assert image_info(png_bytes()[:20]) is None
    zero_width = bytearray(png_bytes())
    zero_width[16:20] = b"\x00\x00\x00\x00"
    assert image_info(bytes(zero_width)) is None
    not_ihdr = bytearray(png_bytes())
    not_ihdr[12:16] = b"IDAT"
    assert image_info(bytes(not_ihdr)) is None
