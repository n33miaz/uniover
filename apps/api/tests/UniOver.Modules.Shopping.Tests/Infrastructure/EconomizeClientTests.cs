using System.Net;
using System.Text;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.Extensions.Options;
using UniOver.Modules.Shopping.Infrastructure;

namespace UniOver.Modules.Shopping.Tests.Infrastructure;

public sealed class EconomizeClientTests
{
    private const string Key = "eco_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private sealed class Handler(Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
    {
        public List<HttpRequestMessage> Requests { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add(request);
            return Task.FromResult(respond(request));
        }
    }

    private static EconomizeOptions Options(bool enabled = true, string baseUrl = "https://economize.test", string key = Key) =>
        new() { Enabled = enabled, BaseUrl = baseUrl, ApiKey = key };

    private static HttpEconomizeClient Client(Handler handler, EconomizeOptions? economize = null) =>
        new(
            new HttpClient(handler),
            Microsoft.Extensions.Options.Options.Create(new ShoppingModuleOptions { Economize = economize ?? Options() }),
            new EconomizeThrottle(TimeProvider.System));

    private static HttpResponseMessage Json(string value) => new(HttpStatusCode.OK) { Content = new StringContent(value, Encoding.UTF8, "application/json") };

    [Fact]
    public void Advice_reads_best_day_inside_income_pattern_and_free_in_cents()
    {
        using var json = JsonDocument.Parse("""
            {
              "generatedAt": "2026-11-12T12:00:00Z",
              "incomePattern": { "status": "READY", "sources": [{ "pattern": { "median": 5, "expectedAmount": 4321.5 } }],
                                 "advice": { "bestDay": "2026-11-20", "bestDayWeekday": "FRIDAY" } },
              "free": { "salaryKnown": true, "salaryDate": "2026-11-30", "daysUntilSalary": 18, "expectedSalaryCents": 10000,
                        "committedBeforeSalaryCents": 2000, "committedAfterSalaryCents": 3000, "freeCents": 5000 }
            }
            """);

        var advice = EconomizeMapping.ParseAdvice(json.RootElement)!;

        advice.Status.Should().Be("READY");
        advice.BestDay.Should().Be(new DateOnly(2026, 11, 20));
        advice.BestDayWeekday.Should().Be("FRIDAY");
        advice.Free!.FreeCents.Should().Be(5000);
        advice.Free.SalaryDate.Should().Be(new DateOnly(2026, 11, 30));
    }

    [Fact]
    public void Advice_without_ready_pattern_or_salary_is_still_advice()
    {
        using var json = JsonDocument.Parse("""
            { "generatedAt": "2026-11-12T12:00:00Z", "incomePattern": { "status": "NO_INCOME", "advice": null }, "free": null }
            """);

        var advice = EconomizeMapping.ParseAdvice(json.RootElement)!;

        advice.Status.Should().Be("NO_INCOME");
        advice.BestDay.Should().BeNull();
        advice.Free.Should().BeNull();
    }

    [Fact]
    public void Trips_tolerate_null_prices_and_quantities_and_skip_unreadable_trips()
    {
        using var json = JsonDocument.Parse("""
            {
              "trips": [
                { "id": "0199a0b0-0000-7000-8000-000000000001", "own": true, "status": "CLOSED", "startedAt": "2026-11-01T10:00:00Z",
                  "closedAt": "2026-11-01T11:00:00Z", "paidTotalCents": 1234, "receiptTotalCents": null, "itemsTotalCents": 1200,
                  "items": [ { "name": "Café", "quantity": 1, "unitPriceCents": 1234, "checked": true },
                             { "name": "Lista", "quantity": null, "unitPriceCents": null, "checked": false },
                             { "name": "Texto", "quantity": "2", "unitPriceCents": "9", "checked": true } ] },
                { "id": "não é uuid", "own": true, "status": "CLOSED", "startedAt": "2026-11-01T10:00:00Z", "items": [] }
              ],
              "nextCursor": null,
              "hasMore": false
            }
            """);

        var page = EconomizeMapping.ParseTrips(json.RootElement)!;

        var trip = page.Trips.Should().ContainSingle().Subject;
        trip.PaidTotalCents.Should().Be(1234);
        trip.Items.Should().HaveCount(3);
        trip.Items[1].UnitPriceCents.Should().BeNull();
        trip.Items[2].Quantity.Should().BeNull("número em texto não é número");
        page.NextCursor.Should().BeNull();
        page.HasMore.Should().BeFalse();
    }

