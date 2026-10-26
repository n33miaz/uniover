using System.Reflection;
using AwesomeAssertions;
using UniOver.Modules.Identity.Audit;
using UniOver.Modules.Identity.Domain;
using UniOver.SharedKernel.Audit;

namespace UniOver.Modules.Identity.Tests.Audit;

public class IdentityAuditNormalizerTests
{
    private static readonly DateTimeOffset At = new(2026, 10, 21, 12, 0, 0, TimeSpan.Zero);
    private static readonly Guid Admin = Guid.Parse("11111111-1111-7111-8111-111111111111");
    private static readonly Guid Guest = Guid.Parse("22222222-2222-7222-8222-222222222222");

    private static AuditRecord Normalize(string eventName, Guid? user = null, string? detail = null) =>
        IdentityAuditNormalizer.Normalize(
            LoginAuditEntry.Create(user, eventName, At, "203.0.113.7", "navegador/1.0", detail));

    [Theory]
    [InlineData(AuditEvents.LoginSucceeded, AuditOutcome.Success)]
    [InlineData(AuditEvents.LoginFailed, AuditOutcome.Failure)]
    [InlineData(AuditEvents.LoginLocked, AuditOutcome.Denied)]
    [InlineData(AuditEvents.RefreshSucceeded, AuditOutcome.Success)]
    [InlineData(AuditEvents.RefreshReuseDetected, AuditOutcome.Denied)]
    [InlineData(AuditEvents.Logout, AuditOutcome.Success)]
    [InlineData(AuditEvents.OwnerCreated, AuditOutcome.Success)]
    [InlineData(AuditEvents.PasskeyRegistered, AuditOutcome.Success)]
    [InlineData(AuditEvents.PasskeyRenamed, AuditOutcome.Success)]
    [InlineData(AuditEvents.PasskeyRemoved, AuditOutcome.Success)]
    [InlineData(AuditEvents.StepUpSucceeded, AuditOutcome.Success)]
    [InlineData(AuditEvents.StepUpFailed, AuditOutcome.Failure)]
    [InlineData(AuditEvents.GuestInviteCreated, AuditOutcome.Success)]
    [InlineData(AuditEvents.GuestInviteAccepted, AuditOutcome.Success)]
    [InlineData(AuditEvents.GuestInviteRevoked, AuditOutcome.Success)]
    [InlineData(AuditEvents.GuestRevoked, AuditOutcome.Success)]
    [InlineData(AuditEvents.SessionRevoked, AuditOutcome.Success)]
    [InlineData(AuditEvents.PermissionsChanged, AuditOutcome.Success)]
    [InlineData(AuditEvents.ProfileUpdated, AuditOutcome.Success)]
    [InlineData(AuditEvents.QrLoginApproved, AuditOutcome.Success)]
    [InlineData(AuditEvents.QrLoginDenied, AuditOutcome.Success)]
    [InlineData(AuditEvents.QrLoginSucceeded, AuditOutcome.Success)]
    [InlineData(AuditEvents.AuditExported, AuditOutcome.Success)]
    public void Outcome_IsDerivedFromTheEventName(string eventName, AuditOutcome expected)
    {
        Normalize(eventName).Outcome.Should().Be(expected);
    }

    [Fact]
    public void EveryEventTheTableCanHold_IsListedOnce_AndFitsTheColumn()
    {
        var declared = typeof(AuditEvents)
            .GetFields(BindingFlags.Public | BindingFlags.Static | BindingFlags.FlattenHierarchy)
            .Where(f => f is { IsLiteral: true, FieldType: { } t } && t == typeof(string))
            .Select(f => (string)f.GetRawConstantValue()!)
            .ToList();

        AuditEvents.All.Should().OnlyHaveUniqueItems();
        AuditEvents.All.Should().BeEquivalentTo(declared, "um evento novo precisa entrar na lista que a tela e o filtro usam");
        AuditEvents.All.Should().OnlyContain(e => e.Length <= 40, "a coluna event tem 40 caracteres");
    }

