using MarqSpec.FuturesLiquidityDashboard.Api.Auth;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Auth;

// reference: ARCHITECTURE.md D-30
public sealed class AuthOptionsTests
{
    [Fact]
    public void RequiresKeyForDiagnostics_ShouldProtectOutsideDevelopment_WhenUnset()
    {
        var options = new AuthOptions();

        options.RequiresKeyForDiagnostics(isDevelopment: false).Should().BeTrue();
    }

    [Fact]
    public void RequiresKeyForDiagnostics_ShouldStayOpenInDevelopment_WhenUnset()
    {
        var options = new AuthOptions();

        options.RequiresKeyForDiagnostics(isDevelopment: true).Should().BeFalse();
    }

    [Fact]
    public void RequiresKeyForDiagnostics_ShouldFollowTheSetting_WhenItIsSet()
    {
        new AuthOptions { ProtectDiagnostics = false }.RequiresKeyForDiagnostics(isDevelopment: false).Should().BeFalse();
        new AuthOptions { ProtectDiagnostics = true }.RequiresKeyForDiagnostics(isDevelopment: true).Should().BeTrue();
    }
}
