using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using MarqSpec.FuturesLiquidityDashboard.Api.Endpoints;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Auth;

// reference: ARCHITECTURE.md D-77; ARCHITECTURE.md T-4
public sealed class OidcTokenValidationTests : IDisposable
{
    private static readonly Uri Instruments = new("/api/instruments", UriKind.Relative);
    private readonly OidcHostFactory _factory = new();

    public void Dispose() => _factory.Dispose();

    [Fact]
    public async Task Instruments_ShouldAnswerOk_WhenTheTokenIsValid()
    {
        using var client = _factory.Bearer(_factory.Token());

        using var response = await client.GetAsync(Instruments);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var rows = await response.Content.ReadFromJsonAsync<JsonElement>();
        rows.GetArrayLength().Should().Be(1, "the configured grant is view-dashboard:MES");
    }

    [Fact]
    public async Task Instruments_ShouldBeUnauthorized_WhenTheAudienceIsAnotherClient()
    {
        using var client = _factory.Bearer(_factory.Token(audience: "another-client"));

        using var response = await client.GetAsync(Instruments);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Instruments_ShouldBeUnauthorized_WhenTheIssuerIsAnotherRealm()
    {
        using var client = _factory.Bearer(_factory.Token(issuer: "https://idp.example/realms/other"));

        using var response = await client.GetAsync(Instruments);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Instruments_ShouldBeUnauthorized_WhenTheTokenHasExpired()
    {
        using var client = _factory.Bearer(_factory.Token(lifetime: TimeSpan.FromMinutes(-10)));

        using var response = await client.GetAsync(Instruments);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Instruments_ShouldBeUnauthorized_WhenAnotherKeySignedTheToken()
    {
        using var rsa = RSA.Create(2048);
        using var client = _factory.Bearer(_factory.Token(signedWith: new RsaSecurityKey(rsa) { KeyId = "synthetic-signing-key" }));

        using var response = await client.GetAsync(Instruments);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Instruments_ShouldAnswerOk_WhenAnApiKeyIsSentWithSignInOn()
    {
        using var client = _factory.Viewer();

        using var response = await client.GetAsync(Instruments);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Negotiate_ShouldAnswerOk_WhenTheHubQueryCarriesAValidToken()
    {
        using var client = _factory.CreateClient();

        using var response = await client.PostAsync(
            new Uri($"/hubs/market/negotiate?negotiateVersion=1&access_token={_factory.Token()}", UriKind.Relative), content: null);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Instruments_ShouldIgnoreTheQueryToken_WhenThePathIsNotTheHub()
    {
        using var client = _factory.CreateClient();

        using var response = await client.GetAsync(new Uri($"/api/instruments?access_token={_factory.Token()}", UriKind.Relative));

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task AuthConfig_ShouldNameTheIssuerAndClient_WithoutACredential()
    {
        using var client = _factory.CreateClient();

        var config = await client.GetFromJsonAsync<JsonElement>(new Uri(AuthConfigEndpoint.Path, UriKind.Relative));

        var oidc = config.GetProperty("oidc");
        oidc.GetProperty("authority").GetString().Should().Be(OidcHostFactory.Issuer);
        oidc.GetProperty("clientId").GetString().Should().Be(OidcHostFactory.ClientId);
        oidc.GetProperty("scope").GetString().Should().Be("openid profile");
        config.GetRawText().Should().NotContain("view-dashboard", "grants are the server's, never the browser's");
    }

    [Fact]
    public void Startup_ShouldFail_WhenSignInIsOnWithNoGrants()
    {
        using var factory = new OidcHostFactory(new() { ["Auth:Oidc:Grants:0"] = null });

        var start = () => factory.CreateClient();

        start.Should().Throw<OptionsValidationException>().WithMessage("*Auth:Oidc*");
    }

    [Fact]
    public void Startup_ShouldSucceed_WhenSignInIsTheOnlyCredentialOutsideDevelopment()
    {
        using var factory = new OidcHostFactory(new() { ["Auth:Keys:0:Name"] = null, ["Auth:Keys:0:KeySha256"] = null, ["Auth:Keys:0:Grants:0"] = null });

        var start = () => factory.CreateClient().Dispose();

        start.Should().NotThrow();
    }
}
