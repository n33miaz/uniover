using AwesomeAssertions;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Domain;

namespace UniOver.Modules.Identity.Tests.Domain;

public class AccessPermissionsTests
{
    [Fact]
    public void TheCatalogIsClosedAndStable_TheseExactIdentifiersAreStoredInTheDatabase()
    {
        AccessPermissions.All.Should().Equal(
            "module:tv", "tv:control", "tv:power", "tv:launch", "tv:edit-shortcuts", "tv:history", "module:training");
        AccessPermissions.Modules.Should().Equal("module:tv", "module:training");
        AccessPermissions.All.Should().OnlyHaveUniqueItems();
    }

    [Theory]
    [InlineData("module:tv", true)]
    [InlineData("tv:control", true)]
    [InlineData("TV:CONTROL", false)]
    [InlineData(" tv:control", false)]
    [InlineData("tv:control ", false)]
    [InlineData("tv:*", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void IsKnown_IsAnExactOrdinalMatch(string? permission, bool expected) =>
        AccessPermissions.IsKnown(permission).Should().Be(expected);

    [Fact]
    public void EveryTvActionDependsOnTheTvModule_AndTheModulesDependOnNothing()
    {
        foreach (var permission in AccessPermissions.All.Where(p => p.StartsWith("tv:", StringComparison.Ordinal)))
        {
            AccessPermissions.RequiredModule(permission).Should().Be(AccessPermissions.TvModule, permission);
        }

        foreach (var module in AccessPermissions.Modules)
        {
            AccessPermissions.RequiredModule(module).Should().BeNull(module);
        }
    }

    [Fact]
    public void Policy_NamesOnePerPermission_AndRefusesAnUnknownOne()
    {
        AccessPermissions.Policy("tv:control").Should().Be("permission:tv:control");
        AccessPermissions.All.Select(AccessPermissions.Policy).Should().OnlyHaveUniqueItems();

        var act = () => AccessPermissions.Policy("nao-existe");

        act.Should().Throw<ArgumentException>();
    }

    [Fact]
    public void RequirePermission_IncludesTheRoleAndActiveAccountRequirements_AndRefusesAnUnknownPermissionAtMappingTime()
    {
        var policy = new Microsoft.AspNetCore.Authorization.AuthorizationPolicyBuilder().RequirePermission("tv:control").Build();

        policy.Requirements.OfType<PermissionRequirement>().Single().Permission.Should().Be("tv:control");
        policy.Requirements.OfType<AccountRoleRequirement>().Single().Roles.Should().BeEquivalentTo(["owner", "guest"]);
        policy.Requirements.OfType<ActiveAccountRequirement>().Should().ContainSingle();

        var act = () => new Microsoft.AspNetCore.Authorization.AuthorizationPolicyBuilder().RequirePermission("nao-existe");

        act.Should().Throw<ArgumentException>();
    }
}

public class PermissionRulesTests
{
    [Fact]
    public void TheTvControlModel_IsExactlyWhatTheExistingGuestHasToday()
    {
        // Hoje a convidada usa a TV inteira (teclas, texto, acordar, apps, desligar, histórico dela) e NÃO edita atalhos.
        // A migration repete esta lista à mão; um teste de integração compara com o banco.
        PermissionRules.TvControlOnly.Should().Equal("module:tv", "tv:control", "tv:power", "tv:launch", "tv:history");
        PermissionRules.TvControlOnly.Should().NotContain(AccessPermissions.TvEditShortcuts);
        PermissionRules.TrainingOnly.Should().Equal("module:training");
        PermissionRules.Validate(PermissionRules.TvControlOnly.ToArray()).IsValid.Should().BeTrue();
        PermissionRules.Validate(PermissionRules.TrainingOnly.ToArray()).IsValid.Should().BeTrue();
    }

    [Fact]
    public void Validate_AcceptsAModuleAlone_AndNormalizesToCatalogOrderWithoutRepeats()
    {
        PermissionRules.Validate(["module:tv"]).Permissions.Should().Equal("module:tv");

        var result = PermissionRules.Validate(["tv:history", "module:training", "tv:control", "module:tv", "tv:history"]);

        result.IsValid.Should().BeTrue();
        result.Permissions.Should().Equal("module:tv", "tv:control", "tv:history", "module:training");
    }

    [Fact]
    public void Validate_RejectsAMissingList_AndAnEmptyOne_BecauseThereIsNoModule()
    {
        PermissionRules.Validate(null).Errors.Should().Equal(PermissionRules.ErrorRequired);
        PermissionRules.Validate([]).Errors.Should().Equal(PermissionRules.ErrorNoModule);
    }

    [Theory]
    [InlineData("tv:control")]
    [InlineData("tv:power", "module:training")]
    [InlineData("tv:edit-shortcuts", "tv:history")]
    public void Validate_RejectsAnActionWithoutItsModule(params string[] requested)
    {
        var result = PermissionRules.Validate(requested);

        result.IsValid.Should().BeFalse();
        result.Permissions.Should().BeEmpty();
        result.Errors.Should().Contain(PermissionRules.ErrorMissingModule);
    }

    [Theory]
    [InlineData("module:tv", "nao-existe")]
    [InlineData("module:tv", "TV:CONTROL")]
    [InlineData("module:tv", " tv:control")]
    [InlineData("module:tv", "")]
    [InlineData("module:tv", null)]
    public void Validate_RejectsAnUnknownOrMalformedItem_WithoutEchoingIt(string module, string? item)
    {
        var result = PermissionRules.Validate([module, item]);

        result.IsValid.Should().BeFalse();
        result.Errors.Should().Contain(PermissionRules.ErrorUnknown);
        string.Join('|', result.Errors).Should().NotContain("nao-existe");
    }

    [Fact]
    public void Validate_RejectsAnAbsurdlyLongList_BeforeLookingAtTheItems()
    {
        var list = Enumerable.Repeat("module:tv", PermissionRules.MaxRequestedItems + 1).ToArray();

        PermissionRules.Validate(list).Errors.Should().Equal(PermissionRules.ErrorTooMany);
        PermissionRules.Validate(list[..PermissionRules.MaxRequestedItems]).IsValid.Should().BeTrue();
    }

    [Fact]
    public void Effective_KeepsOnlyTheCatalog_AndDropsActionsWhoseModuleIsMissing()
    {
        // Uma linha editada à mão no banco não concede uma ação sem o módulo dela, nem uma permissão que não existe.
        PermissionRules.Effective(["tv:control", "tv:power"]).Should().BeEmpty();
        PermissionRules.Effective(["module:tv", "tv:control", "inventada", "tv:history"])
            .Should().Equal("module:tv", "tv:control", "tv:history");
        PermissionRules.Effective(["module:training", "tv:launch"]).Should().Equal("module:training");
        PermissionRules.Effective([]).Should().BeEmpty();
    }
}
