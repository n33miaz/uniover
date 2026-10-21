using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
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

    public static Dictionary<string, string[]> ValidateName(string? name)
    {
        var errors = new Dictionary<string, string[]>();
        if (name is null || string.IsNullOrWhiteSpace(name))
        {
            return errors;
        }

        if (name.Trim().Length > ConfiguredTv.NameMax)
        {
            errors["name"] = [$"O nome deve ter no máximo {ConfiguredTv.NameMax} caracteres."];
        }
        else if (name.Any(c => c <= '\u001f' || (c >= '\u007f' && c <= '\u009f')))
        {
            errors["name"] = ["O nome não pode ter caracteres de controle."];
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
    /// ambiente: aí a linha é criada, que é como o administrador tira a variável do servidor com segurança.
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
        var tv = await db.Tvs.SingleOrDefaultAsync(t => t.IsDefault, cancellationToken);
        bool changed;
        if (tv is null)
        {
            tv = ConfiguredTv.CreateDefault(command.Name, listing.Slug, command.Origin.UserId, now);
            db.Tvs.Add(tv);
            changed = true;
        }
        else
        {
            changed = tv.Rebind(listing.Slug, command.Name, command.Origin.UserId, now);
        }

        if (changed)
        {
            var entry = CommandAuditEntry.Create(
                command.Origin.UserId, listing.Slug, TvCommandNames.ConfigBind, listing.Slug,
                ok: true, errorCode: null, latencyMs: null, command.Origin.Client, now);
            try
            {
                // O EfCommandAudit usa este mesmo TvDbContext: um SaveChanges grava a TV e a trilha juntas.
                await audit.RecordAsync(entry, cancellationToken);
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
            AnnounceNewAgent(binding.AgentSlug!);
        }

        return await view.ReadAsync(binding, cancellationToken);
    }

    /// <summary>
    /// As telas abertas passam a mostrar o computador novo na hora. Publica sempre, e não só quando a presença "mudou":
    /// o computador novo pode nunca ter sido visto pelo módulo, e sem isto a tela ficaria com o estado do antigo.
    /// </summary>
    private void AnnounceNewAgent(string agentSlug)
    {
        var online = presence.IsOnline(agentSlug);
        state.NoteOnline(agentSlug, online);
        stream.PublishState(TvState.From(state.Last(agentSlug), online));
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
        ICurrentUser current,
        HttpContext http,
        BindAgentHandler handler,
        CancellationToken cancellationToken)
    {
        var errors = BindAgentValidator.ValidateName(request?.Name);
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

        var updated = await handler.HandleAsync(new BindAgentCommand(origin, request!.AgentSlug!, request.Name), cancellationToken);
        return updated is null
            ? ProblemDetailsExtensions.ValidationProblem(new Dictionary<string, string[]>
            {
                ["agentSlug"] = [BindAgentValidator.AgentRefused],
            })
            : TypedResults.Ok(updated);
    }
}
