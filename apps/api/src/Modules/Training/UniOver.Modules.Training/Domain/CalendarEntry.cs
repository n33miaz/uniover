namespace UniOver.Modules.Training.Domain;

/// <summary>
/// Estado pessoal de um dia civil: ausência planejada e uma nota curta. A chave natural é usuário mais dia; remover vira
/// lápide para que outro aparelho também esqueça a anotação.
/// </summary>
public sealed class CalendarEntry
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public DateOnly Day { get; set; }
    public bool Absent { get; set; }
    public string? Note { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public DateTimeOffset ClientUpdatedAt { get; set; }
    public DateTimeOffset? DeletedAt { get; set; }
    public bool IsDeleted => DeletedAt is not null;
}
