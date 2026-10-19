using System.Net;
using System.Text;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.Extensions.Options;
using UniOver.Modules.Training.Adapters;
using UniOver.Modules.Training.Features.Catalog.ImportWger;
using UniOver.Modules.Training.Ports;

namespace UniOver.Modules.Training.Tests.Adapters;

public class WgerClientTests
{
    private static readonly DateTimeOffset Start = new(2026, 10, 19, 12, 0, 0, TimeSpan.Zero);

    private const string PageJson = """
        {
          "count": 2,
          "next": "https://wger.de/api/v2/exerciseinfo/?limit=50&offset=50",
          "results": [
            {
              "uuid": "aaaaaaaa-0000-4000-8000-000000000001",
              "muscles": [{"id": 4}],
              "muscles_secondary": [{"id": 5}],
              "equipment": [{"id": 1}],
              "translations": [
                {"language": 2, "name": "Bench Press", "description": "<p>x</p>", "license": 2, "license_author": "Ana"},
                {"language": 7, "name": "Supino", "description": "<p>y</p>", "license": 2, "license_author": "Beto"}
              ]
            },
            {
              "uuid": "aaaaaaaa-0000-4000-8000-000000000002",
              "muscles": [],
              "muscles_secondary": [],
              "equipment": [],
              "translations": []
            }
          ]
        }
        """;

    private sealed class FakeHandler(Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
    {
        private int _inFlight;
        private int _maxInFlight;

        public List<(Uri? Uri, DateTimeOffset At)> Calls { get; } = [];

        public TimeProvider? Time { get; init; }

        public TimeSpan Hold { get; init; }

        public int MaxInFlight => _maxInFlight;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var now = Interlocked.Increment(ref _inFlight);
            InterlockedMax(ref _maxInFlight, now);
            lock (Calls)
            {
                Calls.Add((request.RequestUri, Time?.GetUtcNow() ?? DateTimeOffset.UtcNow));
            }

            try
            {
                if (Hold > TimeSpan.Zero)
                {
                    await Task.Delay(Hold, cancellationToken);
                }

                return respond(request);
            }
            finally
            {
                Interlocked.Decrement(ref _inFlight);
            }
        }

        private static void InterlockedMax(ref int target, int value)
        {
            int seen;
            do
            {
                seen = Volatile.Read(ref target);
                if (value <= seen)
                {
                    return;
                }
            }
            while (Interlocked.CompareExchange(ref target, value, seen) != seen);
        }
    }

