using AwesomeAssertions;
using UniOver.Modules.Training.Features.ProgressPhotos;

namespace UniOver.Modules.Training.Tests.ProgressPhoto;

public sealed class JpegPhotoValidatorTests
{
    // JPEG de 12x8 gerado de pixels sintéticos uniformes; nenhum dado pessoal.
    private static readonly byte[] Valid = Convert.FromBase64String("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAIAAwDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDgqKKK9s8I/9k=");

    [Fact]
    public void AcceptsJpegWithBoundedDimensionsAndReturnsHash()
    {
        JpegPhotoValidator.TryValidate(Valid, out var photo).Should().BeTrue();
        photo.Should().NotBeNull();
        photo!.Width.Should().Be(12);
        photo.Height.Should().Be(8);
        photo.Sha256.Should().HaveLength(64);
    }

    [Fact]
    public void RejectsWrongSignatureTruncationAndOversizedDimensions()
    {
        JpegPhotoValidator.TryValidate([0x89, 0x50, 0x4e, 0x47], out _).Should().BeFalse();
        JpegPhotoValidator.TryValidate(Valid.AsSpan(0, Valid.Length - 1), out _).Should().BeFalse();
        var tooWide = Valid.ToArray();
        var frameMarker = Array.IndexOf(tooWide, (byte)0xc0);
        tooWide[frameMarker + 7] = 0x06;
        tooWide[frameMarker + 8] = 0x40;
        JpegPhotoValidator.TryValidate(tooWide, out _).Should().BeFalse();
    }

    [Fact]
    public void RejectsHeaderWithEndMarkerButNoDecodableScan()
    {
        var headerOnly = new byte[] { 0xff, 0xd8, 0xff, 0xc0, 0x00, 0x08, 0x08, 0x00, 0x08, 0x00, 0x0c, 0x01, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9 };
        JpegPhotoValidator.TryValidate(headerOnly, out _).Should().BeFalse();
    }

    [Fact]
    public void RemovesExifBeforePersistingTheValidatedJpeg()
    {
        var withExif = new byte[Valid.Length + 10];
        Valid[..2].CopyTo(withExif, 0);
        new byte[] { 0xff, 0xe1, 0x00, 0x08, (byte)'E', (byte)'x', (byte)'i', (byte)'f', 0x00, 0x00 }.CopyTo(withExif, 2);
        Valid[2..].CopyTo(withExif, 12);

        JpegPhotoValidator.TryNormalize(withExif, out var photo).Should().BeTrue();
        photo!.Content.AsSpan().IndexOf("Exif"u8).Should().Be(-1);
        photo.Content.Length.Should().Be(Valid.Length);
    }

    [Fact]
    public void RemovesIptcAndCommentSegmentsToo_ButKeepsTheImageDecodable()
    {
        byte[] iptc = [0xff, 0xed, 0x00, 0x06, (byte)'I', (byte)'p', (byte)'t', (byte)'c'];
        byte[] comment = [0xff, 0xfe, 0x00, 0x06, (byte)'N', (byte)'o', (byte)'m', (byte)'e'];
        var input = Valid[..2].Concat(iptc).Concat(comment).Concat(Valid[2..]).ToArray();

        JpegPhotoValidator.TryNormalize(input, out var photo).Should().BeTrue();
        photo!.Content.AsSpan().IndexOf("Iptc"u8).Should().Be(-1);
        photo.Content.AsSpan().IndexOf("Nome"u8).Should().Be(-1);
        photo.Content.Length.Should().Be(Valid.Length);
    }
}