    [Fact]
    public async Task Trips_send_the_key_limit_and_escaped_cursor()
    {
        var handler = new Handler(_ => Json("""{ "trips": [], "nextCursor": "next", "hasMore": true }"""));

        var result = await Client(handler).GetTripsAsync("a b&c", 200, Ct);

        result.Status.Should().Be(EconomizeFetchStatus.Available);
        result.Page!.NextCursor.Should().Be("next");
        var request = handler.Requests.Single();
        request.RequestUri!.AbsoluteUri.Should().Be("https://economize.test/api/v1/integration/shopping/trips?limit=200&cursor=a%20b%26c");
        request.Headers.Authorization!.ToString().Should().Be("Bearer " + Key);
    }

    [Fact]
    public async Task Advice_sends_the_etag_back_and_understands_not_modified()
    {
        var handler = new Handler(_ => new HttpResponseMessage(HttpStatusCode.NotModified));

        var result = await Client(handler).GetAdviceAsync("\"abc\"", Ct);

        result.Status.Should().Be(EconomizeFetchStatus.NotModified);
        handler.Requests.Single().Headers.IfNoneMatch.Single().Tag.Should().Be("\"abc\"");
    }

    [Theory]
    [InlineData(HttpStatusCode.Unauthorized, nameof(EconomizeFetchStatus.Unauthorized))]
    [InlineData(HttpStatusCode.BadRequest, nameof(EconomizeFetchStatus.InvalidCursor))]
    [InlineData(HttpStatusCode.TooManyRequests, nameof(EconomizeFetchStatus.RateLimited))]
    [InlineData(HttpStatusCode.BadGateway, nameof(EconomizeFetchStatus.Unavailable))]
    [InlineData(HttpStatusCode.Found, nameof(EconomizeFetchStatus.Unavailable))]
    public async Task Failures_become_a_state_never_an_exception(HttpStatusCode code, string expected)
    {
        var handler = new Handler(_ => new HttpResponseMessage(code) { Content = new StringContent(Key) });

        var result = await Client(handler).GetTripsAsync(null, 200, Ct);

        result.Status.ToString().Should().Be(expected);
        result.Page.Should().BeNull();
    }

    [Fact]
    public async Task Broken_json_is_unavailable()
    {
        var handler = new Handler(_ => Json("{ não é json"));

        (await Client(handler).GetAdviceAsync(null, Ct)).Status.Should().Be(EconomizeFetchStatus.Unavailable);
    }

    [Theory]
    [InlineData(false, "https://economize.test", Key)]
    [InlineData(true, "https://economize.test", "")]
    [InlineData(true, "https://economize.test", "eco_curta")]
    [InlineData(true, "https://economize.test", "sk_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")]
    [InlineData(true, "https://economize.test", Key + "\r\nX-Other: 1")]
    [InlineData(true, "https://economize.test", Key + "\n")]
    [InlineData(true, "", Key)]
    [InlineData(true, "http://economize.test", Key)]
    [InlineData(true, "https://user:pass@economize.test", Key)]
    [InlineData(true, "https://economize.test/?x=1", Key)]
    public async Task Off_or_incomplete_configuration_sends_nothing(bool enabled, string baseUrl, string key)
    {
        var handler = new Handler(_ => throw new InvalidOperationException("nenhum pedido deveria sair"));
        var client = Client(handler, Options(enabled, baseUrl, key));

        (await client.GetAdviceAsync(null, Ct)).Status.Should().Be(EconomizeFetchStatus.Disabled);
        (await client.GetTripsAsync(null, 200, Ct)).Status.Should().Be(EconomizeFetchStatus.Disabled);
        handler.Requests.Should().BeEmpty();
    }

    [Fact]
    public void Enabled_with_bad_settings_fails_validation_and_disabled_needs_nothing()
    {
        ShoppingModuleOptions.IsValid(new ShoppingModuleOptions()).Should().BeTrue();
        ShoppingModuleOptions.IsValid(new ShoppingModuleOptions { Economize = Options() }).Should().BeTrue();
        ShoppingModuleOptions.IsValid(new ShoppingModuleOptions { Economize = Options(baseUrl: "http://economize.test") }).Should().BeFalse();
        ShoppingModuleOptions.IsValid(new ShoppingModuleOptions { Economize = Options(key: "eco_x") }).Should().BeFalse();
    }
}
