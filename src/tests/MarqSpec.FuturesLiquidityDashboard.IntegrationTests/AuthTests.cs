using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text.Json;
using MarqSpec.FuturesLiquidityDashboard.Api.Hubs;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace MarqSpec.FuturesLiquidityDashboard.IntegrationTests;

// reference: REQUIREMENTS.md §2 (permissions with scopes), NFR-6; ARCHITECTURE.md T-4
[Trait("Deployment", "None")]
public sealed class AuthTests(ProductionDashboardFactory factory) : IClassFixture<ProductionDashboardFactory>
{
    [Fact]
    public async Task NoKey_InProduction_IsUnauthorized()
    {
        using var client = factory.CreateClient();
        using var response = await client.GetAsync(new Uri("/api/instruments", UriKind.Relative));
        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public void AnonymousGrants_OutsideDevelopment_StopStartup()
    {
        using var withAnonymous = factory.WithWebHostBuilder(b => b.UseSetting("Auth:AnonymousGrants:0", "view-dashboard:*"));

        var start = () => withAnonymous.CreateClient();

        start.Should().Throw<OptionsValidationException>().WithMessage("*AnonymousGrants*Development*");
    }

    [Fact]
    public async Task UnknownKey_IsUnauthorized()
    {
        using var client = Client("not-a-configured-key");
        using var response = await client.GetAsync(new Uri("/api/instruments", UriKind.Relative));
        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task ScopedViewer_SeesOnlyItsInstrument()
    {
        using var client = Client(ProductionDashboardFactory.EsViewerKey);
        var instruments = await client.GetFromJsonAsync<List<Dictionary<string, object>>>(new Uri("/api/instruments", UriKind.Relative));
        instruments.Should().HaveCount(1);

        using var es = await client.GetAsync(new Uri("/api/snapshot/MES?historyMinutes=1", UriKind.Relative));
        es.StatusCode.Should().Be(HttpStatusCode.OK);
        using var gc = await client.GetAsync(new Uri("/api/snapshot/MGC?historyMinutes=1", UriKind.Relative));
        gc.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Grants_AreNotInherited()
    {
        // The agent may read context and publish for GC, but holds no view-dashboard grant.
        using var client = Client(ProductionDashboardFactory.AgentKey);
        using var context = await client.GetAsync(new Uri("/api/context/MES", UriKind.Relative));
        context.StatusCode.Should().Be(HttpStatusCode.OK);
        using var snapshot = await client.GetAsync(new Uri("/api/snapshot/MES?historyMinutes=1", UriKind.Relative));
        snapshot.StatusCode.Should().Be(HttpStatusCode.Forbidden);

        // A viewer cannot publish an overlay.
        using var viewer = Client(ProductionDashboardFactory.EsViewerKey);
        using var publish = await viewer.PostAsJsonAsync(new Uri("/api/overlays/MES", UriKind.Relative), new { contractId = "x", version = 1 });
        publish.StatusCode.Should().BeOneOf(HttpStatusCode.Forbidden, HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task PlanMetrics_ShouldBeForbidden_WhenTheKeyHasNoViewDashboardGrantForThatInstrument()
    {
        var plan = new { side = "long", entryType = "limit", entryTicks = 20000, quantity = 1, stopTicks = 19990, contractId = "x", createdMs = 1 };

        // The agent reads context everywhere but views nothing; the viewer views MES only.
        using var agent = Client(ProductionDashboardFactory.AgentKey);
        using var agentResponse = await agent.PostAsJsonAsync(new Uri("/api/plans/metrics/MES", UriKind.Relative), plan);
        using var viewer = Client(ProductionDashboardFactory.EsViewerKey);
        using var otherResponse = await viewer.PostAsJsonAsync(new Uri("/api/plans/metrics/MGC", UriKind.Relative), plan);

        (agentResponse.StatusCode, otherResponse.StatusCode).Should().Be((HttpStatusCode.Forbidden, HttpStatusCode.Forbidden));
    }

    [Fact]
    public void NoKeys_OutsideDevelopment_StopStartup()
    {
        using var keyless = new KeylessProductionFactory();

        var start = () => keyless.CreateClient();

        start.Should().Throw<OptionsValidationException>().WithMessage("*Auth:Keys*Development*");
    }

    [Fact]
    public async Task AccessTokenOnAPathThatOnlyStartsWithHubs_IsUnauthorized()
    {
        using var client = factory.CreateClient();
        var key = ProductionDashboardFactory.EsViewerKey;

        using var response = await client.GetAsync(new Uri($"/hubsx?access_token={Uri.EscapeDataString(key)}", UriKind.Relative));

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Liveness_NeedsNoKey()
    {
        using var client = factory.CreateClient();
        using var response = await client.GetAsync(new Uri("/health/live", UriKind.Relative));
        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Ready_WithoutKey_IsUnauthorized_WhenDiagnosticsAreProtected()
    {
        using var client = factory.CreateClient();
        using var response = await client.GetAsync(new Uri("/health/ready", UriKind.Relative));

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        var body = await response.Content.ReadAsStringAsync();
        body.Should().NotContain("MES").And.NotContain("STALE").And.NotContain("LIVE").And.NotContain("SIMULATED").And.NotContain("RECOVERING");
    }

    [Fact]
    public async Task Metrics_WithoutKey_IsUnauthorized_WhenDiagnosticsAreProtected()
    {
        using var client = factory.CreateClient();
        using var response = await client.GetAsync(new Uri("/metrics", UriKind.Relative));

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await response.Content.ReadAsStringAsync()).Should().NotContain("fld_");
    }

    [Fact]
    public async Task ReadyAndMetrics_WithKey_AreNotUnauthorized()
    {
        using var client = Client(ProductionDashboardFactory.EsViewerKey);

        using var ready = await client.GetAsync(new Uri("/health/ready", UriKind.Relative));
        ready.StatusCode.Should().NotBe(HttpStatusCode.Unauthorized);
        using var metrics = await client.GetAsync(new Uri("/metrics", UriKind.Relative));
        metrics.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Diagnostics_StayOpen_WhenProtectionIsDisabled()
    {
        using var host = factory.WithWebHostBuilder(b => b.UseSetting("Auth:ProtectDiagnostics", "false"));
        using var client = host.CreateClient();

        using var ready = await client.GetAsync(new Uri("/health/ready", UriKind.Relative));
        ready.StatusCode.Should().NotBe(HttpStatusCode.Unauthorized);
        using var metrics = await client.GetAsync(new Uri("/metrics", UriKind.Relative));
        metrics.StatusCode.Should().Be(HttpStatusCode.OK);
        using var live = await client.GetAsync(new Uri("/health/live", UriKind.Relative));
        live.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Negotiate_WithAccessTokenQuery_IsAccepted_AndTheBodyOmitsTheKey()
    {
        using var client = factory.CreateClient();
        var key = ProductionDashboardFactory.EsViewerKey;

        using var denied = await client.PostAsync(new Uri("/hubs/market/negotiate?negotiateVersion=1", UriKind.Relative), null);
        denied.StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        using var response = await client.PostAsync(NegotiateUri(key), null);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await response.Content.ReadAsStringAsync();
        body.Should().NotContain(key);
        body.Should().Contain("connectionToken");
    }

    [Fact]
    public async Task Negotiate_WithBearer_IsAccepted()
    {
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", ProductionDashboardFactory.EsViewerKey);

        using var response = await client.PostAsync(new Uri("/hubs/market/negotiate?negotiateVersion=1", UriKind.Relative), null);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task AccessTokenQuery_OnTheApi_DoesNotAuthenticate()
    {
        using var client = factory.CreateClient();
        var key = ProductionDashboardFactory.EsViewerKey;

        using var response = await client.GetAsync(new Uri($"/api/instruments?access_token={Uri.EscapeDataString(key)}", UriKind.Relative));

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task HubWebSocket_WithAccessTokenQuery_Connects_AndWithoutItDoesNot()
    {
        var key = ProductionDashboardFactory.EsViewerKey;
        using var client = factory.CreateClient();
        using var negotiated = await client.PostAsync(NegotiateUri(key), null);
        negotiated.EnsureSuccessStatusCode();
        using var document = JsonDocument.Parse(await negotiated.Content.ReadAsStringAsync());
        var token = document.RootElement.GetProperty("connectionToken").GetString();
        token.Should().NotBeNullOrEmpty();

        var denied = () => ConnectWebSocketAsync($"hubs/market?id={Uri.EscapeDataString(token!)}");
        await denied.Should().ThrowAsync<InvalidOperationException>();

        using var socket = await ConnectWebSocketAsync(
            $"hubs/market?id={Uri.EscapeDataString(token!)}&access_token={Uri.EscapeDataString(key)}");
        socket.State.Should().Be(WebSocketState.Open);
        socket.CloseStatus.Should().BeNull();
    }

    [Fact]
    public async Task Hub_WithAccessTokenProvider_SubscribesToTheGrantedInstrument()
    {
        await using var connection = Hub(ProductionDashboardFactory.EsViewerKey);
        await connection.StartAsync();

        var snapshot = await connection.InvokeAsync<JsonElement>("Subscribe", "MES", 1);

        snapshot.GetProperty("root").GetString().Should().Be("MES");
    }

    [Fact]
    public async Task Hub_WithoutKey_DoesNotConnect()
    {
        await using var connection = Hub(null);

        var act = () => connection.StartAsync();

        await act.Should().ThrowAsync<HttpRequestException>().Where(error => error.ToString().Contains("401", StringComparison.Ordinal));
    }

    [Fact]
    public async Task AccessToken_IsNotWrittenToLogs()
    {
        var logs = new CollectingLoggerProvider();
        using var host = factory.WithWebHostBuilder(builder =>
        {
            builder.ConfigureLogging(logging =>
            {
                logging.SetMinimumLevel(LogLevel.Information);
                logging.AddFilter("Microsoft.AspNetCore.Hosting.Diagnostics", LogLevel.Information);
                logging.AddProvider(logs);
            });
        });
        using var client = host.CreateClient();
        var key = ProductionDashboardFactory.EsViewerKey;

        using var response = await client.PostAsync(NegotiateUri(key), null);
        response.StatusCode.Should().Be(HttpStatusCode.OK);

        logs.Lines.Should().NotContain(line => line.Contains(key, StringComparison.Ordinal));
        logs.Lines.Should().Contain(line => line.Contains("[redacted]", StringComparison.Ordinal));
    }

    private static Uri NegotiateUri(string key) =>
        new($"/hubs/market/negotiate?negotiateVersion=1&access_token={Uri.EscapeDataString(key)}", UriKind.Relative);

    private async Task<WebSocket> ConnectWebSocketAsync(string relative)
    {
        var http = new Uri(factory.Server.BaseAddress, relative);
        var ws = new UriBuilder(http) { Scheme = "ws" }.Uri;
        return await factory.Server.CreateWebSocketClient().ConnectAsync(ws, CancellationToken.None);
    }

    private HubConnection Hub(string? key)
    {
        var server = factory.Server;
        return new HubConnectionBuilder()
            .WithUrl(new Uri(server.BaseAddress, MarketHub.Path), options =>
            {
                options.HttpMessageHandlerFactory = _ => server.CreateHandler();
                options.Transports = HttpTransportType.LongPolling;
                if (key is not null)
                {
                    options.AccessTokenProvider = () => Task.FromResult<string?>(key);
                }
            })
            .Build();
    }

    private HttpClient Client(string key)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-Api-Key", key);
        return client;
    }
}

file sealed class CollectingLoggerProvider : ILoggerProvider
{
    public List<string> Lines { get; } = [];

    public ILogger CreateLogger(string categoryName) => new CollectingLogger(Lines);

    public void Dispose()
    {
    }

    private sealed class CollectingLogger(List<string> lines) : ILogger
    {
        public IDisposable BeginScope<TState>(TState state)
            where TState : notnull => NullScope.Instance;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            lines.Add(formatter(state, exception));
        }
    }

    private sealed class NullScope : IDisposable
    {
        public static readonly NullScope Instance = new();

        public void Dispose()
        {
        }
    }
}
