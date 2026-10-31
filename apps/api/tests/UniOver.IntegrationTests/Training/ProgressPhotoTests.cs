using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Headers;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Ports;

namespace UniOver.IntegrationTests.Training;

[Collection(PostgresGroup.Name)]
public sealed class ProgressPhotoTests(PostgresFixture postgres)
{
    private static readonly byte[] Jpeg = Convert.FromBase64String("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAIAAwDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDgqKKK9s8I/9k=");
    private const string TakenOn = "2026-10-20";

    [Fact]
    public async Task PhotosAreAccountScopedAndPutDeleteAreIdempotent()
    {
        var store = new FakeProgressPhotoStore();
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { PhotoStorageEnabled = true, Photos = store });
        var a = await app.NewGuestAsync("Conta A", ["module:training"], 66);
        var b = await app.NewGuestAsync("Conta B", ["module:training"], 67);
        var id = Guid.NewGuid();
        var otherId = Guid.NewGuid();

        using (var first = await UploadAsync(app, a.Login.AccessToken, id)) first.StatusCode.Should().Be(HttpStatusCode.OK);
        using (var retry = await UploadAsync(app, a.Login.AccessToken, id)) retry.StatusCode.Should().Be(HttpStatusCode.OK);
        var key = store.Keys.Single();
        key.Should().StartWith("progress-photos/");
        key.Should().NotContain(a.UserId.ToString("N"));
        key.Should().NotContain(id.ToString("N"));
        using (var sameIdForB = await UploadAsync(app, b.Login.AccessToken, otherId)) sameIdForB.StatusCode.Should().Be(HttpStatusCode.OK);

        using (var listed = await app.SendAsync(HttpMethod.Get, "/api/v1/training/progress-photos", bearer: a.Login.AccessToken))
        {
            listed.StatusCode.Should().Be(HttpStatusCode.OK);
            (await TrainingApp.JsonAsync(listed)).GetArrayLength().Should().Be(1);
        }
        using (var foreign = await app.SendAsync(HttpMethod.Get, $"/api/v1/training/progress-photos/{id}/content", bearer: b.Login.AccessToken))
            foreign.StatusCode.Should().Be(HttpStatusCode.NotFound);

        using (var delete = await app.SendAsync(HttpMethod.Put, $"/api/v1/training/progress-photos/{id}/deletion", bearer: a.Login.AccessToken))
            delete.StatusCode.Should().Be(HttpStatusCode.NoContent);
        using (var retryDelete = await app.SendAsync(HttpMethod.Put, $"/api/v1/training/progress-photos/{id}/deletion", bearer: a.Login.AccessToken))
            retryDelete.StatusCode.Should().Be(HttpStatusCode.NoContent);
        using (var hidden = await app.SendAsync(HttpMethod.Get, $"/api/v1/training/progress-photos/{id}/content", bearer: a.Login.AccessToken))
            hidden.StatusCode.Should().Be(HttpStatusCode.NotFound);
        using (var stillThere = await app.SendAsync(HttpMethod.Get, $"/api/v1/training/progress-photos/{otherId}/content", bearer: b.Login.AccessToken))
            stillThere.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task StorageFailuresKeepPendingMetadataForRetryAndDeleteCanBeRetried()
    {
        var store = new FakeProgressPhotoStore { FailPut = true };
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { PhotoStorageEnabled = true, Photos = store });
        var a = await app.NewGuestAsync("Conta A", ["module:training"], 68);
        var id = Guid.NewGuid();
        using (var failedUpload = await UploadAsync(app, a.Login.AccessToken, id)) failedUpload.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        await using (var pendingDb = app.Db())
            (await pendingDb.Set<ProgressPhoto>().SingleAsync(photo => photo.Id == id, TestContext.Current.CancellationToken)).State.Should().Be("pending");

