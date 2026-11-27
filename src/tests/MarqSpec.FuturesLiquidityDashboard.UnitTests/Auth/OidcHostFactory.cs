using System.Security.Claims;
using System.Security.Cryptography;
using MarqSpec.FuturesLiquidityDashboard.Api.Auth;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Protocols;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;
using Microsoft.IdentityModel.Tokens;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Auth;

// reference: ARCHITECTURE.md D-77
// A host-booting unit test (engineering-standards.md §8.1): what it guards exists only in the composition, namely that
// AddDashboardAuth routes a JWT to the token scheme and that scheme trusts only the configured issuer, audience and keys.
// No provider is called: the discovery document is a static one holding a key generated per run, so every token is synthetic.

/// <summary>
/// Production, sign-in on with view-dashboard:MES for every signed-in user, and one synthetic viewer key. An override of
/// null removes that setting.
/// </summary>
internal sealed class OidcHostFactory(Dictionary<string, string?>? overrides = null) : WebApplicationFactory<Program>
{
    public const string Issuer = "https://idp.example/realms/demo";
    public const string ClientId = "futures-liquidity-dashboard";
    public const string ViewerKey = "synthetic-oidc-host-viewer-key";

    private readonly RsaSecurityKey _signingKey = new(RSA.Create(2048)) { KeyId = "synthetic-signing-key" };

    private readonly Dictionary<string, string?> _settings = new()
    {
        ["Feed:Provider"] = "Synthetic",
        ["Feed:MinHistoryHours"] = "0.1",
        ["Feed:WarmRegimes"] = "false",
        ["Feed:Synthetic:StepMs"] = "50",
        ["Engine:Instruments:0"] = "MES",
        ["Agent:Enabled"] = "false",
        ["Feedback:Enabled"] = "false",
        ["Feedback:BudgetStorePath"] = string.Empty,
        ["Layouts:StorePath"] = string.Empty,
        ["Auth:Keys:0:Name"] = "oidc-host-viewer",
        ["Auth:Keys:0:KeySha256"] = ApiKeyAuthenticationHandler.HashKey(ViewerKey),
        ["Auth:Keys:0:Grants:0"] = "view-dashboard:MES",
        ["Auth:Oidc:Enabled"] = "true",
        ["Auth:Oidc:Authority"] = Issuer,
        ["Auth:Oidc:ClientId"] = ClientId,
        ["Auth:Oidc:Grants:0"] = "view-dashboard:MES",
    };

    /// <summary>A token as the provider would sign it. Each argument changes one thing a validator must check.</summary>
    public string Token(
        string issuer = Issuer,
        string audience = ClientId,
        TimeSpan? lifetime = null,
        SecurityKey? signedWith = null,
        string userName = "demo-viewer")
    {
        var now = DateTime.UtcNow;
        var expires = now + (lifetime ?? TimeSpan.FromMinutes(5));
        var descriptor = new SecurityTokenDescriptor
        {
            Issuer = issuer,
            Audience = audience,
            IssuedAt = expires < now ? expires.AddMinutes(-5) : now,
            NotBefore = expires < now ? expires.AddMinutes(-5) : now,
            Expires = expires,
            Subject = new ClaimsIdentity([new Claim("sub", "synthetic-subject"), new Claim("preferred_username", userName)]),
            SigningCredentials = new SigningCredentials(signedWith ?? _signingKey, SecurityAlgorithms.RsaSha256),
        };
        return new JsonWebTokenHandler().CreateToken(descriptor);
    }

    public HttpClient Bearer(string token)
    {
        var client = CreateClient();
        client.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        return client;
    }

    public HttpClient Viewer()
    {
        var client = CreateClient();
        client.DefaultRequestHeaders.Add(ApiKeyAuthenticationHandler.Header, ViewerKey);
        return client;
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.UseEnvironment("Production");
        // An override of null leaves the setting out altogether, rather than setting it empty.
        var settings = new Dictionary<string, string?>(_settings);
        foreach (var (key, value) in overrides ?? [])
        {
            settings[key] = value;
        }

        foreach (var (key, value) in settings.Where(s => s.Value is not null))
        {
            builder.UseSetting(key, value);
        }

        builder.ConfigureTestServices(services =>
            services.PostConfigure<JwtBearerOptions>(CredentialRouter.OidcSchemeName, jwt =>
            {
                var discovery = new OpenIdConnectConfiguration { Issuer = Issuer };
                discovery.SigningKeys.Add(_signingKey);
                jwt.Configuration = discovery;
                jwt.ConfigurationManager = new StaticConfigurationManager<OpenIdConnectConfiguration>(discovery);
            }));
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _signingKey.Rsa?.Dispose();
        }

        base.Dispose(disposing);
    }
}
