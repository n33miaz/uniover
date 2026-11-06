using AwesomeAssertions;

namespace UniOver.Modules.Tv.Tests.Validation;

public class CommandWaitOptionsTests
{
    [Fact]
    public void TheReopeningWait_CoversTheAgentsLongestLegitimateOpening()
    {
        // O agente se dá até 20 s para abrir a sessão (`tv_session_warm_timeout_seconds`): a API espera mais que isso.
        var options = new TvModuleOptions();

        options.HibernatingTimeoutSeconds.Should().BeGreaterThan(20);
        options.HibernatingTimeout.Should().BeGreaterThan(options.CommandTimeout);
        TvModuleOptions.IsValid(options).Should().BeTrue();
    }

    [Fact]
    public void ThePowerOffWait_CannotBeShorterThanTheReopeningWait()
    {
        // O desligar também abre a sessão: se esperasse menos que a abertura, daria 504 com a tecla já enviada.
        TvModuleOptions.IsValid(new TvModuleOptions { HibernatingTimeoutSeconds = 40, PowerOffTimeoutSeconds = 30 })
            .Should().BeFalse();
        TvModuleOptions.IsValid(new TvModuleOptions { HibernatingTimeoutSeconds = 30, PowerOffTimeoutSeconds = 30 })
            .Should().BeTrue();
    }

    [Fact]
    public void TheReopeningWait_CannotBeShorterThanTheOpenSessionWait()
    {
        TvModuleOptions.IsValid(new TvModuleOptions { CommandTimeoutSeconds = 20, HibernatingTimeoutSeconds = 10 })
            .Should().BeFalse();
    }
}