        store.FailPut = false;
        using (var upload = await UploadAsync(app, a.Login.AccessToken, id)) upload.StatusCode.Should().Be(HttpStatusCode.OK);
        store.FailDelete = true;
        using (var failedDelete = await app.SendAsync(HttpMethod.Put, $"/api/v1/training/progress-photos/{id}/deletion", bearer: a.Login.AccessToken))
            failedDelete.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        using (var hidden = await app.SendAsync(HttpMethod.Get, $"/api/v1/training/progress-photos/{id}/content", bearer: a.Login.AccessToken))
            hidden.StatusCode.Should().Be(HttpStatusCode.NotFound);
        store.FailDelete = false;
        using (var retryDelete = await app.SendAsync(HttpMethod.Put, $"/api/v1/training/progress-photos/{id}/deletion", bearer: a.Login.AccessToken))
            retryDelete.StatusCode.Should().Be(HttpStatusCode.NoContent);
        store.Count.Should().Be(0);
    }

    [Fact]
    public async Task ConcurrentDeleteCannotBeUndoneByAnUploadAlreadyInFlight()
    {
        var store = new FakeProgressPhotoStore { PausePut = true };
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { PhotoStorageEnabled = true, Photos = store });
        var a = await app.NewGuestAsync("Conta A", ["module:training"], 69);
        var id = Guid.NewGuid();

        var upload = UploadAsync(app, a.Login.AccessToken, id);
        await store.PutStarted.Task.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        var delete = app.SendAsync(HttpMethod.Put, $"/api/v1/training/progress-photos/{id}/deletion", bearer: a.Login.AccessToken);
        store.ContinuePut.TrySetResult();
        using (var uploaded = await upload) uploaded.StatusCode.Should().Be(HttpStatusCode.OK);
        using (var deleted = await delete) deleted.StatusCode.Should().Be(HttpStatusCode.NoContent);

        using (var hidden = await app.SendAsync(HttpMethod.Get, $"/api/v1/training/progress-photos/{id}/content", bearer: a.Login.AccessToken))
            hidden.StatusCode.Should().Be(HttpStatusCode.NotFound);
        store.Count.Should().Be(0);
    }

    [Fact]
    public async Task ADeleteThatWinsBeforeTheUploadTakesTheLock_NeverLetsTheUploadWriteTheObject()
    {
        // O teste de cima só para o envio DENTRO do PutAsync, quando o upload já segura a trava. Aqui a parada é antes: a linha
        // pendente já foi confirmada e o envio ainda não pediu o SELECT ... FOR UPDATE, então a exclusão passa na frente.
        var store = new FakeProgressPhotoStore();
        var barrier = new CommandBarrier(sql =>
            sql.Contains("progress_photos", StringComparison.OrdinalIgnoreCase) && sql.Contains("FOR UPDATE", StringComparison.OrdinalIgnoreCase));
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { PhotoStorageEnabled = true, Photos = store, CommandInterceptor = barrier });
        var a = await app.NewGuestAsync("Conta A", ["module:training"], 78);
        var id = Guid.NewGuid();
        barrier.Arm();

        var upload = UploadAsync(app, a.Login.AccessToken, id);
        await barrier.Reached.WaitAsync(CommandBarrier.Ceiling, TestContext.Current.CancellationToken);
        await using (var pendingDb = app.Db())
            (await pendingDb.Set<ProgressPhoto>().SingleAsync(photo => photo.Id == id, TestContext.Current.CancellationToken)).State.Should().Be("pending");
        using (var deleted = await app.SendAsync(HttpMethod.Put, $"/api/v1/training/progress-photos/{id}/deletion", bearer: a.Login.AccessToken))
            deleted.StatusCode.Should().Be(HttpStatusCode.NoContent);
        barrier.Release();

        using var uploaded = await upload.WaitAsync(CommandBarrier.Ceiling, TestContext.Current.CancellationToken);
        uploaded.StatusCode.Should().Be(HttpStatusCode.NotFound, "a exclusão já respondeu 204: o envio relê a linha depois da trava e desiste");
        store.PutCalls.Should().Be(0, "nenhum JPEG de saúde pode ser gravado depois de a pessoa ver a foto apagada");
        store.Count.Should().Be(0);
        await using var db = app.Db();
        (await db.Set<ProgressPhoto>().SingleAsync(photo => photo.Id == id, TestContext.Current.CancellationToken)).State.Should().Be("deleted");
    }

    [Fact]
    public async Task WhenTheFinalCommitFails_TheObjectAlreadyWrittenIsRemoved_AndTheRetryStillWorks()
    {
        var store = new FakeProgressPhotoStore();
        var failure = new FailingCommand(sql =>
            SqlCommandText.StartsWithUpdate(sql) && sql.Contains("progress_photos", StringComparison.OrdinalIgnoreCase));
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { PhotoStorageEnabled = true, Photos = store, CommandInterceptor = failure });
        var a = await app.NewGuestAsync("Conta A", ["module:training"], 79);
        var id = Guid.NewGuid();
        failure.Arm();

        using (var failed = await UploadAsync(app, a.Login.AccessToken, id)) failed.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        store.PutCalls.Should().Be(1);
        store.Count.Should().Be(0, "sem linha ready apontando para o objeto, ele ficaria órfão e invisível");
        await using (var pendingDb = app.Db())
            (await pendingDb.Set<ProgressPhoto>().SingleAsync(photo => photo.Id == id, TestContext.Current.CancellationToken)).State.Should().Be("pending");

        failure.Disarm();
        using (var retry = await UploadAsync(app, a.Login.AccessToken, id)) retry.StatusCode.Should().Be(HttpStatusCode.OK);
        store.Count.Should().Be(1);
        await using var db = app.Db();
        (await db.Set<ProgressPhoto>().SingleAsync(photo => photo.Id == id, TestContext.Current.CancellationToken)).State.Should().Be("ready");
    }

    [Fact]
    public async Task QuotaIsEnforced_AndWithoutTheConfigurationTheRouteIsAbsent()
    {
        var store = new FakeProgressPhotoStore();
        await using var limited = await TrainingApp.StartAsync(postgres, new TrainingAppOptions
        {
            PhotoStorageEnabled = true,
            Photos = store,
            PhotoMaxAccountPhotos = 1,
        });
        var member = await limited.NewGuestAsync("Conta", ["module:training"], 70);
        using (var first = await UploadAsync(limited, member.Login.AccessToken, Guid.NewGuid())) first.StatusCode.Should().Be(HttpStatusCode.OK);
        using (var overQuota = await UploadAsync(limited, member.Login.AccessToken, Guid.NewGuid())) overQuota.StatusCode.Should().Be(HttpStatusCode.RequestEntityTooLarge);

        await using var disabled = await TrainingApp.StartAsync(postgres);
        var disabledMember = await disabled.NewGuestAsync("Outra conta", ["module:training"], 71);
        using var listed = await disabled.SendAsync(HttpMethod.Get, "/api/v1/training/progress-photos", bearer: disabledMember.Login.AccessToken);
        listed.StatusCode.Should().Be(HttpStatusCode.NotFound, "a nuvem de fotos está aposentada: sem a configuração ligada, a rota não existe");
    }

    [Fact]
    public async Task UploadRemovesExifMetadataBeforeWritingTheObject()
    {
        var store = new FakeProgressPhotoStore();
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { PhotoStorageEnabled = true, Photos = store });
        var member = await app.NewGuestAsync("Conta", ["module:training"], 72);
        var withExif = new byte[Jpeg.Length + 10];
        Jpeg[..2].CopyTo(withExif, 0);
        new byte[] { 0xff, 0xe1, 0x00, 0x08, (byte)'E', (byte)'x', (byte)'i', (byte)'f', 0x00, 0x00 }.CopyTo(withExif, 2);
        Jpeg[2..].CopyTo(withExif, 12);

        using var uploaded = await UploadAsync(app, member.Login.AccessToken, Guid.NewGuid(), withExif);
        uploaded.StatusCode.Should().Be(HttpStatusCode.OK);
        store.SingleContent.AsSpan().IndexOf("Exif"u8).Should().Be(-1);
    }

    [Fact]
    public async Task AnotherAccount_CannotReadOverwriteOrDeleteMyPhoto_AndNeverSeesItInTheList()
    {
        var store = new FakeProgressPhotoStore();
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { PhotoStorageEnabled = true, Photos = store });
        var owner = await app.NewGuestAsync("Dona", ["module:training"], 73);
        var intruder = await app.NewGuestAsync("Intrusa", ["module:training"], 74);
        var id = Guid.NewGuid();
        using (var first = await UploadAsync(app, owner.Login.AccessToken, id)) first.StatusCode.Should().Be(HttpStatusCode.OK);

        using (var overwrite = await UploadAsync(app, intruder.Login.AccessToken, id)) overwrite.StatusCode.Should().Be(HttpStatusCode.NotFound);
        using (var read = await app.SendAsync(HttpMethod.Get, $"/api/v1/training/progress-photos/{id}/content", bearer: intruder.Login.AccessToken))
            read.StatusCode.Should().Be(HttpStatusCode.NotFound);
        using (var delete = await app.SendAsync(HttpMethod.Put, $"/api/v1/training/progress-photos/{id}/deletion", bearer: intruder.Login.AccessToken))
            delete.StatusCode.Should().Be(HttpStatusCode.NoContent, "apagar o que não é seu não revela nem remove nada");
        using (var list = await app.SendAsync(HttpMethod.Get, "/api/v1/training/progress-photos", bearer: intruder.Login.AccessToken))
            (await TrainingApp.JsonAsync(list)).GetArrayLength().Should().Be(0);

        store.Count.Should().Be(1, "o objeto da dona continua guardado");
        using var stillMine = await app.SendAsync(HttpMethod.Get, $"/api/v1/training/progress-photos/{id}/content", bearer: owner.Login.AccessToken);
        stillMine.StatusCode.Should().Be(HttpStatusCode.OK);
        stillMine.Headers.CacheControl!.NoStore.Should().BeTrue();
        stillMine.Headers.GetValues("X-Content-Type-Options").Should().Equal("nosniff");
        stillMine.Content.Headers.ContentType!.MediaType.Should().Be("image/jpeg");
        (await stillMine.Content.ReadAsByteArrayAsync(TestContext.Current.CancellationToken)).Should().Equal(store.SingleContent);
    }

    [Fact]
    public async Task WithoutASession_EveryPhotoRouteAnswers401_AndTheStorageIsNeverTouched()
    {
        var store = new FakeProgressPhotoStore();
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { PhotoStorageEnabled = true, Photos = store });
        var id = Guid.NewGuid();

        using (var put = await UploadAsync(app, null, id)) put.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        using (var list = await app.SendAsync(HttpMethod.Get, "/api/v1/training/progress-photos")) list.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        using (var read = await app.SendAsync(HttpMethod.Get, $"/api/v1/training/progress-photos/{id}/content")) read.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        using (var delete = await app.SendAsync(HttpMethod.Put, $"/api/v1/training/progress-photos/{id}/deletion")) delete.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        store.Count.Should().Be(0);
    }

    [Fact]
    public async Task TheTypeIsCheckedByTheContent_NotByTheHeader_AndNothingInvalidIsSaved()
    {
        var store = new FakeProgressPhotoStore();
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { PhotoStorageEnabled = true, Photos = store });
        var member = await app.NewGuestAsync("Conta", ["module:training"], 75);
        byte[] png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52];
        byte[] html = "<html><script>alert(1)</script></html>"u8.ToArray();

        // O cabeçalho diz image/jpeg, mas os bytes não são um JPEG decodificável.
        using (var asPng = await UploadAsync(app, member.Login.AccessToken, Guid.NewGuid(), png)) asPng.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        using (var asHtml = await UploadAsync(app, member.Login.AccessToken, Guid.NewGuid(), html)) asHtml.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        using (var truncated = await UploadAsync(app, member.Login.AccessToken, Guid.NewGuid(), Jpeg[..(Jpeg.Length / 2)])) truncated.StatusCode.Should().Be(HttpStatusCode.BadRequest);

        // O tipo declarado errado, a data ausente ou no futuro também são recusados.
        var wrongType = new ByteArrayContent(Jpeg);
        wrongType.Headers.ContentType = new MediaTypeHeaderValue("image/png");
        using (var response = await SendRawAsync(app, member.Login.AccessToken, Guid.NewGuid(), wrongType, $"takenOn={TakenOn}")) response.StatusCode.Should().Be(HttpStatusCode.UnsupportedMediaType);
        using (var noDate = await SendRawAsync(app, member.Login.AccessToken, Guid.NewGuid(), JpegContent(Jpeg), "")) noDate.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        using (var future = await SendRawAsync(app, member.Login.AccessToken, Guid.NewGuid(), JpegContent(Jpeg), "takenOn=2999-01-01")) future.StatusCode.Should().Be(HttpStatusCode.BadRequest);

        store.Count.Should().Be(0);
        await using var db = app.Db();
        (await db.Set<ProgressPhoto>().CountAsync(TestContext.Current.CancellationToken)).Should().Be(0);
    }

    [Fact]
    public async Task APhotoOverTheSizeLimit_Returns413_EvenWhenTheLengthIsNotDeclared()
    {
        var store = new FakeProgressPhotoStore();
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { PhotoStorageEnabled = true, Photos = store });
        var member = await app.NewGuestAsync("Conta", ["module:training"], 76);
        var tooBig = new byte[(5 * 1024 * 1024) + 1];

        using (var declared = await UploadAsync(app, member.Login.AccessToken, Guid.NewGuid(), tooBig)) declared.StatusCode.Should().Be(HttpStatusCode.RequestEntityTooLarge);

        // Sem Content-Length (corpo em pedaços): o limite vale pelo que realmente chega.
        var chunked = new StreamContent(new NonSeekableStream(tooBig));
        chunked.Headers.ContentType = new MediaTypeHeaderValue("image/jpeg");
        using (var undeclared = await SendRawAsync(app, member.Login.AccessToken, Guid.NewGuid(), chunked, $"takenOn={TakenOn}"))
            undeclared.StatusCode.Should().Be(HttpStatusCode.RequestEntityTooLarge);

        store.Count.Should().Be(0);
    }

    [Fact]
    public async Task WithoutTheStorageConfigured_TheAppRuns_AndTheCloudPhotoRoutesAreNotPublished()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var member = await app.NewGuestAsync("Conta", ["module:training"], 77);
        var id = Guid.NewGuid();

        using var list = await app.SendAsync(HttpMethod.Get, "/api/v1/training/progress-photos", bearer: member.Login.AccessToken);
        using var put = await UploadAsync(app, member.Login.AccessToken, id);
        using var read = await app.SendAsync(HttpMethod.Get, $"/api/v1/training/progress-photos/{id}/content", bearer: member.Login.AccessToken);
        using var delete = await app.SendAsync(HttpMethod.Put, $"/api/v1/training/progress-photos/{id}/deletion", bearer: member.Login.AccessToken);

        // A nuvem de fotos está aposentada: sem a configuração ligada de propósito, as rotas nem existem. Leitura cai no
        // 404 do fallback da API; escrita cai no 405 dele, que só atende GET e HEAD (nenhuma das duas chega ao Treino).
        foreach (var response in new[] { list, read })
            response.StatusCode.Should().Be(HttpStatusCode.NotFound);
        foreach (var response in new[] { put, delete })
            response.StatusCode.Should().BeOneOf(HttpStatusCode.NotFound, HttpStatusCode.MethodNotAllowed);

        await using var db = app.Db();
        (await db.Set<ProgressPhoto>().CountAsync(TestContext.Current.CancellationToken)).Should().Be(0, "sem armazenamento nada é gravado, nem metadado");
    }

    [Fact]
    public async Task Migration_AddsTheTableAfterThePrograms_KeepsTheRuntimeRoleWithoutDdl_AndTheChecksHold()
    {
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { MigrateTraining = false });
        await using (var training = TrainingApp.CreateContext(app.Database.OwnerConnection))
        {
            await training.Database.MigrateAsync("20261024120000_AddTrainingPrograms", TestContext.Current.CancellationToken);
            (await training.Database.GetPendingMigrationsAsync(TestContext.Current.CancellationToken)).Should().Equal("20261024130000_AddProgressPhotos", "20261028010130_AddBodyMeasurements", "20261028024002_AddCalendarEntries");
            await training.Database.MigrateAsync(TestContext.Current.CancellationToken);
            (await training.Database.GetPendingMigrationsAsync(TestContext.Current.CancellationToken)).Should().BeEmpty();
        }

        await using var connection = new NpgsqlConnection(app.Database.RuntimeConnection);
        await connection.OpenAsync(TestContext.Current.CancellationToken);
        var good = new string('a', 64);
        (await InsertRowAsync(connection, "progress-photos/ok.jpg", 12, good)).Should().Be(1);

        (await Assert.ThrowsAsync<PostgresException>(() => InsertRowAsync(connection, "progress-photos/ok.jpg", 12, good))).SqlState.Should().Be("23505");
        (await Assert.ThrowsAsync<PostgresException>(() => InsertRowAsync(connection, "progress-photos/wide.jpg", 4000, good))).SqlState.Should().Be("23514");
        (await Assert.ThrowsAsync<PostgresException>(() => InsertRowAsync(connection, "progress-photos/hash.jpg", 12, "not-a-hash"))).SqlState.Should().Be("23514");

        await using var ddl = new NpgsqlCommand("CREATE TABLE training.progress_photos_intruder (id int)", connection);
        (await Assert.ThrowsAsync<PostgresException>(() => ddl.ExecuteNonQueryAsync(TestContext.Current.CancellationToken))).SqlState.Should().Be("42501");
    }

    private static async Task<int> InsertRowAsync(NpgsqlConnection connection, string key, int width, string sha)
    {
        await using var insert = new NpgsqlCommand(
            "INSERT INTO training.progress_photos (id, user_id, taken_on, object_key, width, height, byte_length, sha256, state, created_at) "
            + "VALUES (gen_random_uuid(), gen_random_uuid(), '2026-10-20', @key, @w, 8, 1000, @sha, 'ready', now())", connection);
        insert.Parameters.AddWithValue("key", key);
        insert.Parameters.AddWithValue("w", width);
        insert.Parameters.AddWithValue("sha", sha);
        return await insert.ExecuteNonQueryAsync(TestContext.Current.CancellationToken);
    }

    private static ByteArrayContent JpegContent(byte[] bytes)
    {
        var content = new ByteArrayContent(bytes);
        content.Headers.ContentType = new MediaTypeHeaderValue("image/jpeg");
        return content;
    }

    private static Task<HttpResponseMessage> SendRawAsync(TrainingApp app, string? token, Guid id, HttpContent content, string query)
    {
        var request = new HttpRequestMessage(HttpMethod.Put, $"/api/v1/training/progress-photos/{id}?{query}") { Content = content };
        if (token is not null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return app.Client.SendAsync(request, TestContext.Current.CancellationToken);
    }

    private sealed class NonSeekableStream(byte[] bytes) : Stream
    {
        private int position;
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count)
        {
            var n = Math.Min(count, bytes.Length - position);
            Array.Copy(bytes, position, buffer, offset, n);
            position += n;
            return n;
        }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    private static Task<HttpResponseMessage> UploadAsync(TrainingApp app, string? token, Guid id, byte[]? jpeg = null) =>
        SendRawAsync(app, token, id, JpegContent(jpeg ?? Jpeg), $"takenOn={TakenOn}");

    private sealed class FakeProgressPhotoStore : IProgressPhotoObjectStore
    {
        private readonly ConcurrentDictionary<string, byte[]> objects = new(StringComparer.Ordinal);
        public bool IsAvailable => true;
        public bool FailPut { get; set; }
        public bool FailDelete { get; set; }
        public bool PausePut { get; set; }
        public TaskCompletionSource PutStarted { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource ContinuePut { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public IReadOnlyCollection<string> Keys => objects.Keys.ToArray();
        public int Count => objects.Count;
        public int PutCalls => Volatile.Read(ref _putCalls);
        private int _putCalls;
        public byte[] SingleContent => objects.Values.Single();
        public async Task PutAsync(string key, ReadOnlyMemory<byte> content, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _putCalls);
            if (FailPut) throw new IOException("synthetic put failure");
            if (PausePut)
            {
                PutStarted.TrySetResult();
                await ContinuePut.Task.WaitAsync(cancellationToken);
            }
            objects[key] = content.ToArray();
        }
        public Task<Stream?> OpenReadAsync(string key, CancellationToken cancellationToken)
        {
            Stream? content = objects.TryGetValue(key, out var bytes) ? new MemoryStream(bytes, writable: false) : null;
            return Task.FromResult(content);
        }
        public Task DeleteAsync(string key, CancellationToken cancellationToken)
        {
            if (FailDelete) throw new IOException("synthetic delete failure");
            objects.TryRemove(key, out _);
            return Task.CompletedTask;
        }
    }
}
