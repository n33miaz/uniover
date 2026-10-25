using System.Buffers.Binary;
using JpegLibrary;

namespace UniOver.Modules.Training.Features.ProgressPhotos;

internal sealed record ValidatedJpeg(int Width, int Height, string Sha256, byte[] Content);

internal static class JpegPhotoValidator
{
    public const int MaxBytes = 5 * 1024 * 1024;
    private const int MaxDimension = 1280;
    private const long MaxPixels = 1_638_400;
    private static readonly HashSet<byte> StartOfFrame = [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf];

    public static bool TryNormalize(ReadOnlySpan<byte> input, out ValidatedJpeg? photo)
    {
        photo = null;
        var bytes = RemovePersonalMetadata(input);
        if (bytes.Length is < 4 or > MaxBytes || bytes[0] != 0xff || bytes[1] != 0xd8 || bytes[^2] != 0xff || bytes[^1] != 0xd9)
            return false;

        var position = 2;
        var width = 0;
        var height = 0;
        while (position < bytes.Length - 2)
        {
            if (bytes[position++] != 0xff) return false;
            while (position < bytes.Length && bytes[position] == 0xff) position++;
            if (position >= bytes.Length) return false;
            var marker = bytes[position++];
            if (marker is 0xd8 or 0xd9 || marker is >= 0xd0 and <= 0xd7 || marker == 0x01) continue;
            if (position + 2 > bytes.Length) return false;
            var length = BinaryPrimitives.ReadUInt16BigEndian(bytes.AsSpan(position));
            if (length < 2 || position + length > bytes.Length) return false;
            if (StartOfFrame.Contains(marker))
            {
                if (length < 8) return false;
                height = BinaryPrimitives.ReadUInt16BigEndian(bytes.AsSpan(position + 3));
                width = BinaryPrimitives.ReadUInt16BigEndian(bytes.AsSpan(position + 5));
                if (width is < 1 or > MaxDimension || height is < 1 or > MaxDimension || (long)width * height > MaxPixels)
                    return false;
            }
            position += length;
            if (marker == 0xda) break;
        }

        if (width == 0 || height == 0) return false;
        try
        {
            // Ler até o fim força a decodificação dos blocos de imagem; cabeçalho + EOI não prova JPEG legível.
            var decoder = new JpegDecoder();
            decoder.SetInput(bytes.ToArray());
            decoder.SetOutputWriter(DiscardJpegBlocks.Instance);
            decoder.Decode();
            if (decoder.Width != width || decoder.Height != height)
                return false;
        }
        catch (Exception exception) when (exception is ArgumentException or InvalidDataException or EndOfStreamException or IndexOutOfRangeException or InvalidOperationException)
        { return false; }
        photo = new ValidatedJpeg(width, height, Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(bytes)), bytes);
        return true;
    }

    public static bool TryValidate(ReadOnlySpan<byte> bytes, out ValidatedJpeg? photo) => TryNormalize(bytes, out photo);

    private static byte[] RemovePersonalMetadata(ReadOnlySpan<byte> input)
    {
        if (input.Length < 4 || input[0] != 0xff || input[1] != 0xd8)
            return input.ToArray();

        using var output = new MemoryStream(input.Length);
        output.Write(input[..2]);
        var position = 2;
        while (position < input.Length)
        {
            var markerStart = position;
            if (input[position++] != 0xff)
                return input.ToArray();
            while (position < input.Length && input[position] == 0xff) position++;
            if (position >= input.Length) return input.ToArray();

            var marker = input[position++];
            if (marker == 0xda)
            {
                output.Write(input[markerStart..]);
                return output.ToArray();
            }
            if (marker is 0xd8 or 0xd9 || marker is >= 0xd0 and <= 0xd7 || marker == 0x01)
            {
                output.Write(input[markerStart..position]);
                continue;
            }
            if (position + 2 > input.Length) return input.ToArray();

            var length = BinaryPrimitives.ReadUInt16BigEndian(input[position..]);
            var segmentEnd = position + length;
            if (length < 2 || segmentEnd > input.Length) return input.ToArray();
            // APP1 (EXIF e XMP, com localização), APP13 (IPTC) e comentários podem carregar dado pessoal: não vão para o objeto.
            if (marker is not (0xe1 or 0xed or 0xfe)) output.Write(input[markerStart..segmentEnd]);
            position = segmentEnd;
        }
        return output.ToArray();
    }
}