    private static HttpResponseMessage Json(string body, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    private static IOptions<TrainingModuleOptions> Options(int delayMs = 1000) =>
        Microsoft.Extensions.Options.Options.Create(new TrainingModuleOptions
        {
            Import = new ImportOptions { Wger = new WgerImportOptions { DelayMs = delayMs } },
        });

    private static HttpWgerClient Client(FakeHandler handler, WgerThrottle throttle, int delayMs = 1000) =>
        new(new HttpClient(handler) { BaseAddress = new Uri("https://wger.test") }, Options(delayMs), throttle);

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Parser_ReadsUuidMusclesEquipmentAndTranslations()
    {
        var handler = new FakeHandler(_ => Json(PageJson));
        var client = Client(handler, new WgerThrottle(TimeProvider.System), delayMs: 0);

        var page = await client.GetExercisesAsync(0, 50, Ct);

        page.Total.Should().Be(2);
        page.HasNext.Should().BeTrue();
        page.Items.Should().HaveCount(2);
        var first = page.Items[0];
        first.Uuid.Should().Be("aaaaaaaa-0000-4000-8000-000000000001");
        first.MuscleIds.Should().Equal(4);
        first.SecondaryMuscleIds.Should().Equal(5);
        first.EquipmentIds.Should().Equal(1);
        first.Translations.Should().HaveCount(2);
        first.Translations[1].Should().Match<WgerTranslation>(t => t.LanguageId == 7 && t.LicenseId == 2 && t.LicenseAuthor == "Beto");
    }

    [Fact]
    public async Task Request_UsesTheOffsetAndLimit_InTheInvariantCulture()
    {
        var handler = new FakeHandler(_ => Json(PageJson));
        var client = Client(handler, new WgerThrottle(TimeProvider.System), delayMs: 0);

        await client.GetExercisesAsync(150, 50, Ct);

        handler.Calls.Should().ContainSingle().Which.Uri!.ToString().Should().Be("https://wger.test/api/v2/exerciseinfo/?limit=50&offset=150");
    }

    [Fact]
    public async Task MissingTranslationsArray_IsAnUnexpectedBody_NotZeroInPortuguese()
    {
        var handler = new FakeHandler(_ => Json("""{"count":1,"next":null,"results":[{"uuid":"u1","muscles":[]}]}"""));
        var client = Client(handler, new WgerThrottle(TimeProvider.System), delayMs: 0);

        var act = () => client.GetExercisesAsync(0, 50, Ct);

        await act.Should().ThrowAsync<WgerUnavailableException>();
    }

    [Theory]
    [InlineData("""{"count":0,"next":null}""")]
    [InlineData("""[]""")]
    [InlineData("""{"results":[{"muscles":[],"translations":[]}]}""")]
    [InlineData("""{"results":[{"uuid":"u","translations":[{"name":"x"}]}]}""")]
    [InlineData("não é json")]
    public async Task UnexpectedBodies_BecomeUnavailable(string body)
    {
        var handler = new FakeHandler(_ => Json(body));
        var client = Client(handler, new WgerThrottle(TimeProvider.System), delayMs: 0);

        var act = () => client.GetExercisesAsync(0, 50, Ct);

        await act.Should().ThrowAsync<WgerUnavailableException>();
    }

    [Theory]
    [InlineData(HttpStatusCode.InternalServerError)]
    [InlineData(HttpStatusCode.TooManyRequests)]
    [InlineData(HttpStatusCode.Forbidden)]
    public async Task NonSuccessStatus_BecomesUnavailable(HttpStatusCode status)
    {
        var handler = new FakeHandler(_ => Json("{}", status));
        var client = Client(handler, new WgerThrottle(TimeProvider.System), delayMs: 0);

        var act = () => client.GetExercisesAsync(0, 50, Ct);

        await act.Should().ThrowAsync<WgerUnavailableException>();
    }

    [Fact]
    public async Task NetworkFailure_BecomesUnavailable()
    {
        var handler = new FakeHandler(_ => throw new HttpRequestException("sem rede"));
        var client = Client(handler, new WgerThrottle(TimeProvider.System), delayMs: 0);

        var act = () => client.GetExercisesAsync(0, 50, Ct);

        await act.Should().ThrowAsync<WgerUnavailableException>();
    }

    [Fact]
    public async Task SecondCall_WaitsForTheInterval_ProvedWithAFakeClock()
    {
        var time = new FakeTimeProvider(Start);
        var handler = new FakeHandler(_ => Json(PageJson)) { Time = time };
        var client = Client(handler, new WgerThrottle(time));

        await client.GetExercisesAsync(0, 50, Ct);
        var second = client.GetExercisesAsync(50, 50, Ct);

        // Meio segundo depois ainda não pode ter saído: o intervalo é de 1 s.
        await Task.Delay(50, Ct);
        time.Advance(TimeSpan.FromMilliseconds(500));
        await Task.Delay(50, Ct);
        second.IsCompleted.Should().BeFalse();
        handler.Calls.Should().HaveCount(1);

        time.Advance(TimeSpan.FromMilliseconds(500));
        await second.WaitAsync(TimeSpan.FromSeconds(5), Ct);

        handler.Calls.Should().HaveCount(2);
        (handler.Calls[1].At - handler.Calls[0].At).Should().BeGreaterThanOrEqualTo(TimeSpan.FromSeconds(1));
    }

    [Fact]
    public async Task TheFirstCall_NeverWaits()
    {
        var time = new FakeTimeProvider(Start);
        var handler = new FakeHandler(_ => Json(PageJson)) { Time = time };
        var client = Client(handler, new WgerThrottle(time));

        await client.GetExercisesAsync(0, 50, Ct).WaitAsync(TimeSpan.FromSeconds(5), Ct);

        handler.Calls.Should().HaveCount(1);
    }

    [Fact]
    public async Task ZeroInterval_DoesNotWait()
    {
        var handler = new FakeHandler(_ => Json(PageJson));
        var client = Client(handler, new WgerThrottle(TimeProvider.System), delayMs: 0);

        await client.GetExercisesAsync(0, 50, Ct);
        await client.GetExercisesAsync(50, 50, Ct).WaitAsync(TimeSpan.FromSeconds(5), Ct);

        handler.Calls.Should().HaveCount(2);
    }

    [Fact]
    public async Task TwoClientInstances_ShareTheTurn_NeverRunningInParallel()
    {
        // O cliente tipado do HttpClientFactory é recriado a cada uso: o ritmo vive no controle compartilhado.
        var throttle = new WgerThrottle(TimeProvider.System);
        var handler = new FakeHandler(_ => Json(PageJson)) { Hold = TimeSpan.FromMilliseconds(40) };
        var a = Client(handler, throttle, delayMs: 0);
        var b = Client(handler, throttle, delayMs: 0);

        await Task.WhenAll(
            a.GetExercisesAsync(0, 50, Ct), b.GetExercisesAsync(50, 50, Ct), a.GetExercisesAsync(100, 50, Ct), b.GetExercisesAsync(150, 50, Ct));

        handler.Calls.Should().HaveCount(4);
        handler.MaxInFlight.Should().Be(1);
    }

    [Fact]
    public async Task TheIntervalAlsoCountsAfterAFailedCall()
    {
        var time = new FakeTimeProvider(Start);
        var fail = true;
        var handler = new FakeHandler(_ => fail ? Json("{}", HttpStatusCode.InternalServerError) : Json(PageJson)) { Time = time };
        var client = Client(handler, new WgerThrottle(time));

        var first = () => client.GetExercisesAsync(0, 50, Ct);
        await first.Should().ThrowAsync<WgerUnavailableException>();
        fail = false;
        var second = client.GetExercisesAsync(0, 50, Ct);
        await Task.Delay(50, Ct);

        second.IsCompleted.Should().BeFalse("o serviço de fora não é martelado depois de uma falha");
        time.Advance(TimeSpan.FromSeconds(1));
        await second.WaitAsync(TimeSpan.FromSeconds(5), Ct);
    }

    [Fact]
    public async Task CancelledWhileWaitingForTheTurn_ReleasesTheGate()
    {
        var time = new FakeTimeProvider(Start);
        var handler = new FakeHandler(_ => Json(PageJson)) { Time = time };
        var throttle = new WgerThrottle(time);
        var client = Client(handler, throttle);
        await client.GetExercisesAsync(0, 50, Ct);

        using var cts = CancellationTokenSource.CreateLinkedTokenSource(Ct);
        var waiting = client.GetExercisesAsync(50, 50, cts.Token);
        await Task.Delay(50, Ct);
        await cts.CancelAsync();
        var act = () => waiting;
        await act.Should().ThrowAsync<OperationCanceledException>();

        // A vez foi devolvida: a próxima chamada, depois do intervalo, passa.
        var next = client.GetExercisesAsync(50, 50, Ct);
        await Task.Delay(50, Ct);
        time.Advance(TimeSpan.FromSeconds(1));
        await next.WaitAsync(TimeSpan.FromSeconds(5), Ct);
    }
}

public class WgerMappingTests
{
    [Fact]
    public void Description_BecomesPlainTextSteps_OneForEachParagraphOrItem()
    {
        var html = "<p>Deite no banco.</p><ul><li>Segure a barra.</li><li>Empurre &amp; volte.</li></ul><script>alert(1)</script>";

        var steps = WgerMapping.ToInstructions(html);

        steps.Should().Equal("Deite no banco.", "Segure a barra.", "Empurre & volte.", "alert(1)");
        steps.Should().NotContain(s => s.Contains('<', StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("<p></p><br/>")]
    public void EmptyDescription_GivesNoSteps(string? html)
    {
        WgerMapping.ToInstructions(html).Should().BeEmpty();
    }

    [Fact]
    public void Steps_AreCappedByCountAndLength()
    {
        var many = string.Concat(Enumerable.Range(0, 30).Select(i => $"<p>passo {i}</p>"));
        var long1 = "<p>" + new string('a', 800) + "</p>";

        WgerMapping.ToInstructions(many).Should().HaveCount(20);
        WgerMapping.ToInstructions(long1).Should().ContainSingle().Which.Length.Should().BeLessThanOrEqualTo(500);
    }

    [Fact]
    public void Muscles_AreMappedWithoutRepetition_AndUnknownIdsAreDropped()
    {
        WgerMapping.MapMuscles([1, 13, 4, 999]).Should().Equal("biceps", "chest");
        WgerMapping.MapSecondary([5, 1, 4], ["chest"]).Should().Equal("triceps", "biceps");
    }

    [Fact]
    public void Equipment_FallsBackToBodyweightOnlyWhenThereIsNone()
    {
        WgerMapping.MapEquipment([]).Should().Be("bodyweight");
        WgerMapping.MapEquipment([7]).Should().Be("bodyweight");
        WgerMapping.MapEquipment([1]).Should().Be("barbell");
        WgerMapping.MapEquipment([3]).Should().Be("dumbbell");
        WgerMapping.MapEquipment([12]).Should().Be("cable");
        WgerMapping.MapEquipment([8]).Should().Be("other");
        WgerMapping.MapEquipment([8, 3]).Should().Be("dumbbell");
    }

    [Fact]
    public void LicenseConstants_AreTheOnesTheTaskRequires()
    {
        WgerMapping.LicenseIdCcBySa4.Should().Be(2);
        WgerMapping.LicenseUrl.Should().StartWith("https://creativecommons.org/licenses/by-sa/4.0");
    }
}

public class TrainingModuleOptionsTests
{
    [Fact]
    public void Defaults_AreValid()
    {
        TrainingModuleOptions.IsValid(new TrainingModuleOptions()).Should().BeTrue();
        new TrainingModuleOptions().Import.Wger.DelayMs.Should().Be(1000);
    }

    [Theory]
    [InlineData("http://wger.de")]
    [InlineData("não é url")]
    public void NonHttpsOrInvalidBaseUrl_IsRefused(string url)
    {
        var options = new TrainingModuleOptions();
        options.Import.Wger.BaseUrl = url;

        TrainingModuleOptions.IsValid(options).Should().BeFalse();
    }

    [Fact]
    public void NegativeDelayAndZeroMaxItems_AreRefused()
    {
        var negative = new TrainingModuleOptions();
        negative.Import.Wger.DelayMs = -1;
        var zero = new TrainingModuleOptions();
        zero.Import.Wger.MaxItems = 0;

        TrainingModuleOptions.IsValid(negative).Should().BeFalse();
        TrainingModuleOptions.IsValid(zero).Should().BeFalse();
    }
}
