using AwesomeAssertions;
using UniOver.SharedKernel.Diagnostics;

namespace UniOver.Modules.Devices.Tests.Logging;

public sealed class ErrorDetailTests
{
    private static InvalidOperationException Thrown(string message, Exception? inner = null)
    {
        try
        {
            throw new InvalidOperationException(message, inner);
        }
        catch (InvalidOperationException ex)
        {
            return ex;
        }
    }

    [Fact]
    public void KeepsTheTypeAndTheStack_ButNeverTheMessage()
    {
        var error = Thrown("Host=ep-segredo.neon.tech;Password=senha-do-banco");

        var text = ErrorDetail.Stack(error);

        text.Should().StartWith(nameof(InvalidOperationException));
        text.Should().Contain(nameof(Thrown), "a pilha nomeia o método que lançou");
        text.Should().NotContain("ep-segredo").And.NotContain("senha-do-banco");
    }

    [Fact]
    public void ListsTheInnerErrorTypes_WithoutTheirMessages()
    {
        var error = Thrown("externa-secreta", new TimeoutException("interna-secreta"));

        var text = ErrorDetail.Stack(error);

        text.Should().Contain("InvalidOperationException <- TimeoutException");
        text.Should().NotContain("externa-secreta").And.NotContain("interna-secreta");
    }

    [Fact]
    public void ABareException_WithoutAStack_IsJustTheType()
    {
        ErrorDetail.Stack(new TimeoutException("segredo")).Should().Be(nameof(TimeoutException));
    }

    [Fact]
    public void IsOneLine_AndHasATotalCap()
    {
        var text = ErrorDetail.Stack(Deep(60));

        text.Should().NotContain("\n").And.NotContain("\r");
        text.Length.Should().BeLessThanOrEqualTo(ErrorDetail.MaxLength + 1);
        text.Should().EndWith("…");
    }

    private static InvalidOperationException Deep(int depth)
    {
        try
        {
            Recurse(depth);
        }
        catch (InvalidOperationException ex)
        {
            return ex;
        }

        throw new InvalidOperationException("inalcançável");
    }

    private static void Recurse(int depth)
    {
        if (depth == 0)
        {
            throw new InvalidOperationException("fundo");
        }

        Recurse(depth - 1);
    }
}
