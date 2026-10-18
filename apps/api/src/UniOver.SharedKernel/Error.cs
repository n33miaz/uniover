namespace UniOver.SharedKernel;

/// <summary>Falha esperada de negócio: código estável (para o cliente) e mensagem legível.</summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage("Naming", "CA1716", Justification = "O nome Error e parte do contrato do SharedKernel (Result/Error).")]
public sealed record Error(string Code, string Message)
{
    public static readonly Error None = new(string.Empty, string.Empty);
}
