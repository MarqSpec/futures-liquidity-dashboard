using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.Extensions.Options;

namespace MarqSpec.FuturesLiquidityDashboard.Api.Auth;

/// <summary>Viewer and agent access: API keys (D-16), and sign-in through an OpenID Connect provider when on (D-77).</summary>
public static class AuthServiceCollectionExtensions
{
    /// <summary>The claim a signed-in user's name is read from: <c>Identity.Name</c>, which keys layouts and the journal.</summary>
    public const string ViewerNameClaim = "fld_viewer";

    /// <summary>The prefix on a signed-in user's name, so it can never equal an API key's <c>Name</c> and share its saved layout.</summary>
    public const string ViewerNamePrefix = "oidc:";

    /// <summary>
    /// Binds and validates <c>Auth</c>, then registers one policy scheme that forwards each request to the key scheme
    /// or, with <c>Auth:Oidc:Enabled</c>, to a JWT bearer scheme that trusts only <c>Auth:Oidc:Authority</c>.
    /// </summary>
    public static IServiceCollection AddDashboardAuth(this IServiceCollection services, IConfiguration configuration, IHostEnvironment environment)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentNullException.ThrowIfNull(environment);
        var isDevelopment = environment.IsDevelopment();

        services.AddOptions<AuthOptions>()
            .Bind(configuration.GetSection(AuthOptions.Section))
            .Validate(o => o.Keys.All(k => k.KeySha256.Length == 64 && k.Grants.All(Permissions.IsValidGrant))
                && o.AnonymousGrants.All(Permissions.IsValidGrant), "Every Auth grant must be permission:scope and every key hash 64 hex characters.")
            // Anonymous access is a local-development convenience only (ARCHITECTURE.md T-4): refuse to start with it elsewhere.
            .Validate(o => o.AnonymousGrants.Count == 0 || isDevelopment, "Auth:AnonymousGrants is allowed only in the Development environment.")
            // Outside Development every caller needs a key or a token. With neither, every call would only answer 401.
            .Validate(o => isDevelopment || o.Keys.Count > 0 || o.Oidc.Enabled, "Auth:Keys must contain at least one key outside the Development environment, unless Auth:Oidc:Enabled is true.")
            .Validate(o => o.Oidc.Problems(isDevelopment).Count == 0, "Auth:Oidc is enabled but incomplete: it needs an https Authority, a ClientId and at least one valid grant.")
            .ValidateOnStart();

        // Read once: the token scheme is registered or not at start, like ProtectDiagnostics (D-30).
        var oidc = configuration.GetSection(AuthOptions.Section).Get<AuthOptions>()?.Oidc ?? new OidcOptions();

        var auth = services.AddAuthentication(CredentialRouter.SchemeName)
            .AddPolicyScheme(CredentialRouter.SchemeName, "API key or access token", o => o.ForwardDefaultSelector = context =>
                CredentialRouter.SchemeFor(
                    oidc.Enabled,
                    context.Request.Path,
                    context.Request.Headers[ApiKeyAuthenticationHandler.Header].FirstOrDefault(),
                    context.Request.Query["access_token"].FirstOrDefault(),
                    context.Request.Headers.Authorization.ToString()))
            .AddScheme<AuthenticationSchemeOptions, ApiKeyAuthenticationHandler>(ApiKeyAuthenticationHandler.SchemeName, null);

        if (oidc.Enabled)
        {
            auth.AddJwtBearer(CredentialRouter.OidcSchemeName, _ => { });
            services.AddOptions<JwtBearerOptions>(CredentialRouter.OidcSchemeName)
                .Configure<IOptions<AuthOptions>>((jwt, authOptions) => jwt.ForOidc(authOptions.Value.Oidc, isDevelopment));
        }

        services.AddAuthorization();
        return services;
    }

    /// <summary>
    /// Validates the provider's signature, issuer, audience and lifetime, then gives the signed-in user the configured
    /// grants as <c>perm</c> claims, exactly as a key's grants are given (D-16). Tokens are never saved or logged.
    /// </summary>
    public static JwtBearerOptions ForOidc(this JwtBearerOptions jwt, OidcOptions oidc, bool isDevelopment)
    {
        ArgumentNullException.ThrowIfNull(jwt);
        ArgumentNullException.ThrowIfNull(oidc);

        jwt.Authority = oidc.Authority;
        jwt.Audience = oidc.EffectiveAudience;
        jwt.RequireHttpsMetadata = !isDevelopment;
        jwt.MapInboundClaims = false;
        jwt.SaveToken = false;
        jwt.IncludeErrorDetails = false;
        jwt.TokenValidationParameters.ValidateIssuer = true;
        jwt.TokenValidationParameters.ValidIssuers = [oidc.Authority, oidc.Authority.TrimEnd('/')];
        jwt.TokenValidationParameters.ValidateAudience = true;
        jwt.TokenValidationParameters.ValidAudience = oidc.EffectiveAudience;
        jwt.TokenValidationParameters.ValidateLifetime = true;
        jwt.TokenValidationParameters.RequireExpirationTime = true;
        jwt.TokenValidationParameters.RequireSignedTokens = true;
        jwt.TokenValidationParameters.ClockSkew = TimeSpan.FromSeconds(30);
        jwt.TokenValidationParameters.NameClaimType = ViewerNameClaim;

        jwt.Events = new JwtBearerEvents
        {
            // Browsers cannot set headers on a WebSocket, so the hub reads the token from the query, as it does a key (D-30).
            OnMessageReceived = context =>
            {
                context.Token ??= CredentialRouter.HubQueryToken(context.Request.Path, context.Request.Query["access_token"].FirstOrDefault());
                return Task.CompletedTask;
            },
            OnTokenValidated = context =>
            {
                if (context.Principal?.Identity is ClaimsIdentity identity)
                {
                    identity.AddClaim(new Claim(ViewerNameClaim, ViewerName(identity)));
                    identity.AddClaims(oidc.Grants.Where(Permissions.IsValidGrant).Select(g => new Claim(Permissions.ClaimType, g)));
                }

                return Task.CompletedTask;
            },
        };
        return jwt;
    }

    /// <summary><c>oidc:</c> and the provider's user name, or its subject when the token carries no user name.</summary>
    public static string ViewerName(ClaimsIdentity identity)
    {
        ArgumentNullException.ThrowIfNull(identity);
        var name = identity.FindFirst("preferred_username")?.Value;
        return ViewerNamePrefix + (string.IsNullOrWhiteSpace(name) ? identity.FindFirst("sub")?.Value ?? "unknown" : name);
    }
}
