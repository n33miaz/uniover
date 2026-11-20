using AwesomeAssertions;
using UniOver.Modules.Tv.Features.Selection;

namespace UniOver.Modules.Tv.Tests.Selection;

/// <summary>A regra pura de quem vê o quê, para a conta que não é administradora.</summary>
public class MemberScopeTests
{
    [Theory]
    [InlineData(true, false, false)]
    [InlineData(true, true, false)]
    [InlineData(true, false, true)]
    [InlineData(true, true, true)]
    public void WithAMembership_SeesItsMemberships_WhateverTheMarks(bool member, bool optOut, bool followsDefault) =>
        TvSelectionService.Decide(member, optOut, followsDefault).Should().Be(MemberScope.Memberships);

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void RemovedFromItsLastTv_SeesNothing_EvenIfItFollowedTheDefaultTv(bool followsDefault) =>
        TvSelectionService.Decide(false, true, followsDefault).Should().Be(MemberScope.Nothing);

    [Fact]
    public void FollowerWithoutMembership_SeesTheDefaultTv() =>
        TvSelectionService.Decide(false, false, true).Should().Be(MemberScope.DefaultTv);

    [Fact]
    public void AccountThatDoesNotFollowTheDefaultTv_AndHasNoMembership_SeesNothing() =>
        TvSelectionService.Decide(false, false, false).Should().Be(MemberScope.Nothing);
}
