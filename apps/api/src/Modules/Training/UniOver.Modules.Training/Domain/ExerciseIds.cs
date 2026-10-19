using System.Diagnostics.CodeAnalysis;
using System.Security.Cryptography;
using System.Text;

namespace UniOver.Modules.Training.Domain;

/// <summary>
/// Id determinístico do exercício de catálogo: UUID v5 sobre <c>source:sourceRef</c>. O mesmo exercício precisa ter o
/// mesmo id em todo ambiente (o aparelho, a rotina e o histórico o referenciam). É exceção à regra de UUID v7, que
/// vale para o que nasce no aparelho (exercício próprio).
/// </summary>
public static class ExerciseIds
{
    // Namespace fixo do catálogo. Mudar este valor muda todos os ids: nunca mexer.
    private static readonly Guid CatalogNamespace = new("6f1d4a52-3c7e-5b1f-9a8d-2e4c7b90a1d3");

    public static Guid ForCatalog(string source, string sourceRef)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(source);
        ArgumentException.ThrowIfNullOrWhiteSpace(sourceRef);
        return CreateV5(CatalogNamespace, $"{source}:{sourceRef}");
    }

    /// <summary>RFC 9562, seção 5.5: SHA-1 do namespace (em ordem de rede) seguido do nome.</summary>
    [SuppressMessage("Security", "CA5350:Do Not Use Weak Cryptographic Algorithms",
        Justification = "O UUID v5 é definido sobre SHA-1 pela RFC 9562; aqui só gera um identificador estável, nunca protege segredo.")]
    internal static Guid CreateV5(Guid ns, string name)
    {
        var nsBytes = ns.ToByteArray(bigEndian: true);
        var nameBytes = Encoding.UTF8.GetBytes(name);
        var input = new byte[nsBytes.Length + nameBytes.Length];
        nsBytes.CopyTo(input, 0);
        nameBytes.CopyTo(input, nsBytes.Length);

        var hash = SHA1.HashData(input);
        var bytes = hash.AsSpan(0, 16).ToArray();
        bytes[6] = (byte)((bytes[6] & 0x0F) | 0x50);
        bytes[8] = (byte)((bytes[8] & 0x3F) | 0x80);
        return new Guid(bytes, bigEndian: true);
    }
}
