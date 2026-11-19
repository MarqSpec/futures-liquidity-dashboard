using MarqSpec.FuturesLiquidityDashboard.Api.Auth;
using MarqSpec.FuturesLiquidityDashboard.Api.Feedback;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Feedback;

// A host-booting unit test (CONVENTIONS.md §8.1): what it guards exists only in the composition, namely the
// permission wiring, the route surface, where logs and metrics go, and that startup succeeds without a key. One product
// on the synthetic feed; the Messages API is a faked HttpMessageHandler, so no test reaches the network.

/// <summary>Production, three synthetic keys, feedback on Claude with a synthetic key and a faked upstream.</summary>
public sealed class FeedbackHostFactory : WebApplicationFactory<Program>
{
    public const string FeedbackViewerKey = "synthetic-feedback-viewer-key";
    public const string PlainViewerKey = "synthetic-plain-viewer-key";
    public const string FeedbackOnlyKey = "synthetic-feedback-only-key";

    private readonly Dictionary<string, string?> _settings = new()
    {
        ["Feed:Provider"] = "Synthetic",
        ["Feed:MinHistoryHours"] = "0.1",
        ["Feed:WarmRegimes"] = "false",
        ["Feed:Synthetic:StepMs"] = "50",
        ["Engine:Instruments:0"] = "MES",
        ["Agent:Enabled"] = "false",
        ["Auth:Keys:0:Name"] = "feedback-viewer",
        ["Auth:Keys:0:KeySha256"] = ApiKeyAuthenticationHandler.HashKey(FeedbackViewerKey),
        ["Auth:Keys:0:Grants:0"] = "view-dashboard:MES",
        ["Auth:Keys:0:Grants:1"] = "request-feedback:MES",
        ["Auth:Keys:1:Name"] = "plain-viewer",
        ["Auth:Keys:1:KeySha256"] = ApiKeyAuthenticationHandler.HashKey(PlainViewerKey),
        ["Auth:Keys:1:Grants:0"] = "view-dashboard:MES",
        ["Auth:Keys:1:Grants:1"] = "configure-layout:MES",
        ["Auth:Keys:2:Name"] = "feedback-only",
        ["Auth:Keys:2:KeySha256"] = ApiKeyAuthenticationHandler.HashKey(FeedbackOnlyKey),
        ["Auth:Keys:2:Grants:0"] = "request-feedback:MES",
        ["Feedback:Enabled"] = "true",
        ["Feedback:Provider"] = "Claude",
        ["Feedback:ApiKey"] = FeedbackTestData.SyntheticKey,
        ["Feedback:MaxRetries"] = "0",
        ["ANTHROPIC_API_KEY"] = string.Empty,
    };

    public FeedbackHostFactory(HttpMessageHandler upstream, Dictionary<string, string?>? overrides = null, string environment = "Production")
    {
        Upstream = upstream;
        Environment = environment;
        foreach (var (key, value) in overrides ?? [])
        {
            _settings[key] = value;
        }
    }

    public HttpMessageHandler Upstream { get; }

    public string Environment { get; }

    public List<Action<IServiceCollection>> ExtraServices { get; } = [];

    public HttpClient Client(string? key)
    {
        var client = CreateClient();
        if (key is not null)
        {
            client.DefaultRequestHeaders.Add(ApiKeyAuthenticationHandler.Header, key);
        }

        return client;
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.UseEnvironment(Environment);
        foreach (var (key, value) in _settings)
        {
            builder.UseSetting(key, value);
        }

        builder.ConfigureTestServices(services =>
        {
            services.AddHttpClient(ClaudeFeedbackModel.HttpClientName).ConfigurePrimaryHttpMessageHandler(() => new NonDisposing(Upstream));
            foreach (var extra in ExtraServices)
            {
                extra(services);
            }
        });
    }

    // The handler factory disposes the handlers it builds; the faked upstream outlives them.
    private sealed class NonDisposing(HttpMessageHandler inner) : DelegatingHandler(inner)
    {
        protected override void Dispose(bool disposing) => base.Dispose(false);
    }
}
