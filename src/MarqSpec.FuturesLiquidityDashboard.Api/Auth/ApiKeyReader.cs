using Microsoft.AspNetCore.Http;

namespace MarqSpec.FuturesLiquidityDashboard.Api.Auth;

/// <summary>
/// Where a caller may present a key (ARCHITECTURE.md D-16, D-30). The header is accepted on every route.
/// The query string and <c>Authorization: Bearer</c> are accepted only on <c>/hubs</c>, because that is how a
/// browser's SignalR client authenticates a WebSocket (it cannot set headers on the upgrade) and the negotiate
/// request that precedes it.
/// </summary>
public static class ApiKeyReader
{
    public const string BearerPrefix = "Bearer ";

    /// <summary>
    /// The raw key from this request, or null when the caller presented none. A query or bearer value on any
    /// other path is ignored, so a key left in a URL does not authenticate <c>/api</c>.
    /// </summary>
    public static string? PresentedKey(PathString path, string? apiKeyHeader, string? accessToken, string? authorization)
    {
        if (!string.IsNullOrWhiteSpace(apiKeyHeader))
        {
            return apiKeyHeader.Trim();
        }

        // A segment, not a string prefix: /hubsx and /hubsfoo are not the hub.
        if (!path.StartsWithSegments("/hubs", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        if (!string.IsNullOrWhiteSpace(accessToken))
        {
            return accessToken.Trim();
        }

        if (string.IsNullOrEmpty(authorization) || !authorization.StartsWith(BearerPrefix, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var token = authorization[BearerPrefix.Length..].Trim();
        return token.Length == 0 ? null : token;
    }
}
