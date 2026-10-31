using AwesomeAssertions;
using UniOver.Modules.Tv.Features.TvLivre;

namespace UniOver.Modules.Tv.Tests.Validation;

public class LivrePhotoTests
{
    private static byte[] Photo(int length)
    {
        var data = new byte[length];
        new Random(42).NextBytes(data);
        if (length >= 3)
        {
            data[0] = 0xFF;
            data[1] = 0xD8;
            data[2] = 0xFF;
        }

        return data;
    }

    [Fact]
    public void ThePhotoLimit_Is400KiB_AndAChunkIs30000Bytes()
    {
        LivrePhoto.MaxBytes.Should().Be(409600);
        LivrePhoto.ChunkBytes.Should().Be(30000);
    }

    [Fact]
    public void ThePhotoAtTheLimit_FitsInTheChunksTheContractAllows()
    {
        var chunks = LivrePhoto.Slice(Photo(LivrePhoto.MaxBytes));

        chunks.Count.Should().Be(14);
        chunks.Count.Should().BeLessThanOrEqualTo(LivrePhoto.MaxChunks);
    }

    [Theory]
    [InlineData(1, 1)]
    [InlineData(29999, 1)]
    [InlineData(30000, 1)]
    [InlineData(30001, 2)]
    [InlineData(60000, 2)]
    [InlineData(60001, 3)]
    [InlineData(400 * 1024, 14)]
    public void Slice_CutsInChunksOf30000Bytes_AndTheLastOneTakesTheRest(int length, int expectedChunks)
    {
        var chunks = LivrePhoto.Slice(Photo(length));

        chunks.Count.Should().Be(expectedChunks);
        chunks.Take(chunks.Count - 1).Should().OnlyContain(chunk => chunk.Length == LivrePhoto.ChunkBytes);
        chunks[^1].Length.Should().Be(length - (expectedChunks - 1) * LivrePhoto.ChunkBytes);
        chunks.Sum(chunk => chunk.Length).Should().Be(length);
    }

    [Fact]
    public void Slice_GivesBackTheSameBytes_InOrder()
    {
        var photo = Photo(95000);

        var joined = LivrePhoto.Slice(photo).SelectMany(chunk => chunk).ToArray();

        joined.Should().Equal(photo);
    }

    [Fact]
    public void Slice_RefusesAnEmptyPhotoOrOneAboveTheLimit()
    {
        var empty = () => LivrePhoto.Slice([]);
        var large = () => LivrePhoto.Slice(new byte[LivrePhoto.MaxBytes + 1]);

        empty.Should().Throw<ArgumentOutOfRangeException>();
        large.Should().Throw<ArgumentOutOfRangeException>();
    }

    [Fact]
    public void Sha256Hex_IsLowercaseHexOf64Characters_AsTheContractAsks()
    {
        var hash = LivrePhoto.Sha256Hex("abc"u8);

        hash.Should().Be("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        hash.Should().MatchRegex("^[0-9a-f]{64}$");
    }

    [Theory]
    [InlineData(new byte[] { 0xFF, 0xD8, 0xFF, 0xE0 }, true)]
    [InlineData(new byte[] { 0xFF, 0xD8, 0xFF }, true)]
    [InlineData(new byte[] { 0xFF, 0xD8 }, false)]
    [InlineData(new byte[] { 0x89, 0x50, 0x4E, 0x47 }, false)]
    [InlineData(new byte[] { }, false)]
    public void LooksLikeJpeg_ChecksTheThreeMagicBytes(byte[] data, bool expected) =>
        LivrePhoto.LooksLikeJpeg(data).Should().Be(expected);
}
