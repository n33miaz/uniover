using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
using AwesomeAssertions;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.IntegrationTests.Training;

namespace UniOver.IntegrationTests.Shopping;

/// <summary>
/// O conselho e a importação do Economize, com um Economize em memória no formato que ele responde de verdade
/// (<c>incomePattern.advice.bestDay</c>, centavos inteiros, nulos explícitos).
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class EconomizeIntegrationTests(PostgresFixture postgres)
{
    private static readonly string[] Shopping = ["module:shopping"];

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>Responde pelo caminho; guarda o que recebeu.</summary>
    private sealed class Economize(Func<HttpRequestMessage, HttpResponseMessage> answer) : HttpMessageHandler
    {
        public ConcurrentQueue<(string PathAndQuery, string? Authorization)> Requests { get; } = new();

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Enqueue((request.RequestUri!.PathAndQuery, request.Headers.Authorization?.ToString()));
            return Task.FromResult(answer(request));
        }
    }

    private static HttpResponseMessage Json(string json) => new(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    private const string Advice = """
        {
          "generatedAt": "2026-11-12T12:00:00Z",
          "incomePattern": {
            "status": "READY", "message": null, "today": "2026-11-12",
            "sources": [{ "name": "Salário", "pattern": { "median": 5, "expectedAmount": 4321.5, "monthsObserved": 6 } }],
            "inferred": { "weekendShare": 0.4, "monthsObserved": 6 },
            "advice": { "bestDay": "2026-11-20", "bestDayWeekday": "FRIDAY", "daysToCover": 14 }
          },
          "free": {
            "salaryKnown": true, "salaryDate": "2026-12-05", "daysUntilSalary": 23, "expectedSalaryCents": 432150,
            "committedBeforeSalaryCents": 120000, "committedAfterSalaryCents": 50000, "freeCents": 98765
          }
        }
        """;

    [Fact]
    public async Task Advice_answers_waking_at_once_then_the_mapped_advice_from_one_fetch()
    {
        var economize = new Economize(_ => Json(Advice));
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { EconomizeHandler = () => economize });
        var owner = new ShoppingClient(app, (await app.LoginAsync()).AccessToken);

        var first = await ShoppingClient.OkAsync(owner.GetAsync("/advice"));
        first.GetProperty("available").GetBoolean().Should().BeFalse();
        first.GetProperty("reason").GetString().Should().Be("waking");

        var advice = await WaitAsync(owner, "/advice", x => x.GetProperty("available").GetBoolean());
        advice.GetProperty("bestDay").GetString().Should().Be("2026-11-20");
        advice.GetProperty("status").GetString().Should().Be("READY");
        advice.GetProperty("free").GetProperty("freeCents").GetInt64().Should().Be(98765);
        advice.GetProperty("free").GetProperty("salaryDate").GetString().Should().Be("2026-12-05");
        advice.TryGetProperty("incomePattern", out _).Should().BeFalse("só o que a tela usa sai daqui");

        // Dentro dos dez minutos, nenhuma busca nova: o Economize foi chamado uma vez só, com a chave da configuração.
        await ShoppingClient.OkAsync(owner.GetAsync("/advice"));
        economize.Requests.Should().ContainSingle();
        var (path, authorization) = economize.Requests.Single();
        path.Should().Be("/api/v1/integration/shopping/advice");
        authorization.Should().Be("Bearer " + TrainingApp.EconomizeTestKey);
    }

    [Fact]
    public async Task Without_configuration_nothing_is_fetched_and_the_routes_say_disabled()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var owner = new ShoppingClient(app, (await app.LoginAsync()).AccessToken);

        (await ShoppingClient.OkAsync(owner.GetAsync("/advice"))).GetProperty("reason").GetString().Should().Be("disabled");

        using var started = await app.SendAsync(HttpMethod.Post, ShoppingClient.Base + "/import/economize", bearer: (await app.LoginAsync()).AccessToken);
        started.StatusCode.Should().Be(HttpStatusCode.Accepted);
        (await TrainingApp.JsonAsync(started)).GetProperty("error").GetString().Should().Be("disabled");
    }

    [Fact]
    public async Task Only_the_administrator_reads_advice_or_imports()
    {
        var economize = new Economize(_ => Json(Advice));
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { EconomizeHandler = () => economize });
        var guest = (await app.NewGuestAsync("Convidada", Shopping, 71)).Login.AccessToken;

        using var advice = await app.SendAsync(HttpMethod.Get, ShoppingClient.Base + "/advice", bearer: guest);
        advice.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        using var start = await app.SendAsync(HttpMethod.Post, ShoppingClient.Base + "/import/economize", bearer: guest);
        start.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        using var state = await app.SendAsync(HttpMethod.Get, ShoppingClient.Base + "/import/economize", bearer: guest);
        state.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        economize.Requests.Should().BeEmpty();
    }

    [Fact]
    public async Task Import_brings_own_finished_trips_once_and_reuses_products_by_normalized_name()
    {
        var closed = Guid.NewGuid();
        var reconciled = Guid.NewGuid();
        var open = Guid.NewGuid();
        var someoneElse = Guid.NewGuid();
        var firstPage = $$"""
            {
              "trips": [
                {{Trip(closed, "CLOSED", own: true, paid: 2350, items: """
                    { "name": "Açúcar", "normalizedName": "açucar", "quantity": 1, "unitPriceCents": 500, "checked": true },
                    { "name": "açúcar ", "normalizedName": "acucar", "quantity": 2, "unitPriceCents": 650, "checked": true },
                    { "name": "Café", "normalizedName": "cafe", "quantity": 1, "unitPriceCents": 1050, "checked": true },
                    { "name": "Sabão", "normalizedName": "sabao", "quantity": 1, "unitPriceCents": 900, "checked": false },
                    { "name": "Leite", "normalizedName": "leite", "quantity": 1, "unitPriceCents": null, "checked": true }
                    """)}},
                {{Trip(open, "OPEN", own: true, paid: 0, items: "")}}
              ],
              "nextCursor": "c1", "hasMore": true
            }
            """;
        var secondPage = $$"""
            {
              "trips": [
                {{Trip(reconciled, "RECONCILED", own: true, paid: 1000, items: """
                    { "name": "Café", "normalizedName": "cafe", "quantity": 1, "unitPriceCents": 1000, "checked": true }
                    """)}},
                {{Trip(someoneElse, "CLOSED", own: false, paid: 777, items: "")}}
              ],
              "nextCursor": "c2", "hasMore": false
            }
            """;
        var economize = new Economize(request => Json(request.RequestUri!.Query.Contains("cursor=c1", StringComparison.Ordinal) ? secondPage : firstPage));
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { EconomizeHandler = () => economize });
        var owner = new ShoppingClient(app, (await app.LoginAsync()).AccessToken);
        var sugar = await owner.NewProductAsync("acucar");

        using (var started = await app.SendAsync(HttpMethod.Post, ShoppingClient.Base + "/import/economize", bearer: (await app.LoginAsync()).AccessToken))
        {
            started.StatusCode.Should().Be(HttpStatusCode.Accepted);
        }

        var done = await WaitAsync(owner, "/import/economize", x => x.GetProperty("finished").GetBoolean());
        done.GetProperty("error").ValueKind.Should().Be(JsonValueKind.Null);
        done.GetProperty("imported").GetInt32().Should().Be(2);
        done.GetProperty("existing").GetInt32().Should().Be(0);
        done.GetProperty("ignored").GetInt32().Should().Be(2, "a compra aberta e a de outra pessoa da casa ficam de fora");
        economize.Requests.Select(x => x.PathAndQuery).Should().Equal(
            "/api/v1/integration/shopping/trips?limit=200",
            "/api/v1/integration/shopping/trips?limit=200&cursor=c1");

        var feed = await owner.ChangesAsync();
        var purchases = feed.Where(x => x.GetProperty("entityType").GetString() == "purchase").Select(x => x.GetProperty("payload")).ToList();
        purchases.Should().HaveCount(2);
        purchases.Should().OnlyContain(x => x.GetProperty("status").GetString() == "closed");
        purchases.Select(x => x.GetProperty("totalPaid").GetDecimal()).Should().BeEquivalentTo([23.50m, 10.00m]);

        var products = feed.Where(x => x.GetProperty("entityType").GetString() == "product").Select(x => x.GetProperty("payload")).ToList();
        products.Select(x => x.GetProperty("name").GetString()).Should().BeEquivalentTo(["acucar", "Café"], "o açúcar do Economize é o produto que o grupo já tinha");

        var lines = feed.Where(x => x.GetProperty("entityType").GetString() == "purchaseItem").Select(x => x.GetProperty("payload")).ToList();
        lines.Should().HaveCount(3, "duas linhas de açúcar viram uma; sem preço e não pego ficam de fora");
        var sugarLine = lines.Single(x => x.GetProperty("productId").GetGuid() == sugar);
        sugarLine.GetProperty("quantity").GetDecimal().Should().Be(3m);
        sugarLine.GetProperty("unitPrice").GetDecimal().Should().Be(6.00m, "(5,00 + 2 × 6,50) / 3");
        lines.Should().OnlyContain(x => x.GetProperty("picked").GetBoolean());

        // De novo: nada duplica.
        using (var again = await app.SendAsync(HttpMethod.Post, ShoppingClient.Base + "/import/economize", bearer: (await app.LoginAsync()).AccessToken))
        {
            again.StatusCode.Should().Be(HttpStatusCode.Accepted);
        }

        var second = await WaitAsync(owner, "/import/economize", x => x.GetProperty("finished").GetBoolean() && x.GetProperty("existing").GetInt32() > 0);
        second.GetProperty("imported").GetInt32().Should().Be(0);
        second.GetProperty("existing").GetInt32().Should().Be(2);
        (await owner.ChangesAsync()).Count.Should().Be(feed.Count);
    }

    [Fact]
    public async Task Import_reports_a_refused_key_without_writing_anything()
    {
        var economize = new Economize(_ => new HttpResponseMessage(HttpStatusCode.Unauthorized));
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { EconomizeHandler = () => economize });
        var owner = new ShoppingClient(app, (await app.LoginAsync()).AccessToken);

        using (await app.SendAsync(HttpMethod.Post, ShoppingClient.Base + "/import/economize", bearer: (await app.LoginAsync()).AccessToken))
        {
        }

        var done = await WaitAsync(owner, "/import/economize", x => x.GetProperty("finished").GetBoolean());
        done.GetProperty("error").GetString().Should().Be("unauthorized");
        done.GetProperty("imported").GetInt32().Should().Be(0);
    }

    /// <summary>
    /// Uma compra no formato do arquivo exportado do Economize (recorte de um real, com loja, nomes e valores trocados):
    /// ficou aberta, tem itens, parou há mais de três dias; <c>item.createdAt</c> vem nulo.
    /// </summary>
    private const string FileTrip = """
        {
          "id": "0f6c2b1e-7a1d-4b8e-9c55-3d2f1a0b9e11", "clientId": "aaaa0000-bbbb1111-cccc2222",
          "ownerId": "11111111-2222-4333-8444-555555555555", "own": true, "storeName": "Mercado Exemplo", "status": "OPEN",
          "startedAt": "2026-10-20T20:40:21.096Z", "closedAt": null, "budgetCents": null, "receiptTotalCents": null,
          "itemsTotalCents": 1897, "paidTotalCents": 1897, "receiptKey": null, "receiptIssuerCnpj": null,
          "reconciledTransactionId": null, "notes": null,
          "items": [
            { "id": "9b0c1d2e-0000-4000-8000-000000000001", "clientId": "x1", "name": "arroz", "normalizedName": "arroz",
              "quantity": 1.0, "unitPriceCents": null, "lineTotalCents": null, "promoNote": null, "checked": false,
              "addedBy": "11111111-2222-4333-8444-555555555555", "createdAt": null, "updatedAt": "2026-10-20T20:42:47.155075Z" },
            { "id": "9b0c1d2e-0000-4000-8000-000000000002", "clientId": "x2", "name": "Feijão", "normalizedName": "feijao",
              "quantity": 2.0, "unitPriceCents": 449, "lineTotalCents": 898, "promoNote": "leve 2", "checked": true,
              "addedBy": "11111111-2222-4333-8444-555555555555", "createdAt": null, "updatedAt": "2026-10-20T21:10:00.000001Z" },
            { "id": "9b0c1d2e-0000-4000-8000-000000000003", "clientId": "x3", "name": "Café", "normalizedName": "cafe",
              "quantity": 1.0, "unitPriceCents": 999, "lineTotalCents": 999, "promoNote": null, "checked": true,
              "addedBy": "11111111-2222-4333-8444-555555555555", "createdAt": null, "updatedAt": "2026-10-20T21:12:00.000001Z" }
          ],
          "createdAt": "2026-10-20T20:40:28.778791Z", "updatedAt": "2026-10-20T21:43:36.615198Z"
        }
        """;

    [Fact]
    public async Task File_import_uses_the_same_rules_and_closes_stale_open_trips()
    {
        // Sem Economize configurado: o arquivo não depende da integração ligada.
        await using var app = await TrainingApp.StartAsync(postgres);
        var token = (await app.LoginAsync()).AccessToken;
        var owner = new ShoppingClient(app, token);
        var recent = DateTimeOffset.UtcNow.AddHours(-1).ToString("O", System.Globalization.CultureInfo.InvariantCulture);
        var file = JsonSerializer.Deserialize<JsonElement>($$"""
            {
              "trips": [
                {{FileTrip}},
                {{Trip(Guid.NewGuid(), "OPEN", own: true, paid: 500, items: """{ "name": "Pão", "quantity": 1, "unitPriceCents": 500, "checked": true }""").Replace("\"updatedAt\": \"2026-11-01T11:00:00Z\"", $"\"updatedAt\": \"{recent}\"", StringComparison.Ordinal)}},
                {{Trip(Guid.NewGuid(), "OPEN", own: true, paid: 0, items: "")}}
              ],
              "nextCursor": "fim", "hasMore": false, "_export": { "note": "ignorado" }
            }
            """);

        using (var response = await app.SendAsync(HttpMethod.Post, ShoppingClient.Base + "/import/economize/file", file, token))
        {
            response.StatusCode.Should().Be(HttpStatusCode.OK, await response.Content.ReadAsStringAsync(Ct));
            var body = await TrainingApp.JsonAsync(response);
            body.GetProperty("imported").GetInt32().Should().Be(1);
            body.GetProperty("ignored").GetInt32().Should().Be(2, "a aberta recente e a vazia são puladas");
            body.GetProperty("existing").GetInt32().Should().Be(0);
            body.GetProperty("finished").GetBoolean().Should().BeTrue();
        }

        var feed = await owner.ChangesAsync();
        var purchase = feed.Single(x => x.GetProperty("entityType").GetString() == "purchase").GetProperty("payload");
        purchase.GetProperty("status").GetString().Should().Be("closed");
        purchase.GetProperty("totalPaid").GetDecimal().Should().Be(18.97m);
        purchase.GetProperty("closedAt").GetDateTimeOffset().Should().Be(DateTimeOffset.Parse("2026-10-20T21:43:36.615198Z", System.Globalization.CultureInfo.InvariantCulture));
        purchase.GetProperty("store").GetString().Should().Be("Mercado Exemplo");
        var lines = feed.Where(x => x.GetProperty("entityType").GetString() == "purchaseItem").Select(x => x.GetProperty("payload")).ToList();
        lines.Select(x => x.GetProperty("unitPrice").GetDecimal()).Should().BeEquivalentTo([4.49m, 9.99m], "o arroz não pego fica de fora");

        using (var again = await app.SendAsync(HttpMethod.Post, ShoppingClient.Base + "/import/economize/file", file, token))
        {
            (await TrainingApp.JsonAsync(again)).GetProperty("existing").GetInt32().Should().Be(1);
        }
    }

    [Fact]
    public async Task File_import_refuses_what_is_not_an_export_or_too_large()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var token = (await app.LoginAsync()).AccessToken;

        using (var wrong = await app.SendAsync(HttpMethod.Post, ShoppingClient.Base + "/import/economize/file", new { items = Array.Empty<int>() }, token))
        {
            wrong.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        }

        using (var large = await app.SendAsync(HttpMethod.Post, ShoppingClient.Base + "/import/economize/file", new { trips = Array.Empty<int>(), pad = new string('x', 2 * 1024 * 1024) }, token))
        {
            large.StatusCode.Should().Be(HttpStatusCode.RequestEntityTooLarge);
        }

        var guest = (await app.NewGuestAsync("Convidada", Shopping, 72)).Login.AccessToken;
        using var forbidden = await app.SendAsync(HttpMethod.Post, ShoppingClient.Base + "/import/economize/file", new { trips = Array.Empty<int>() }, guest);
        forbidden.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Import_stops_with_an_error_when_a_cursor_comes_back()
    {
        // A → B → A: sem o conjunto de cursores vistos, a importação nunca acabaria.
        var economize = new Economize(request =>
        {
            var query = request.RequestUri!.Query;
            var next = query.Contains("cursor=A", StringComparison.Ordinal) ? "B" : "A";
            return Json($$"""{ "trips": [], "nextCursor": "{{next}}", "hasMore": true }""");
        });
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { EconomizeHandler = () => economize });
        var owner = new ShoppingClient(app, (await app.LoginAsync()).AccessToken);

        using (await app.SendAsync(HttpMethod.Post, ShoppingClient.Base + "/import/economize", bearer: (await app.LoginAsync()).AccessToken))
        {
        }

        var done = await WaitAsync(owner, "/import/economize", x => x.GetProperty("finished").GetBoolean());
        done.GetProperty("error").GetString().Should().Be("unavailable");
        economize.Requests.Select(x => x.PathAndQuery).Should().Equal(
            "/api/v1/integration/shopping/trips?limit=200",
            "/api/v1/integration/shopping/trips?limit=200&cursor=A",
            "/api/v1/integration/shopping/trips?limit=200&cursor=B");
    }

    [Fact]
    public async Task Import_ignores_a_trip_out_of_range_and_keeps_going()
    {
        var page = $$"""
            {
              "trips": [
                {{Trip(Guid.NewGuid(), "CLOSED", own: true, paid: 100_000_001, items: "")}},
                {{Trip(Guid.NewGuid(), "CLOSED", own: true, paid: 2350, items: "")}}
              ],
              "nextCursor": null, "hasMore": false
            }
            """;
        var economize = new Economize(_ => Json(page));
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { EconomizeHandler = () => economize });
        var owner = new ShoppingClient(app, (await app.LoginAsync()).AccessToken);

        using (await app.SendAsync(HttpMethod.Post, ShoppingClient.Base + "/import/economize", bearer: (await app.LoginAsync()).AccessToken))
        {
        }

        var done = await WaitAsync(owner, "/import/economize", x => x.GetProperty("finished").GetBoolean());
        done.GetProperty("error").ValueKind.Should().Be(JsonValueKind.Null);
        done.GetProperty("imported").GetInt32().Should().Be(1);
        done.GetProperty("ignored").GetInt32().Should().Be(1, "mais de R$ 1 milhão numa compra é dado ilegível");
    }

    [Fact]
    public async Task File_import_counts_a_repeated_trip_once()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var token = (await app.LoginAsync()).AccessToken;
        var trip = Trip(Guid.NewGuid(), "CLOSED", own: true, paid: 1000, items: """{ "name": "Pão", "quantity": 1, "unitPriceCents": 1000, "checked": true }""");
        var file = JsonSerializer.Deserialize<JsonElement>($$"""{ "trips": [{{trip}}, {{trip}}], "hasMore": false }""");

        using var response = await app.SendAsync(HttpMethod.Post, ShoppingClient.Base + "/import/economize/file", file, token);
        response.StatusCode.Should().Be(HttpStatusCode.OK, await response.Content.ReadAsStringAsync(Ct));
        var body = await TrainingApp.JsonAsync(response);
        body.GetProperty("imported").GetInt32().Should().Be(1);
        body.GetProperty("existing").GetInt32().Should().Be(1);
    }

    [Theory]
    [InlineData("overflow")]
    [InlineData("old-date")]
    [InlineData("quantity")]
    public async Task File_import_refuses_values_out_of_range_with_400(string kind)
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var token = (await app.LoginAsync()).AccessToken;
        var trip = kind switch
        {
            // Sem total da compra, a soma das linhas pegas estouraria o Int64.
            "overflow" => Trip(Guid.NewGuid(), "CLOSED", own: true, paid: 0, items: """
                    { "name": "A", "quantity": 1, "unitPriceCents": 1, "lineTotalCents": 9000000000000000000, "checked": true },
                    { "name": "B", "quantity": 1, "unitPriceCents": 1, "lineTotalCents": 9000000000000000000, "checked": true }
                    """).Replace("\"itemsTotalCents\": 0, \"paidTotalCents\": 0", "\"itemsTotalCents\": null, \"paidTotalCents\": null", StringComparison.Ordinal),
            "old-date" => Trip(Guid.NewGuid(), "CLOSED", own: true, paid: 1000, items: "")
                .Replace("\"startedAt\": \"2026-11-01T10:00:00Z\"", "\"startedAt\": \"1900-01-01T10:00:00Z\"", StringComparison.Ordinal),
            _ => Trip(Guid.NewGuid(), "CLOSED", own: true, paid: 1000, items: """{ "name": "A", "quantity": 1e20, "unitPriceCents": 1, "checked": true }"""),
        };
        var file = JsonSerializer.Deserialize<JsonElement>($$"""{ "trips": [{{trip}}], "hasMore": false }""");

        using var response = await app.SendAsync(HttpMethod.Post, ShoppingClient.Base + "/import/economize/file", file, token);
        response.StatusCode.Should().Be(HttpStatusCode.BadRequest, await response.Content.ReadAsStringAsync(Ct));
        (await TrainingApp.JsonAsync(response)).GetProperty("errors").TryGetProperty("trips", out _).Should().BeTrue();
        (await new ShoppingClient(app, token).ChangesAsync())
            .Where(x => x.GetProperty("entityType").GetString() == "purchase").Should().BeEmpty("nada do arquivo é gravado");
    }

    private static string Trip(Guid id, string status, bool own, long paid, string items) => $$"""
        {
          "id": "{{id}}", "clientId": "x", "ownerId": "{{Guid.NewGuid()}}", "own": {{(own ? "true" : "false")}},
          "storeName": "Mercado", "status": "{{status}}",
          "startedAt": "2026-11-01T10:00:00Z", "closedAt": {{(status == "OPEN" ? "null" : "\"2026-11-01T11:00:00Z\"")}},
          "budgetCents": null, "receiptTotalCents": null, "itemsTotalCents": {{paid}}, "paidTotalCents": {{paid}},
          "receiptKey": null, "receiptIssuerCnpj": null, "reconciledTransactionId": null, "notes": null,
          "items": [{{items}}],
          "createdAt": "2026-11-01T10:00:00Z", "updatedAt": "2026-11-01T11:00:00Z"
        }
        """;

    private static async Task<JsonElement> WaitAsync(ShoppingClient client, string path, Func<JsonElement, bool> done)
    {
        for (var attempt = 0; attempt < 100; attempt++)
        {
            var body = await ShoppingClient.OkAsync(client.GetAsync(path));
            if (done(body))
            {
                return body;
            }

            await Task.Delay(100, Ct);
        }

        throw new TimeoutException($"{path} não chegou ao estado esperado.");
    }
}
