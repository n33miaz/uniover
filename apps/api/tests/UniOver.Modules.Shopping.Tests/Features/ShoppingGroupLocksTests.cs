using AwesomeAssertions;
using UniOver.Modules.Shopping.Features;

namespace UniOver.Modules.Shopping.Tests.Features;

public sealed class ShoppingGroupLocksTests
{
    [Fact]
    public void TheOrder_IsTheSameWhateverTheOrderGiven_WithoutRepeats()
    {
        var a = Guid.CreateVersion7();
        var b = Guid.CreateVersion7();
        var c = Guid.CreateVersion7();

        var expected = ShoppingGroupLocks.InOrder([a, b, c]);

        ShoppingGroupLocks.InOrder([c, a, b]).Should().Equal(expected);
        ShoppingGroupLocks.InOrder([b, c, a, a, b]).Should().Equal(expected);
        ShoppingGroupLocks.InOrder([a, a]).Should().Equal(a);
    }
}
