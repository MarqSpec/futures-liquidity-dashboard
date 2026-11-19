using System.Security.Claims;
using MarqSpec.FuturesLiquidityDashboard.Api.Auth;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Auth;

// reference: REQUIREMENTS.md §2 (request-feedback), FR-6
public sealed class PermissionsTests
{
    [Theory]
    [InlineData("request-feedback:*")]
    [InlineData("request-feedback:MES")]
    public void IsValidGrant_ShouldAcceptRequestFeedback_WhenItHasAScope(string grant)
    {
        Permissions.IsValidGrant(grant).Should().BeTrue();
    }

    [Theory]
    [InlineData("request-feedback")]
    [InlineData("request-feedbacks:*")]
    [InlineData("Request-Feedback:*")]
    public void IsValidGrant_ShouldRefuse_WhenTheGrantOnlyResemblesRequestFeedback(string grant)
    {
        Permissions.IsValidGrant(grant).Should().BeFalse();
    }

    [Fact]
    public void Has_ShouldGrantNothingElse_WhenTheCallerHoldsOnlyRequestFeedback()
    {
        var user = new ClaimsPrincipal(new ClaimsIdentity([new Claim(Permissions.ClaimType, "request-feedback:*")], "test"));
        var root = InstrumentCatalog.MES.Root;

        Permissions.All.Where(p => p != Permissions.RequestFeedback).Should().OnlyContain(p => !Permissions.Has(user, p, root));
        Permissions.Has(user, Permissions.RequestFeedback, root).Should().BeTrue();
    }
}
