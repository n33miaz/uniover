namespace UniOver.SharedKernel;

/// <summary>Evento publicado entre módulos; o <see cref="Type"/> é versionado (ex.: "tv.state-changed.v1").</summary>
public interface IIntegrationEvent
{
    Guid Id { get; }

    DateTimeOffset OccurredAt { get; }

    string Type { get; }
}
