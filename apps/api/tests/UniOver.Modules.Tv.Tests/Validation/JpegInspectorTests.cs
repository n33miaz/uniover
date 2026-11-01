using AwesomeAssertions;
using UniOver.Modules.Tv.Features.TvLivre;
using UniOver.Modules.Tv.Tests.Support;

namespace UniOver.Modules.Tv.Tests.Validation;

public class JpegInspectorTests
{
    private static readonly byte[] Eoi = [0xFF, 0xD9];

    private static byte[] Join(params byte[][] parts) => [.. parts.SelectMany(part => part)];

    // ---- o que vale ----

    [Fact]
    public void AMinimalJpeg_IsValid_AndTheDimensionsComeFromTheHeader()
    {
        var jpeg = JpegFixture.Build(1920, 1080);

        JpegInspector.Inspect(jpeg, out var width, out var height).Should().Be(JpegCheck.Valid);
        width.Should().Be(1920);
        height.Should().Be(1080);
    }

    [Theory]
    [InlineData(1, 1)]
    [InlineData(4096, 4096)]
    [InlineData(4096, 1)]
    public void TheDimensionLimits_AreInclusive(int width, int height) =>
        JpegInspector.Inspect(JpegFixture.Build(width, height)).Should().Be(JpegCheck.Valid);

    [Fact]
    public void ABigJpegWithManyBytesInTheScan_IsValid() =>
        JpegInspector.Inspect(JpegFixture.Build(640, 360, 400 * 1024)).Should().Be(JpegCheck.Valid);

    [Fact]
    public void StuffedBytesAndRestartsInsideTheScan_AreNotMarkers()
    {
        byte[] scanData = [0x12, 0xFF, 0x00, 0x34, 0xFF, 0xD0, 0x56, 0xFF, 0xD7, 0x78, 0xFF, 0x00];

        var jpeg = Join(JpegFixture.Head(100, 50), scanData, Eoi);

        JpegInspector.Inspect(jpeg).Should().Be(JpegCheck.Valid);
    }

    [Fact]
    public void FillBytesBeforeAMarker_AreSkipped()
    {
        var jpeg = Join(JpegFixture.Head(100, 50), [0x12, 0x34], [0xFF, 0xFF, 0xFF, 0xD9]);

        JpegInspector.Inspect(jpeg).Should().Be(JpegCheck.Valid);
    }

    [Fact]
    public void SeveralScans_LikeAProgressiveJpeg_AreValid()
    {
        var jpeg = Join(JpegFixture.Head(300, 200), [0x12, 0x34], JpegFixture.Scan(), [0x56, 0x78], Eoi);

        JpegInspector.Inspect(jpeg).Should().Be(JpegCheck.Valid);
    }

