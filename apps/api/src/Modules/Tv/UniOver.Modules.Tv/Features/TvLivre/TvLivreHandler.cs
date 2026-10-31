using System.Globalization;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Cleanup;
using UniOver.Modules.Tv.Features.Commands;
using UniOver.Modules.Tv.Features.Selection;
using UniOver.Modules.Tv.Persistence;
using UniOver.Modules.Tv.Ports;
using UniOver.SharedKernel;

namespace UniOver.Modules.Tv.Features.TvLivre;

/// <summary>Como terminou um passo: não há o que fazer nesta TV, a vez estava ocupada, deu certo ou falhou (com o resultado do envio).</summary>
internal enum LivreStepKind
{
    Done,
    Unsupported,
    Busy,
    Failed,
}

internal sealed record LivreStep(LivreStepKind Kind, TvSendOutcome? Outcome = null)
{
    public static LivreStep Done { get; } = new(LivreStepKind.Done);

    public static LivreStep Unsupported { get; } = new(LivreStepKind.Unsupported);

    public static LivreStep Busy { get; } = new(LivreStepKind.Busy);

    public static LivreStep Failed(TvSendOutcome outcome) => new(LivreStepKind.Failed, outcome);
}

/// <summary>
/// O TV Livre da TV escolhida na requisição: a configuração e a foto que o dono guarda e os passos que o agente executa
/// no aparelho. Guardar não fala com a TV; os passos só rodam com agente online da TV que anuncia
/// <see cref="Capability"/>, um por vez em cada TV, e passam pelo mesmo caminho dos outros comandos (agente, tempo limite e
/// trilha de auditoria).
/// </summary>
internal sealed class TvLivreHandler(
    TvCommandRunner runner,
    ITvLivreRequests requests,
    ITvCurrentSelection selection,
    IAgentPresenceReader presence,
    TvLivreStore store,
    TvDbContext db,
    IOptions<TvModuleOptions> options,
    TimeProvider time)
{
    /// <summary>Capacidade que o agente anuncia no <c>agent.hello.v1</c> quando sabe executar o TV Livre.</summary>
    public const string Capability = "tv.livre.v1";

    /// <summary>
    /// Folga para o estado chegar depois do resultado do comando. O agente o manda antes e o Devices trata os quadros de um
    /// agente em ordem, então normalmente já está guardado; a folga só cobre uma ordem trocada (a mesma da limpeza).
    /// </summary>
    public static readonly TimeSpan StateGrace = CleanupHandler.ReportGrace;

    private Guid TvId => selection.Current.Id;

    public async Task<TvLivreView> ViewAsync(CancellationToken cancellationToken)
    {
        var tvId = TvId;
        var entry = await db.TvLivre.AsNoTracking().SingleOrDefaultAsync(e => e.TvId == tvId, cancellationToken);
        return TvLivreView.From(entry, IsAvailable());
    }

    /// <summary>Há agente online da TV atual com a capacidade: é o que faz o módulo aparecer na tela.</summary>
    public bool IsAvailable() =>
        AgentInfo() is { Connected: true } info && info.Capabilities.Contains(Capability, StringComparer.Ordinal);

    // ---- o que o dono guarda (não fala com a TV) ----

    public async Task SaveConfigAsync(LivreConfig config, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(config);
        var entry = await store.EnsureAsync(TvId, cancellationToken);
        entry.SaveConfig(LivreConfigValidator.Serialize(LivreConfigValidator.Normalize(config)), time.GetUtcNow());
        await db.SaveChangesAsync(cancellationToken);
    }

    public async Task SavePhotoAsync(byte[] photo, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(photo);
        var entry = await store.EnsureAsync(TvId, cancellationToken);
        entry.SavePhoto(photo, LivrePhoto.Sha256Hex(photo), time.GetUtcNow());
        await db.SaveChangesAsync(cancellationToken);
    }

    public async Task<(byte[] Data, string Sha256)?> ReadPhotoAsync(CancellationToken cancellationToken)
    {
        var tvId = TvId;
        var row = await db.TvLivre.AsNoTracking().Where(e => e.TvId == tvId)
            .Select(e => new { e.PhotoData, e.PhotoSha256 }).SingleOrDefaultAsync(cancellationToken);
        return row is { PhotoData: { Length: > 0 } data, PhotoSha256: { } sha } ? (data, sha) : null;
    }

    public async Task RemovePhotoAsync(CancellationToken cancellationToken)
    {
        var tvId = TvId;
        var entry = await db.TvLivre.SingleOrDefaultAsync(e => e.TvId == tvId, cancellationToken);
        if (entry?.PhotoData is null)
        {
            return;
        }

        entry.RemovePhoto(time.GetUtcNow());
        await db.SaveChangesAsync(cancellationToken);
    }

    // ---- os passos no aparelho ----

    public Task<LivreStep> RefreshAsync(TvCommandOrigin origin, CancellationToken cancellationToken) =>
        SingleAsync(origin, TvCommandNames.LivreRefresh, null, TvLivreAction.Status, longTimeout: false, cancellationToken);

    public Task<LivreStep> InstallAsync(TvCommandOrigin origin, CancellationToken cancellationToken) =>
        SingleAsync(origin, TvCommandNames.LivreInstall, null, TvLivreAction.Install, longTimeout: true, cancellationToken);

    public Task<LivreStep> SetHomeAsync(TvCommandOrigin origin, bool disableFactory, CancellationToken cancellationToken) =>
        SingleAsync(
            origin, TvCommandNames.LivreSetHome, disableFactory ? "disableFactory" : null, TvLivreAction.SetHome,
            longTimeout: true, cancellationToken, disableFactory: disableFactory);

    public Task<LivreStep> RestoreAsync(TvCommandOrigin origin, bool uninstall, CancellationToken cancellationToken) =>
        SingleAsync(
            origin, TvCommandNames.LivreRestore, uninstall ? null : "keep", TvLivreAction.Restore,
            longTimeout: true, cancellationToken, uninstall: uninstall);

    public Task<LivreStep> SetAppsAsync(
        TvCommandOrigin origin, IReadOnlyList<string> disable, IReadOnlyList<string> enable, CancellationToken cancellationToken) =>
        SingleAsync(
            origin, TvCommandNames.LivreSetApps,
            string.Create(CultureInfo.InvariantCulture, $"disable={disable.Count},enable={enable.Count}"),
            TvLivreAction.SetApps, longTimeout: true, cancellationToken, disable: disable, enable: enable);

    /// <summary>O Modo Dormir só abre a tela; o estado não muda, então não espera por ele.</summary>
    public Task<LivreStep> SleepAsync(TvCommandOrigin origin, CancellationToken cancellationToken) =>
        SingleAsync(
            origin, TvCommandNames.LivreSleep, null, TvLivreAction.Sleep, longTimeout: false, cancellationToken, waitForState: false);

    /// <summary>
    /// Aplica a configuração guardada: se o fundo é uma foto e há foto guardada, ela vai antes em pedaços (cada um é um
    /// comando que o agente confirma), com um identificador novo por aplicação; depois vai o <c>apply</c> com a revisão
    /// seguinte. O número é gravado antes de o comando sair e só cresce, mesmo que a aplicação falhe: o launcher ignora
    /// um número que não seja maior que o que já tem.
    /// </summary>
    public async Task<LivreStep> ApplyAsync(TvCommandOrigin origin, CancellationToken cancellationToken)
    {
        if (RefusesToRun())
        {
            return LivreStep.Unsupported;
        }

        var tvId = TvId;
        using var ticket = requests.TryBegin(tvId);
        if (ticket is null)
        {
            return LivreStep.Busy;
        }

        var entry = await store.EnsureAsync(tvId, cancellationToken);
        var config = LivreConfigValidator.Parse(entry.ConfigJson);
        var configJson = LivreConfigValidator.ToLauncherJson(config);

        Guid? photoId = null;
        if (config.Wallpaper.Type == "photo" && entry.PhotoData is { Length: > 0 } photo)
        {
            photoId = IdGenerator.NewId();
            var failed = await SendPhotoAsync(origin, photoId.Value, photo, cancellationToken);
            if (failed is not null)
            {
                return LivreStep.Failed(failed);
            }
        }

        var revision = entry.NextRevision(time.GetUtcNow());
        await db.SaveChangesAsync(cancellationToken);

        var outcome = await runner.RunAsync(
            origin,
            TvCommandNames.LivreApply,
            string.Create(CultureInfo.InvariantCulture, $"revision={revision}"),
            TvMessages.TvLivre(ticket.RequestId, TvLivreAction.Apply, revision: revision, configJson: configJson, photoId: photoId),
            waitForReply: true,
            cancellationToken,
            options.Value.LivreTimeout);
        if (!outcome.IsDelivered)
        {
            return LivreStep.Failed(outcome);
        }

        await ticket.WaitForStateAsync(StateGrace, cancellationToken);
        return LivreStep.Done;
    }

    /// <summary>Manda os pedaços na ordem; devolve o resultado do primeiro que não foi entregue (e o registra na trilha), ou nulo.</summary>
    private async Task<TvSendOutcome?> SendPhotoAsync(TvCommandOrigin origin, Guid photoId, byte[] photo, CancellationToken cancellationToken)
    {
        var sha256 = LivrePhoto.Sha256Hex(photo);
        var chunks = LivrePhoto.Slice(photo);
        for (var index = 0; index < chunks.Count; index++)
        {
            // Sem linha na trilha por pedaço: são até 16 mensagens do mesmo pedido. Só a falha de um deixa a sua.
            var outcome = await runner.RunAsync(
                origin,
                TvCommandNames.LivreApply,
                null,
                TvMessages.TvLivrePhotoChunk(photoId, index, chunks.Count, sha256, chunks[index]),
                waitForReply: true,
                cancellationToken,
                audited: false);
            if (!outcome.IsDelivered)
            {
                await runner.RecordAsync(origin, TvCommandNames.LivreApply, "photo", outcome);
                return outcome;
            }
        }

        return null;
    }

    private async Task<LivreStep> SingleAsync(
        TvCommandOrigin origin,
        string command,
        string? detail,
        TvLivreAction action,
        bool longTimeout,
        CancellationToken cancellationToken,
        bool waitForState = true,
        bool? disableFactory = null,
        bool? uninstall = null,
        IReadOnlyList<string>? disable = null,
        IReadOnlyList<string>? enable = null)
    {
        if (RefusesToRun())
        {
            return LivreStep.Unsupported;
        }

        using var ticket = requests.TryBegin(TvId);
        if (ticket is null)
        {
            return LivreStep.Busy;
        }

        var outcome = await runner.RunAsync(
            origin,
            command,
            detail,
            TvMessages.TvLivre(
                ticket.RequestId, action, disableFactory: disableFactory, uninstall: uninstall, disable: disable, enable: enable),
            waitForReply: true,
            cancellationToken,
            longTimeout ? options.Value.LivreTimeout : null);
        if (!outcome.IsDelivered)
        {
            return LivreStep.Failed(outcome);
        }

        if (waitForState)
        {
            await ticket.WaitForStateAsync(StateGrace, cancellationToken);
        }

        return LivreStep.Done;
    }

    /// <summary>
    /// O agente está online e NÃO anuncia a capacidade: o módulo não existe para esta TV (a Samsung, por exemplo). Agente
    /// fora do ar não entra aqui: o comando segue e responde 503 como os demais, que é o que a tela sabe explicar.
    /// </summary>
    private bool RefusesToRun() =>
        AgentInfo() is { Connected: true } info && !info.Capabilities.Contains(Capability, StringComparer.Ordinal);

    private AgentPresenceInfo? AgentInfo() =>
        selection.Current.AgentSlug is { Length: > 0 } slug ? presence.Get(slug) : null;
}
