using MarqSpec.FuturesLiquidityDashboard.Api.Auth;
using Microsoft.Extensions.Options;

namespace MarqSpec.FuturesLiquidityDashboard.Api.Endpoints;

/// <summary>
/// <c>GET /api/auth/config</c>, anonymous: how the browser signs in (ARCHITECTURE.md D-77; INTERFACES.md D.1).
/// It is read at run time, so one image serves every environment. It holds only what a public client already
/// publishes: the issuer, the client id and the scopes. No grant, key, hash or token is ever in it.
/// </summary>
public static class AuthConfigEndpoint
{
    public const string Path = "/api/auth/config";

    /// <summary>The answer. <see cref="Oidc"/> is null when sign-in is off, and the browser asks for an API key.</summary>
    public sealed record AuthConfig(OidcClientConfig? Oidc);

    /// <summary>What the browser needs to start the Authorization Code flow with PKCE.</summary>
    public sealed record OidcClientConfig(string Authority, string ClientId, string Scope);

    public static IEndpointRouteBuilder MapAuthConfig(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);
        app.MapGet(Path, (IOptions<AuthOptions> options) => For(options.Value.Oidc)).AllowAnonymous();
        return app;
    }

    /// <summary>The answer for these settings. <c>openid</c> is added to the scope when it is missing.</summary>
    public static AuthConfig For(OidcOptions oidc)
    {
        ArgumentNullException.ThrowIfNull(oidc);
        if (!oidc.Enabled)
        {
            return new AuthConfig(null);
        }

        var scopes = oidc.Scope.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();
        if (!scopes.Contains("openid", StringComparer.Ordinal))
        {
            scopes.Insert(0, "openid");
        }

        return new AuthConfig(new OidcClientConfig(oidc.Authority, oidc.ClientId, string.Join(' ', scopes)));
    }
}
