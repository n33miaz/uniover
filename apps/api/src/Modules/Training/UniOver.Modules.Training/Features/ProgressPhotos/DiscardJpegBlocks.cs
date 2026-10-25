using JpegLibrary;

namespace UniOver.Modules.Training.Features.ProgressPhotos;

/// <summary>Decodifica todos os blocos sem montar pixels, pois a API guarda os bytes JPEG originais reduzidos pelo navegador.</summary>
internal sealed class DiscardJpegBlocks : JpegBlockOutputWriter
{
    public static DiscardJpegBlocks Instance { get; } = new();
    private DiscardJpegBlocks() { }
    public override void WriteBlock(ref short block, int componentIndex, int blockX, int blockY) { }
}
