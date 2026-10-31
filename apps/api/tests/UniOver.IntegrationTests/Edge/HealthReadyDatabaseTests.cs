using System.Net;
using AwesomeAssertions;
using UniOver.IntegrationTests.Guards;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Edge;

/// <summary><c>/health/ready</c> com o banco de verdade no ar: 200 e só o status no corpo.</summary>
[Collection(PostgresGroup.Name)]
public sealed class HealthReadyDatabaseTests(PostgresFixture postgres)
{
    [Fact]
    public async Task Ready_WithTheDatabaseUp_Returns200WithOnlyTheStatus()
    {
        await using var factory = await GuardHost.StartAsync(postgres, "Production");
        using var client = factory.CreateClient();

        using var response = await client.GetAsync("/health/ready", TestContext.Current.CancellationToken);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        (await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken)).Should().Be("Healthy");
    }
}
