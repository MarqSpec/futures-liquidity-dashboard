namespace MarqSpec.FuturesLiquidityDashboard.Api.Auth;

/// <summary>
/// Sign-in through an OpenID Connect provider (ARCHITECTURE.md D-77). Off by default, so local and demo runs keep the
/// API keys and Development's anonymous grants. When on, the API accepts an access token the provider signed for this
/// client, and the browser signs in with the Authorization Code flow and PKCE. API keys keep working beside it, for
/// agents and the Android shell.
/// </summary>
public sealed class OidcOptions
{
    /// <summary>Off by default. Nothing below is read until this is true.</summary>
    public bool Enabled { get; set; }

    /// <summary>The issuer URL, exactly as the provider's discovery document gives it, for example a Keycloak realm URL.</summary>
    public string Authority { get; set; } = string.Empty;

    /// <summary>The public client the browser signs in as. It has no secret: the flow uses PKCE.</summary>
    public string ClientId { get; set; } = string.Empty;

    /// <summary>The audience an access token must carry. Empty means <see cref="ClientId"/>.</summary>
    public string Audience { get; set; } = string.Empty;

    /// <summary>The scopes the browser asks for. <c>openid</c> is always sent.</summary>
    public string Scope { get; set; } = "openid profile";

    /// <summary>
    /// The grants every signed-in user holds, in the same <c>permission:scope</c> form as an API key's. A valid token
    /// with no grants configured would only answer 403, so at least one is required when sign-in is on.
    /// </summary>
    public List<string> Grants { get; set; } = [];

    /// <summary>The audience to validate: <see cref="Audience"/>, or the client id when that is empty.</summary>
    public string EffectiveAudience => string.IsNullOrWhiteSpace(Audience) ? ClientId : Audience;

    /// <summary>Every problem with these settings, or none when they are usable. Disabled settings are never checked.</summary>
    public IReadOnlyList<string> Problems(bool isDevelopment)
    {
        if (!Enabled)
        {
            return [];
        }

        var problems = new List<string>();
        if (!Uri.TryCreate(Authority, UriKind.Absolute, out var authority))
        {
            problems.Add("Auth:Oidc:Authority must be an absolute URL.");
        }
        else if (authority.Scheme != Uri.UriSchemeHttps && !(isDevelopment && authority.IsLoopback && authority.Scheme == Uri.UriSchemeHttp))
        {
            problems.Add("Auth:Oidc:Authority must use https (http only on loopback in Development).");
        }
        else if (!string.IsNullOrEmpty(authority.Query) || !string.IsNullOrEmpty(authority.Fragment) || !string.IsNullOrEmpty(authority.UserInfo))
        {
            problems.Add("Auth:Oidc:Authority must not contain a query, a fragment or credentials.");
        }

        if (string.IsNullOrWhiteSpace(ClientId))
        {
            problems.Add("Auth:Oidc:ClientId is required when sign-in is on.");
        }

        if (Grants.Count == 0)
        {
            problems.Add("Auth:Oidc:Grants must contain at least one grant when sign-in is on.");
        }
        else if (!Grants.All(Permissions.IsValidGrant))
        {
            problems.Add("Every Auth:Oidc:Grants entry must be permission:scope.");
        }

        return problems;
    }
}
