using MarqSpec.FuturesLiquidityDashboard.Api.Auth;
using Microsoft.AspNetCore.Http;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Auth;

// reference: ARCHITECTURE.md D-77, D-30
public sealed class CredentialRouterTests
{
    // Synthetic: a JWT's shape (header {"alg":"none"}), not a real token.
    private const string Jwt = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJkZW1vIn0.c2lnbmF0dXJl";
    private const string Key = "synthetic-viewer-key";

    private static string Scheme(bool oidc, string path, string? header = null, string? query = null, string? authorization = null) =>
        CredentialRouter.SchemeFor(oidc, new PathString(path), header, query, authorization);

    [Fact]
    public void SchemeFor_ShouldPickTheKeyScheme_WhenSignInIsOff()
    {
        Scheme(oidc: false, "/api/instruments", authorization: $"Bearer {Jwt}").Should().Be(ApiKeyAuthenticationHandler.SchemeName);
    }

    [Fact]
    public void SchemeFor_ShouldPickTheTokenScheme_WhenTheBearerIsAJwt()
    {
        Scheme(oidc: true, "/api/instruments", authorization: $"Bearer {Jwt}").Should().Be(CredentialRouter.OidcSchemeName);
    }

    [Fact]
    public void SchemeFor_ShouldPickTheKeyScheme_WhenTheApiKeyHeaderIsSent()
    {
        Scheme(oidc: true, "/api/instruments", header: Key, authorization: $"Bearer {Jwt}").Should().Be(ApiKeyAuthenticationHandler.SchemeName);
    }

    [Fact]
    public void SchemeFor_ShouldPickTheKeyScheme_WhenTheHubBearerIsAKey()
    {
        Scheme(oidc: true, "/hubs/market/negotiate", authorization: $"Bearer {Key}").Should().Be(ApiKeyAuthenticationHandler.SchemeName);
    }

    [Fact]
    public void SchemeFor_ShouldPickTheTokenScheme_WhenTheHubQueryIsAJwt()
    {
        Scheme(oidc: true, "/hubs/market", query: Jwt).Should().Be(CredentialRouter.OidcSchemeName);
    }

    [Theory]
    [InlineData("/api/instruments")]
    [InlineData("/hubsx")]
    public void SchemeFor_ShouldIgnoreTheQueryToken_WhenThePathIsNotTheHub(string path)
    {
        Scheme(oidc: true, path, query: Jwt).Should().Be(ApiKeyAuthenticationHandler.SchemeName);
    }

    [Fact]
    public void SchemeFor_ShouldPickTheKeyScheme_WhenNoCredentialIsSent()
    {
        Scheme(oidc: true, "/api/instruments").Should().Be(ApiKeyAuthenticationHandler.SchemeName);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData(Key)]
    [InlineData("a.b.c")]
    [InlineData("eyJh..c2ln")]
    [InlineData("eyJhbGciOiJub25lIn0.eyJzdWIiOiJkZW1vIn0")]
    [InlineData("eyJhbGciOiJub25lIn0.eyJzdWIi+ZW1vIn0.c2ln")]
    public void LooksLikeJwt_ShouldBeFalse_WhenTheValueIsNotThreeBase64UrlSegments(string? value)
    {
        CredentialRouter.LooksLikeJwt(value).Should().BeFalse();
    }

    [Fact]
    public void LooksLikeJwt_ShouldBeTrue_WhenTheValueIsACompactJwt()
    {
        CredentialRouter.LooksLikeJwt(Jwt).Should().BeTrue();
    }

    [Fact]
    public void HubQueryToken_ShouldBeNull_WhenThePathIsNotTheHub()
    {
        CredentialRouter.HubQueryToken(new PathString("/api/instruments"), Jwt).Should().BeNull();
        CredentialRouter.HubQueryToken(new PathString("/hubs/market"), Jwt).Should().Be(Jwt);
    }
}
