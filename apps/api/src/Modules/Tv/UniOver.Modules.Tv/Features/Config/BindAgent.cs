using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Commands;
using UniOver.Modules.Tv.Persistence;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Features.Config;

/// <param name="AgentSlug">O computador (agente) que passa a controlar a TV: um dos pareados e não revogados.</param>
/// <param name="Name">Nome da TV; ausente ou vazio mantém o atual.</param>
internal sealed record BindAgentRequest(string? AgentSlug, string? Name);

internal sealed record BindAgentCommand(TvCommandOrigin Origin, string AgentSlug, string? Name);

internal static class BindAgentValidator
{
    /// <summary>
    /// Mensagem única para qualquer computador que não possa ser escolhido (vazio, fora do formato, nunca pareado ou
    /// revogado): quem recusa não deixa pista de qual dos casos foi.
    /// </summary>
    public const string AgentRefused = "Escolha um dos computadores pareados da lista.";

    /// <summary>O slug só pode ser o de um agente pareado: texto vazio ou maior que o limite nem chega a ser procurado.</summary>
    public static bool IsPlausibleSlug(string? slug) =>
        !string.IsNullOrWhiteSpace(slug) && slug.Length <= ConfiguredTv.AgentSlugMax;

    public static Dictionary<string, string[]> ValidateName(string? name) => ValidateName(name, out _);

    /// <param name="normalized">
    /// O nome já NORMALIZADO (espaços arrumados, NFC): é ele, e não o texto recebido, que vai para o comando. Nulo quando
    /// não há nome (a TV fica com o atual) ou quando foi recusado.
    /// </param>
    public static Dictionary<string, string[]> ValidateName(string? name, out string? normalized)
    {
        normalized = null;
        var errors = new Dictionary<string, string[]>();
        var text = LabelText.Normalize(name);
        if (text.Problem == LabelTextProblem.TooLong || (text.IsValid && text.Value.Length > ConfiguredTv.NameMax))
        {
            errors["name"] = [$"O nome deve ter no máximo {ConfiguredTv.NameMax} caracteres."];
        }
        else if (!text.IsValid)
        {
            errors["name"] = ["O nome não pode ter caracteres de controle nem invisíveis."];
        }
        else if (text.Value.Length > 0)
        {
            normalized = text.Value;
        }

        return errors;
    }
}

