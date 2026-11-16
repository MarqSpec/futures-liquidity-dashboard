using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;

namespace MarqSpec.FuturesLiquidityDashboard.Api.Auth;

/// <summary>
/// Authenticates an <c>X-Api-Key</c> header. On <c>/hubs</c> only, also the <c>access_token</c> query value
/// (browsers cannot set headers on a WebSocket) and <c>Authorization: Bearer</c> (SignalR sends that on negotiate).
/// Keys are compared by SHA-256 in constant time. The key itself is never written to a log.
/// </summary>
public sealed class ApiKeyAuthenticationHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> schemeOptions,
    IOptionsMonitor<AuthOptions> authOptions,
    ILoggerFactory logger,
    UrlEncoder encoder) : AuthenticationHandler<AuthenticationSchemeOptions>(schemeOptions, logger, encoder)
{
    public const string SchemeName = "ApiKey";
    public const string Header = "X-Api-Key";

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var options = authOptions.CurrentValue;
        var key = ApiKeyReader.PresentedKey(
            Request.Path,
            Request.Headers[Header].FirstOrDefault(),
            Request.Query["access_token"].FirstOrDefault(),
            Request.Headers.Authorization.ToString());

        if (!string.IsNullOrEmpty(key))
        {
            var hash = SHA256.HashData(Encoding.UTF8.GetBytes(key));
            foreach (var entry in options.Keys)
            {
                if (TryHex(entry.KeySha256, out var expected) && CryptographicOperations.FixedTimeEquals(hash, expected))
                {
                    return Task.FromResult(Success(entry.Name, entry.Grants));
                }
            }

            return Task.FromResult(AuthenticateResult.Fail("Unknown API key."));
        }

        return Task.FromResult(options.AnonymousGrants.Count > 0
            ? Success("local-viewer", options.AnonymousGrants)
            : AuthenticateResult.NoResult());
    }

    /// <summary>Lower-case hex SHA-256 of a key: what an operator puts in <c>Auth:Keys:n:KeySha256</c>.</summary>
    public static string HashKey(string key)
    {
        ArgumentNullException.ThrowIfNull(key);
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(key)));
    }

    private static AuthenticateResult Success(string name, IEnumerable<string> grants)
    {
        var claims = new List<Claim> { new(ClaimTypes.Name, name) };
        claims.AddRange(grants.Where(Permissions.IsValidGrant).Select(g => new Claim(Permissions.ClaimType, g)));
        var principal = new ClaimsPrincipal(new ClaimsIdentity(claims, SchemeName));
        return AuthenticateResult.Success(new AuthenticationTicket(principal, SchemeName));
    }

    private static bool TryHex(string value, out byte[] bytes)
    {
        bytes = [];
        if (string.IsNullOrWhiteSpace(value) || value.Length != 64)
        {
            return false;
        }

        try
        {
            bytes = Convert.FromHexString(value);
            return true;
        }
        catch (FormatException)
        {
            return false;
        }
    }
}