    [Fact]
    public void CommonFields_AreCopiedAsTheyAre()
    {
        var entry = LoginAuditEntry.Create(Admin, AuditEvents.LoginSucceeded, At, "203.0.113.7", "navegador/1.0");

        var record = IdentityAuditNormalizer.Normalize(entry);

        record.Id.Should().Be(entry.Id);
        record.OccurredAt.Should().Be(At);
        record.Module.Should().Be("identity");
        record.Action.Should().Be("login_succeeded");
        record.ActorId.Should().Be(Admin);
        record.Ip.Should().Be("203.0.113.7");
        record.UserAgent.Should().Be("navegador/1.0");
        record.Target.Should().BeNull();
        record.TargetUserId.Should().BeNull();
        record.Detail.Should().BeNull();
    }

    [Fact]
    public void SessionRevocation_IdentifiesTheAffectedAccountAndFamily()
    {
        var family = Guid.Parse("33333333-3333-7333-8333-333333333333");
        var record = Normalize(AuditEvents.SessionRevoked, Admin, $"{Guest:N}|{family:N}");

        record.ActorId.Should().Be(Admin);
        record.TargetUserId.Should().Be(Guest);
        record.Target.Should().Be(family.ToString("N"));
        record.Detail.Should().BeNull();
    }

    [Fact]
    public void FailedLoginOfAnUnknownAccount_HasNoActor_AndNoTarget()
    {
        var unknown = Normalize(AuditEvents.LoginFailed);

        unknown.ActorId.Should().BeNull();
        unknown.TargetUserId.Should().BeNull("o e-mail não existe: não há conta a apontar");
        unknown.Outcome.Should().Be(AuditOutcome.Failure);
        unknown.Detail.Should().BeNull();
    }

    [Theory]
    [InlineData(AuditEvents.LoginFailed, AuditOutcome.Failure)]
    [InlineData(AuditEvents.LoginLocked, AuditOutcome.Denied)]
    [InlineData(AuditEvents.RefreshReuseDetected, AuditOutcome.Denied)]
    public void AnAttemptAgainstAnAccount_PutsTheAccountAsTarget_AndLeavesTheActorEmpty(string eventName, AuditOutcome outcome)
    {
        var record = Normalize(eventName, user: null, detail: AuditAboutAccount.Detail(Guest));

        record.ActorId.Should().BeNull("quem tentou não está autenticado e não se sabe quem é");
        record.TargetUserId.Should().Be(Guest);
        record.Detail.Should().BeNull("o id da conta não é um detalhe: vira o alvo");
        record.Outcome.Should().Be(outcome);
        record.Ip.Should().Be("203.0.113.7", "o IP e o aparelho seguem gravados");
        record.UserAgent.Should().Be("navegador/1.0");
    }

    [Fact]
    public void ADisabledAccountsLogin_KeepsTheReason_AndTheAccountIsTheTarget()
    {
        var record = Normalize(AuditEvents.LoginFailed, user: null, detail: AuditAboutAccount.Detail(Guest, "account-disabled"));

        record.ActorId.Should().BeNull();
        record.TargetUserId.Should().Be(Guest);
        record.Detail.Should().Be("account-disabled");
    }

    [Theory]
    [InlineData(AuditEvents.LoginFailed, "account-disabled")]
    [InlineData(AuditEvents.LoginFailed, null)]
    [InlineData(AuditEvents.LoginLocked, null)]
    [InlineData(AuditEvents.RefreshReuseDetected, null)]
    public void OldRows_WrittenWithTheAccountAsTheAuthor_StayExactlyAsTheyWere(string eventName, string? detail)
    {
        // A trilha é só de inclusão: as linhas gravadas antes da correção não são reescritas nem reinterpretadas.
        var record = Normalize(eventName, Guest, detail);

        record.ActorId.Should().Be(Guest);
        record.TargetUserId.Should().BeNull();
        record.Detail.Should().Be(detail);
    }

    [Theory]
    [InlineData(AuditEvents.LoginFailed)]
    [InlineData(AuditEvents.LoginLocked)]
    public void PasskeyRegistration_WrongPassword_KeepsTheAuthenticatedUserAsTheActor(string eventName)
    {
        // Esse caminho exige sessão: quem errou a senha é a pessoa autenticada, não "alguém sem login".
        var record = Normalize(eventName, Admin, "passkey-registration");

        record.ActorId.Should().Be(Admin);
        record.TargetUserId.Should().BeNull();
        record.Detail.Should().Be("passkey-registration");
    }