    [Fact]
    public void OtherSegmentsBeforeTheFrame_LikeJfifAndATableDefinition_AreFine()
    {
        byte[] app0 = [0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
        // DHT (C4) tem o mesmo prefixo de um quadro, mas não é um: não pode contar como SOF nem barrar o arquivo.
        byte[] dht = [0xFF, 0xC4, 0x00, 0x05, 0x00, 0x01, 0x02];
        var jpeg = Join([0xFF, 0xD8], app0, dht, JpegFixture.Frame(64, 48), JpegFixture.Scan(), [0x12], Eoi);

        JpegInspector.Inspect(jpeg, out var width, out var height).Should().Be(JpegCheck.Valid);
        width.Should().Be(64);
        height.Should().Be(48);
    }

    // ---- dimensões ----

    [Theory]
    [InlineData(0, 100)]
    [InlineData(100, 0)]
    [InlineData(4097, 100)]
    [InlineData(100, 4097)]
    [InlineData(65535, 65535)]
    public void DimensionsOutOfRange_AreReportedApart(int width, int height) =>
        JpegInspector.Inspect(JpegFixture.Build(width, height)).Should().Be(JpegCheck.DimensionsOutOfRange);

    // ---- o que não é JPEG ----

    [Fact]
    public void ATruncatedJpeg_IsRefused_AtAnyCut()
    {
        var jpeg = JpegFixture.Build(640, 360, 200);

        for (var length = 0; length < jpeg.Length; length++)
        {
            JpegInspector.Inspect(jpeg.AsSpan(0, length)).Should().Be(JpegCheck.NotJpeg, $"cortado em {length} bytes");
        }
    }

    [Fact]
    public void AJpegWithoutAFrame_IsRefused() =>
        JpegInspector.Inspect(Join([0xFF, 0xD8], JpegFixture.Scan(), [0x12], Eoi)).Should().Be(JpegCheck.NotJpeg);

    [Fact]
    public void AJpegWithoutAScan_IsRefused() =>
        JpegInspector.Inspect(Join([0xFF, 0xD8], JpegFixture.Frame(100, 100), Eoi)).Should().Be(JpegCheck.NotJpeg);

    [Fact]
    public void AJpegWithTwoFrames_IsRefused() =>
        JpegInspector.Inspect(Join([0xFF, 0xD8], JpegFixture.Frame(100, 100), JpegFixture.Frame(200, 200), JpegFixture.Scan(), [0x12], Eoi))
            .Should().Be(JpegCheck.NotJpeg);

    [Fact]
    public void AJpegWithBytesAfterTheEoi_IsRefused() =>
        JpegInspector.Inspect(Join(JpegFixture.Build(100, 100), [0x00])).Should().Be(JpegCheck.NotJpeg);

    [Fact]
    public void ThreeMagicBytesFollowedByNoise_AreRefused()
    {
        var noise = new byte[5000];
        new Random(5).NextBytes(noise);
        noise[0] = 0xFF;
        noise[1] = 0xD8;
        noise[2] = 0xFF;

        JpegInspector.Inspect(noise).Should().Be(JpegCheck.NotJpeg);
    }

    [Theory]
    [InlineData(new byte[] { })]
    [InlineData(new byte[] { 0xFF })]
    [InlineData(new byte[] { 0xFF, 0xD8 })]
    [InlineData(new byte[] { 0xFF, 0xD8, 0xFF, 0xD9 })]
    [InlineData(new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A })]
    [InlineData(new byte[] { 0x47, 0x49, 0x46, 0x38, 0x39, 0x61 })]
    public void SomethingThatIsNotAJpeg_IsRefused(byte[] data) =>
        JpegInspector.Inspect(data).Should().Be(JpegCheck.NotJpeg);

    [Theory]
    [InlineData(0x00, 0x00)]
    [InlineData(0x00, 0x01)]
    [InlineData(0x7F, 0xFF)]
    public void ASegmentWithAnImpossibleLength_IsRefused(byte high, byte low)
    {
        // Comprimento 0 ou 1 (menor que os dois bytes que o próprio campo ocupa) ou maior que o arquivo.
        var jpeg = Join([0xFF, 0xD8, 0xFF, 0xE0, high, low], JpegFixture.Frame(10, 10), JpegFixture.Scan(), [0x12], Eoi);

        JpegInspector.Inspect(jpeg).Should().Be(JpegCheck.NotJpeg);
    }

    [Fact]
    public void AFrameWithoutRoomForItsComponents_IsRefused()
    {
        // Diz três componentes, mas o segmento só tem espaço para um.
        byte[] frame = [0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x64, 0x00, 0x64, 0x03, 0x01, 0x11, 0x00];

        JpegInspector.Inspect(Join([0xFF, 0xD8], frame, JpegFixture.Scan(), [0x12], Eoi)).Should().Be(JpegCheck.NotJpeg);
    }

    [Fact]
    public void AScanBeforeTheFrame_IsRefused() =>
        JpegInspector.Inspect(Join([0xFF, 0xD8], JpegFixture.Scan(), [0x12], JpegFixture.Frame(10, 10), Eoi)).Should().Be(JpegCheck.NotJpeg);

    [Fact]
    public void ASecondSoiInTheMiddle_IsRefused() =>
        JpegInspector.Inspect(Join([0xFF, 0xD8, 0xFF, 0xD8], JpegFixture.Frame(10, 10), JpegFixture.Scan(), [0x12], Eoi)).Should().Be(JpegCheck.NotJpeg);
}
