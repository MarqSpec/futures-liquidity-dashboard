using MarqSpec.FuturesLiquidityDashboard.Api.Auth;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Auth;

// reference: ARCHITECTURE.md D-77
public sealed class OidcOptionsTests
{
    private static OidcOptions Valid() => new()
    {
        Enabled = true,
        Authority = "https://idp.example/realms/demo",
        ClientId = "futures-liquidity-dashboard",
        Grants = ["view-dashboard:*"],
    };

    [Fact]
    public void Problems_ShouldBeEmpty_WhenSignInIsOff()
    {
        new OidcOptions().Problems(isDevelopment: false).Should().BeEmpty();
    }

    [Fact]
    public void Problems_ShouldBeEmpty_WhenEverySettingIsUsable()
    {
        Valid().Problems(isDevelopment: false).Should().BeEmpty();
    }

    [Theory]
    [InlineData("")]
    [InlineData("not a url")]
    [InlineData("http://idp.example/realms/demo")]
    [InlineData("https://idp.example/realms/demo?x=1")]
    [InlineData("https://user:pass@idp.example/realms/demo")]
    public void Problems_ShouldNameTheAuthority_WhenItIsNotAPlainHttpsUrl(string authority)
    {
        var options = Valid();
        options.Authority = authority;

        options.Problems(isDevelopment: false).Should().ContainSingle().Which.Should().Contain("Authority");
    }

    [Fact]
    public void Problems_ShouldAllowLoopbackHttp_WhenInDevelopment()
    {
        var options = Valid();
        options.Authority = "http://localhost:8180/realms/demo";

        options.Problems(isDevelopment: true).Should().BeEmpty();
        options.Problems(isDevelopment: false).Should().ContainSingle();
    }

    [Fact]
    public void Problems_ShouldNameTheClientId_WhenItIsMissing()
    {
        var options = Valid();
        options.ClientId = " ";

        options.Problems(isDevelopment: false).Should().ContainSingle().Which.Should().Contain("ClientId");
    }

    [Fact]
    public void Problems_ShouldNameTheGrants_WhenNoneAreConfigured()
    {
        var options = Valid();
        options.Grants = [];

        options.Problems(isDevelopment: false).Should().ContainSingle().Which.Should().Contain("Grants");
    }

    [Fact]
    public void Problems_ShouldNameTheGrants_WhenOneIsNotPermissionAndScope()
    {
        var options = Valid();
        options.Grants = ["view-dashboard:*", "trade:*"];

        options.Problems(isDevelopment: false).Should().ContainSingle().Which.Should().Contain("Grants");
    }

    [Fact]
    public void EffectiveAudience_ShouldBeTheClientId_WhenNoAudienceIsSet()
    {
        Valid().EffectiveAudience.Should().Be("futures-liquidity-dashboard");
    }

    [Fact]
    public void EffectiveAudience_ShouldBeTheAudience_WhenOneIsSet()
    {
        var options = Valid();
        options.Audience = "dashboard-api";

        options.EffectiveAudience.Should().Be("dashboard-api");
    }
}
