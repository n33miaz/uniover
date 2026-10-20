"""Leitura do `aapt2 dump badging`: escolha dos candidatos a ícone e conferência do conteúdo."""

import pytest

from uniover_agent.core.tv.icon_badging import (
    MAX_PNG_SIDE,
    BadgingInfo,
    detect_mime,
    is_raster_entry,
    parse_badging,
)

from .support_icons import (
    BADGING_ALL_XML,
    BADGING_BANNER_ONLY,
    BADGING_DENSITIES,
    png_bytes,
    webp_bytes,
)


def test_a_real_badging_with_only_xml_icons_falls_back_to_the_banner() -> None:
    info = parse_badging(BADGING_BANNER_ONLY)
    assert info == BadgingInfo("com.cnvs.apptv", 50, ("res/Ec.png",))


def test_png_icons_come_from_the_largest_density_down_and_any_density_xml_is_ignored() -> None:
    info = parse_badging(BADGING_DENSITIES)
    assert info.package == "com.exemplo.player"
    assert info.version_code == 7
    assert info.candidates == (
        "res/mipmap-xxxhdpi-v4/ic_launcher.png",
        "res/mipmap-xxhdpi-v4/ic_launcher.png",
        "res/mipmap-xhdpi-v4/ic_launcher.png",
        "res/mipmap-mdpi-v4/ic_launcher.png",
    )


def test_when_everything_is_xml_there_is_no_candidate() -> None:
    info = parse_badging(BADGING_ALL_XML)
    assert info == BadgingInfo("com.exemplo.xml", 3, ())


def test_an_any_density_png_is_the_last_choice_among_the_icons() -> None:
    text = (
        "package: name='com.a.b' versionCode='1'\n"
        "application-icon-65534:'res/any.png'\n"
        "application-icon-160:'res/mdpi.png'\n"
    )
    assert parse_badging(text).candidates == ("res/mdpi.png", "res/any.png")


def test_the_launcher_banner_comes_before_the_application_banner_and_the_activity_icon_last() -> (
    None
):
    text = (
        "package: name='com.a.b' versionCode='1'\n"
        "application: label='A' icon='res/x.xml' banner='res/app_banner.webp'\n"
        "launchable-activity: name='com.a.b.Main'  label='' icon='res/activity.png'\n"
        "leanback-launchable-activity: name='com.a.b.Tv'  label='' icon='' banner='res/tv.png'\n"
    )
    assert parse_badging(text).candidates == (
        "res/tv.png",
        "res/app_banner.webp",
        "res/activity.png",
    )


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
    assert info.version_code is None


def test_version_code_is_optional_in_the_package_line() -> None:
    info = parse_badging("package: name='com.a.b' versionName='1'\n")
    assert (info.package, info.version_code) == ("com.a.b", None)


def test_only_the_first_package_line_counts() -> None:
    text = "package: name='com.a.b' versionCode='1'\npackage: name='outro.x' versionCode='2'\n"
    info = parse_badging(text)
    assert (info.package, info.version_code) == ("com.a.b", 1)


def test_labels_with_escaped_quotes_do_not_break_the_attributes() -> None:
    text = "application: label='Maria\\'s TV' icon='res/a.xml' banner='res/b.png'\n"
    assert parse_badging(text).candidates == ("res/b.png",)


def test_crlf_output_from_windows_is_read() -> None:
    text = BADGING_BANNER_ONLY.replace("\n", "\r\n")
    assert parse_badging(text).candidates == ("res/Ec.png",)


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


def test_detect_mime_goes_by_content_not_by_extension() -> None:
    assert detect_mime(png_bytes()) == "image/png"
    assert detect_mime(webp_bytes()) == "image/webp"
    assert detect_mime(b"<?xml version='1.0'?><vector/>") is None
    assert detect_mime(b"") is None
    assert detect_mime(b"GIF89a" + b"\x00" * 30) is None


def test_a_png_header_with_absurd_or_missing_dimensions_is_refused() -> None:
    assert detect_mime(png_bytes(MAX_PNG_SIDE + 1, 2)) is None
    assert detect_mime(png_bytes(MAX_PNG_SIDE, 2)) == "image/png"
    assert detect_mime(png_bytes()[:20]) is None
    zero_width = bytearray(png_bytes())
    zero_width[16:20] = b"\x00\x00\x00\x00"
    assert detect_mime(bytes(zero_width)) is None