internal sealed class BindAgentHandler(
    TvDbContext db,
    IAgentDirectory directory,
    ITvAgentResolver agents,
    ITvCommandAudit audit,
    ITvStateStore state,
    ITvAgentPresence presence,
    ITvStreamPublisher stream,
    TvConfigView view,
    TimeProvider time)
{
    /// <summary>
    /// Passa o controle da TV para o computador escolhido. Devolve a configuração nova, ou nulo quando o computador não
    /// existe entre os pareados ou foi revogado (nada é gravado). A troca e a linha da trilha saem no mesmo
    /// <c>SaveChanges</c>: não há troca sem registro de quem a fez, nem registro de uma troca que não houve. Salvar o
    /// mesmo computador que já estava não grava nem registra nada, a não ser que o valor viesse só da variável de
    /// ambiente: aí a linha é criada, que é como o administrador tira a variável do servidor com segurança. Se dois
    /// primeiros salvamentos chegam juntos e o índice único barra o segundo, ele relê a linha que ficou e aplica a regra
    /// normal (igual: nada a gravar; diferente: o último vence), sem erro.
    /// </summary>
    public async Task<TvConfigResponse?> HandleAsync(BindAgentCommand command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        if (!BindAgentValidator.IsPlausibleSlug(command.AgentSlug))
        {
            return null;
        }

        // Só vale quem está pareado e não foi revogado; a mesma recusa serve para "nunca existiu" e "revogado".
        var listing = await directory.FindAsync(command.AgentSlug, cancellationToken);
        if (listing is null || listing.Revoked)
        {
            return null;
        }

        var now = time.GetUtcNow();
        ConfiguredTv tv;
        bool changed;
        var attempt = 0;
        while (true)
        {
            attempt++;
            var existing = await db.Tvs.SingleOrDefaultAsync(t => t.IsDefault, cancellationToken);
            if (existing is null)
            {
                tv = ConfiguredTv.CreateDefault(command.Name, listing.Slug, command.Origin.UserId, now);
                db.Tvs.Add(tv);
                changed = true;
            }
            else
            {
                tv = existing;
                changed = tv.Rebind(listing.Slug, command.Name, command.Origin.UserId, now);
            }

            if (!changed)
            {
                break;
            }

            var entry = CommandAuditEntry.Create(
                command.Origin.UserId, listing.Slug, TvCommandNames.ConfigBind, listing.Slug,
                ok: true, errorCode: null, latencyMs: null, command.Origin.Client, now, tv.Id);
            try
            {
                // O EfCommandAudit usa este mesmo TvDbContext: um SaveChanges grava a TV e a trilha juntas.
                await audit.RecordAsync(entry, cancellationToken);
                break;
            }
            catch (DbUpdateException ex) when (attempt == 1 && IsDefaultTvTaken(ex))
            {
                // Dois primeiros salvamentos ao mesmo tempo: o outro criou a linha da TV padrão primeiro e o índice único
                // barrou o nosso INSERT (a TV e a trilha, juntas, não foram gravadas). Em vez de 500, esquece o que estava
                // pendente (a TV perdedora e a linha da trilha) e refaz a decisão a partir da linha que ficou: com o mesmo
                // computador e nome nada mais é gravado (idempotente); com outro, o último vence, como numa troca normal.
                db.ChangeTracker.Clear();
            }
            catch
            {
                // Sem saber se o que foi gravado valeu, o valor guardado em memória não é de confiança.
                agents.Invalidate();
                throw;
            }
        }

        var binding = new TvAgentBinding(tv.AgentSlug, tv.Name, TvAgentSource.Saved);
        agents.Set(binding);
        if (changed)
        {
            AnnounceNewAgent(tv.Id, binding.AgentSlug!);
        }

        return await view.ReadAsync(binding, cancellationToken);
    }

    /// <summary>O INSERT da TV padrão bateu no índice único: já existe uma linha padrão que este salvamento não viu.</summary>
    private static bool IsDefaultTvTaken(DbUpdateException exception) =>
        exception.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation, TableName: "tvs" };

    /// <summary>
    /// As telas abertas passam a mostrar o computador novo na hora. Publica sempre, e não só quando a presença "mudou":
    /// o computador novo pode nunca ter sido visto pelo módulo, e sem isto a tela ficaria com o estado do antigo.
    /// </summary>
    private void AnnounceNewAgent(Guid tvId, string agentSlug)
    {
        stream.AdoptUnidentifiedStream(tvId);
        var online = presence.IsOnline(agentSlug);
        state.NoteOnline(agentSlug, online);
        stream.PublishState(tvId, TvState.From(state.Last(agentSlug), online));
    }
}

internal static class BindAgentEndpoint
{
    public static void MapBindAgent(this IEndpointRouteBuilder group) =>
        group.MapPut("/config/agent", HandleAsync)
            .RequireAuthorization(StepUp.Policy(TvAuth.BindAgentAction))
            .RequireRateLimiting(RateLimitPolicies.Login)
            .Produces<TvConfigResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);

    private static async Task<IResult> HandleAsync(
        BindAgentRequest? request,
        HttpRequest requestHttp,
        ICurrentUser current,
        HttpContext http,
        BindAgentHandler handler,
        CancellationToken cancellationToken)
    {
        if (LegacyConfigRoute.RejectTvId(requestHttp) is { } rejection)
        {
            return rejection;
        }

        var errors = BindAgentValidator.ValidateName(request?.Name, out var name);
        if (!BindAgentValidator.IsPlausibleSlug(request?.AgentSlug))
        {
            errors["agentSlug"] = [BindAgentValidator.AgentRefused];
        }

        if (errors.Count > 0)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        if (TvHttp.OriginOf(current, http) is not { } origin)
        {
            return TvProblems.Unauthenticated();
        }

        var updated = await handler.HandleAsync(new BindAgentCommand(origin, request!.AgentSlug!, name), cancellationToken);
        return updated is null
            ? ProblemDetailsExtensions.ValidationProblem(new Dictionary<string, string[]>
            {
                ["agentSlug"] = [BindAgentValidator.AgentRefused],
            })
            : TypedResults.Ok(updated);
    }
}