    [Fact]
    public void TheDetailOfAnAttempt_UsesTheSameShapeAsTheEventsOfTheAdministratorAboutAnAccount()
    {
        AuditAboutAccount.Detail(Guest).Should().Be(Guest.ToString("N"));
        AuditAboutAccount.Detail(Guest, "account-disabled").Should().Be($"{Guest:N}|account-disabled");
        IdentityAuditNormalizer.TargetAccountEvents.Should().Contain(
            [AuditEvents.LoginFailed, AuditEvents.LoginLocked, AuditEvents.RefreshReuseDetected, AuditEvents.GuestRevoked, AuditEvents.PermissionsChanged],
            "o filtro por pessoa casa a conta que agiu OU a atingida");
    }

    [Fact]
    public void PermissionsChanged_SplitsTheAccountFromWhatChanged()
    {
        var record = Normalize(AuditEvents.PermissionsChanged, Admin, $"{Guest:N}|+tv:power,tv:launch|-tv:history");

        record.ActorId.Should().Be(Admin);
        record.TargetUserId.Should().Be(Guest);
        record.Detail.Should().Be("+tv:power,tv:launch|-tv:history");
        record.Target.Should().BeNull();
    }

    [Theory]
    [InlineData("não-é-um-id|+tv:power|-")]
    [InlineData("")]
    [InlineData("1234")]
    public void PermissionsChanged_WithAnUnexpectedShape_KeepsTheTextAndInventsNoAccount(string detail)
    {
        var record = Normalize(AuditEvents.PermissionsChanged, Admin, detail);

        record.TargetUserId.Should().BeNull();
        record.Detail.Should().Be(detail.Length == 0 ? null : detail);
    }

    [Fact]
    public void GuestRevoked_PointsAtTheAccount()
    {
        var record = Normalize(AuditEvents.GuestRevoked, Admin, Guest.ToString("N"));

        record.TargetUserId.Should().Be(Guest);
        record.Detail.Should().BeNull();
    }

    [Fact]
    public void GuestRevoked_WithGarbage_IsKeptAsDetailNotParsed()
    {
        var record = Normalize(AuditEvents.GuestRevoked, Admin, "lixo");

        record.TargetUserId.Should().BeNull();
        record.Detail.Should().Be("lixo");
    }

    [Fact]
    public void InviteCreated_SplitsTheInviteFromThePermissions()
    {
        var invite = Guid.Parse("33333333-3333-7333-8333-333333333333");

        var record = Normalize(AuditEvents.GuestInviteCreated, Admin, $"{invite:N}|module:tv,tv:control");

        record.Target.Should().Be(invite.ToString("N"));
        record.Detail.Should().Be("module:tv,tv:control");
    }

    [Theory]
    [InlineData(AuditEvents.GuestInviteAccepted)]
    [InlineData(AuditEvents.GuestInviteRevoked)]
    [InlineData(AuditEvents.PasskeyRegistered)]
    [InlineData(AuditEvents.PasskeyRenamed)]
    [InlineData(AuditEvents.PasskeyRemoved)]
    [InlineData(AuditEvents.QrLoginApproved)]
    [InlineData(AuditEvents.QrLoginDenied)]
    [InlineData(AuditEvents.QrLoginSucceeded)]
    public void EventsAboutAnObject_UseItsIdAsTarget(string eventName)
    {
        var id = Guid.Parse("44444444-4444-7444-8444-444444444444");

        var record = Normalize(eventName, Admin, id.ToString("N"));

        record.Target.Should().Be(id.ToString("N"));
        record.Detail.Should().BeNull();
    }

    [Fact]
    public void StepUp_SuccessNamesTheConfirmedAction_AndFailureSplitsActionFromReason()
    {
        var ok = Normalize(AuditEvents.StepUpSucceeded, Admin, "permissions-change");
        var failed = Normalize(AuditEvents.StepUpFailed, Admin, "permissions-change|verification");
        var noAction = Normalize(AuditEvents.StepUpFailed, Admin, "credential");

        ok.Target.Should().Be("permissions-change");
        ok.Detail.Should().BeNull();
        failed.Target.Should().Be("permissions-change");
        failed.Detail.Should().Be("verification");
        noAction.Target.Should().BeNull();
        noAction.Detail.Should().Be("credential");
    }

    [Fact]
    public void ProfileUpdated_AndExport_KeepOnlyTheirCodes()
    {
        Normalize(AuditEvents.ProfileUpdated, Guest, "display-name").Detail.Should().Be("display-name");
        Normalize(AuditEvents.AuditExported, Admin, "rows=42").Detail.Should().Be("rows=42");
    }
}
