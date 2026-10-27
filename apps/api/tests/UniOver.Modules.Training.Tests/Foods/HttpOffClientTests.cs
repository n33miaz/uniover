using System.Net;
using AwesomeAssertions;
using Microsoft.Extensions.Options;
using UniOver.Modules.Identity.Contracts;
using UniOver.Modules.Training;
using UniOver.Modules.Training.Adapters.Foods;

namespace UniOver.Modules.Training.Tests.Foods;

public sealed class HttpOffClientTests
{
    [Fact]
    public async Task Search_UsesFixedOfficialLegacySearchHostAndIdentifyingUserAgent()
    {
        var handler = new CaptureHandler("""{"products":[{"code":"12345678","product_name":"Arroz","brands":"Marca","nutriments":{"energy-kcal_100g":130,"proteins_100g":2,"carbohydrates_100g":28,"fat_100g":0.3}}]}""");
        using var http = new HttpClient(handler);
        var options = Options.Create(new TrainingModuleOptions { Version = "0.1.0" });
        var client = new HttpOffClient(http, options, new FakeSettings("foods@uniover.test"));

        var result = await client.SearchAsync("arroz integral", CancellationToken.None);

        result.Items.Should().ContainSingle().Which.Kcal.Should().Be(130m);
        handler.Uri!.Host.Should().Be("world.openfoodfacts.org");
        handler.Uri.AbsolutePath.Should().Be("/cgi/search.pl");
        handler.Uri.Query.Should().Contain("search_terms=arroz%20integral");
        handler.UserAgent.Should().Be("UniOver/0.1.0 (foods@uniover.test)");
        handler.Uri.ToString().Should().NotContain("http://");
    }

    [Fact]
    public async Task Lookup_UsesCurrentProductApiV36AndFixedHost()
    {
        var handler = new CaptureHandler("""{"status":1,"product":{"code":"12345678","product_name":"Arroz","nutriments":{"energy-kcal_100g":130,"proteins_100g":2,"carbohydrates_100g":28,"fat_100g":0.3}}}""");
        using var http = new HttpClient(handler);
        var client = new HttpOffClient(http, Options.Create(new TrainingModuleOptions()), new FakeSettings("foods@uniover.test"));

        var result = await client.LookupAsync("12345678", CancellationToken.None);

        result!.Barcode.Should().Be("12345678");
        handler.Uri!.AbsolutePath.Should().Be("/api/v3.6/product/12345678.json");
        handler.Uri.Host.Should().Be("world.openfoodfacts.org");
    }

    [Fact]
    public async Task SearchAndLookup_DiscardProductsWithIncompleteNutritionInsteadOfInventingZeros()
    {
        const string body = """{"products":[{"code":"11111111","product_name":"Sem energia","nutriments":{"proteins_100g":2,"carbohydrates_100g":3,"fat_100g":4}},{"code":"22222222","product_name":"Sem proteína","nutriments":{"energy-kcal_100g":10,"carbohydrates_100g":3,"fat_100g":4}},{"code":"33333333","product_name":"Completo","nutriments":{"energy_100g":41.84,"proteins_100g":2,"carbohydrates_100g":3,"fat_100g":4}}]}""";
        var handler = new CaptureHandler(body);
        using var http = new HttpClient(handler);
        var client = new HttpOffClient(http, Options.Create(new TrainingModuleOptions()), new FakeSettings("foods@uniover.test"));

        var search = await client.SearchAsync("produto", CancellationToken.None);
        search.Items.Should().ContainSingle().Which.Should().BeEquivalentTo(
            new UniOver.Modules.Training.Ports.Foods.OffFoodData("33333333", "Completo", null, 10m, 2m, 3m, 4m));

        handler.SetResponse("""{"status":1,"product":{"code":"11111111","product_name":"Sem energia","nutriments":{"proteins_100g":2,"carbohydrates_100g":3,"fat_100g":4}}}""");
        (await client.LookupAsync("11111111", CancellationToken.None)).Should().BeNull();
    }

    [Fact]
    public async Task MissingContact_RefusesBeforeNetworkCall()
    {
        var handler = new CaptureHandler("{}");
        using var http = new HttpClient(handler);
        var client = new HttpOffClient(http, Options.Create(new TrainingModuleOptions()), new FakeSettings(""));

        await Assert.ThrowsAsync<InvalidOperationException>(() => client.LookupAsync("12345678", CancellationToken.None));
        handler.Calls.Should().Be(0);
    }

    [Fact]
    public async Task InvalidContact_RefusesBeforeNetworkCall()
    {
        var handler = new CaptureHandler("{}");
        using var http = new HttpClient(handler);
        var client = new HttpOffClient(http, Options.Create(new TrainingModuleOptions()), new FakeSettings("nome <foods@example.test>"));

        await Assert.ThrowsAsync<InvalidOperationException>(() => client.LookupAsync("12345678", CancellationToken.None));

        handler.Calls.Should().Be(0);
    }

    [Fact]
    public async Task Search_UsesUpdatedContactOnTheNextRequest()
    {
        var handler = new CaptureHandler("""{"products":[]}""");
        using var http = new HttpClient(handler);
        var settings = new FakeSettings("first@example.test");
        var client = new HttpOffClient(http, Options.Create(new TrainingModuleOptions()), settings);
        await client.SearchAsync("arroz", CancellationToken.None);
        settings.Contact = "next@example.test";
        await client.SearchAsync("arroz", CancellationToken.None);
        handler.UserAgent.Should().Contain("next@example.test");
    }

    private sealed class FakeSettings(string contact) : ISystemSettings
    {
        public string Contact { get; set; } = contact;
        public Task<string> OffContactAsync(CancellationToken cancellationToken = default) => Task.FromResult(Contact);
        public Task<int> MaxComputersPerGuestAsync(CancellationToken cancellationToken = default) => Task.FromResult(2);
        public Task<bool> PhotoStorageEnabledAsync(CancellationToken cancellationToken = default) => Task.FromResult(false);
    }

    private sealed class CaptureHandler(string body) : HttpMessageHandler
    {
        private string _body = body;
        public int Calls { get; private set; }
        public Uri? Uri { get; private set; }
        public string? UserAgent { get; private set; }

        public void SetResponse(string response) => _body = response;

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Calls++;
            Uri = request.RequestUri;
            UserAgent = request.Headers.UserAgent.ToString();
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(_body, System.Text.Encoding.UTF8, "application/json"),
            });
        }
    }
}
