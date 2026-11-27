using Microsoft.AspNetCore.Http;

namespace MarqSpec.FuturesLiquidityDashboard.Api.Auth;

/// <summary>
/// Picks the scheme that reads this request's credential (ARCHITECTURE.md D-77). An <c>X-Api-Key</c> header is always
/// a key. With sign-in on, a bearer value shaped like a signed JWT goes to the token scheme: from the
/// <c>Authorization</c> header on any route, or from the <c>access_token</c> query on <c>/hubs</c> only, as D-30 allows
/// for keys. Everything else stays with the key scheme, so a key on the hub still works.
/// </summary>
public static class CredentialRouter
{
    /// <summary>The policy scheme every request authenticates through; it forwards to one of the two below.</summary>
    public const string SchemeName = "Dashboard";

    /// <summary>The access-token scheme, registered only when sign-in is on.</summary>
    public const string OidcSchemeName = "Oidc";

    /// <summary>The scheme for this request's credential.</summary>
    public static string SchemeFor(bool oidcEnabled, PathString path, string? apiKeyHeader, string? accessToken, string? authorization)
    {
        if (!oidcEnabled || !string.IsNullOrWhiteSpace(apiKeyHeader))
        {
            return ApiKeyAuthenticationHandler.SchemeName;
        }

        return LooksLikeJwt(BearerToken(authorization)) || (IsHub(path) && LooksLikeJwt(accessToken))
            ? OidcSchemeName
            : ApiKeyAuthenticationHandler.SchemeName;
    }

    /// <summary>The hub's query token, which the token scheme reads only on <c>/hubs</c>, as the key scheme does.</summary>
    public static string? HubQueryToken(PathString path, string? accessToken) =>
        IsHub(path) && !string.IsNullOrWhiteSpace(accessToken) ? accessToken.Trim() : null;

    /// <summary>
    /// True for three non-empty base64url segments whose header starts with <c>{"</c>: a signed compact JWT. An API
    /// key is an opaque string, so this keeps keys and tokens apart without decoding either.
    /// </summary>
    public static bool LooksLikeJwt(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return false;
        }

        var parts = value.Trim().Split('.');
        return parts.Length == 3
            && parts.All(p => p.Length > 0 && p.All(IsBase64Url))
            && parts[0].StartsWith("eyJ", StringComparison.Ordinal);
    }

    private static string? BearerToken(string? authorization)
    {
        if (string.IsNullOrEmpty(authorization) || !authorization.StartsWith(ApiKeyReader.BearerPrefix, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        return authorization[ApiKeyReader.BearerPrefix.Length..].Trim();
    }

    // A segment, not a string prefix: /hubsx is not the hub (D-30).
    private static bool IsHub(PathString path) => path.StartsWithSegments("/hubs", StringComparison.OrdinalIgnoreCase);

    private static bool IsBase64Url(char c) => char.IsAsciiLetterOrDigit(c) || c is '-' or '_';
}
