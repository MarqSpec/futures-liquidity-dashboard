using System.Text.Json;
using System.Threading.Channels;
using MarqSpec.FuturesLiquidityDashboard.Api.Hubs;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;

namespace MarqSpec.FuturesLiquidityDashboard.IntegrationTests;

// reference: INTERFACES.md D.2 (snapshot, then ordered deltas); REQUIREMENTS.md NFR-5
[Trait("Deployment", "None")]
public sealed class HubTests(DashboardFactory factory) : IClassFixture<DashboardFactory>
{
    private static readonly string[] Watchlist = ["GC", "NQ", "ZZZ", "bad!"];

    [Fact]
    public async Task Subscribe_ReturnsASnapshot_ThenDeltasContinueTheSequenceWithoutGaps()
    {
        using var client = factory.CreateClient();
        await DashboardFactory.WaitUntilReadyAsync(client);
        var server = factory.Server;
        await using var connection = new HubConnectionBuilder()
            .WithUrl(new Uri(server.BaseAddress, MarketHub.Path), o =>
            {
                o.HttpMessageHandlerFactory = _ => server.CreateHandler();
                o.Transports = HttpTransportType.LongPolling;
            })
            .Build();
        var deltas = Channel.CreateUnbounded<JsonElement>();
        connection.On<JsonElement>(MarketHub.DeltaMethod, d => deltas.Writer.TryWrite(d));
        await connection.StartAsync();

        var snapshot = await connection.InvokeAsync<JsonElement>("Subscribe", "MES", 5);
        var seq = snapshot.GetProperty("seq").GetInt64();
        snapshot.GetProperty("root").GetString().Should().Be("MES");
        snapshot.GetProperty("indicators").EnumerateArray().Should().NotBeEmpty()
            .And.OnlyContain(series => series.GetProperty("tf").GetInt32() == 60, "a subscribe that never set a timeframe is one minute");

        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var applied = 0;
        while (applied < 10)
        {
            var delta = await deltas.Reader.ReadAsync(timeout.Token);
            delta.GetProperty("root").GetString().Should().Be("MES", "only the subscribed instrument is streamed");
            var next = delta.GetProperty("seq").GetInt64();
            if (next <= seq)
            {
                continue; // published before the snapshot was taken: already included in it.
            }

            next.Should().Be(seq + 1, "deltas arrive in order with no gap");
            seq = next;
            applied++;
        }
    }

    [Fact]
    public async Task Subscribe_UnknownInstrument_Fails()
    {
        var server = factory.Server;
        await using var connection = new HubConnectionBuilder()
            .WithUrl(new Uri(server.BaseAddress, MarketHub.Path), o =>
            {
                o.HttpMessageHandlerFactory = _ => server.CreateHandler();
                o.Transports = HttpTransportType.LongPolling;
            })
            .Build();
        await connection.StartAsync();

        var act = () => connection.InvokeAsync<JsonElement>("Subscribe", "ZZZ", 5);
        await act.Should().ThrowAsync<HubException>();
    }

    [Fact]
    public async Task SetWatchlist_GrantsDepthForEnabledProducts_AndRefusesTheRest()
    {
        using var client = factory.CreateClient();
        await DashboardFactory.WaitUntilReadyAsync(client);
        await using var connection = Connect();
        await connection.StartAsync();

        var result = await connection.InvokeAsync<JsonElement>("SetWatchlist", Watchlist);

        Strings(result.GetProperty("depth")).Should().BeEquivalentTo(["GC", "NQ"]);
        Strings(result.GetProperty("refused")).Should().BeEquivalentTo(["ZZZ", "bad!"]);
    }

    [Fact]
    public async Task Subscribe_PullsDepthForTheWatchedProduct_WhileAnUnwatchedOneHasTradesOnly()
    {
        using var client = factory.CreateClient();
        await DashboardFactory.WaitUntilReadyAsync(client);
        await using var connection = Connect();
        await connection.StartAsync();

        await connection.InvokeAsync<JsonElement>("Subscribe", "ZN", 5);

        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var deadline = DateTime.UtcNow.AddSeconds(20);
        while (true)
        {
            var status = await StatusesAsync(client, timeout.Token);
            if (status["ZN"] && !status["ZB"])
            {
                break;
            }

            if (timeout.IsCancellationRequested || DateTime.UtcNow > deadline)
            {
                throw new InvalidOperationException("ZN has no depth yet: " + string.Join(",", status.Where(kv => kv.Value).Select(kv => kv.Key)));
            }

            await Task.Delay(200, timeout.Token);
        }
    }

    private static async Task<Dictionary<string, bool>> StatusesAsync(HttpClient client, CancellationToken cancellationToken)
    {
        using var doc = JsonDocument.Parse(await client.GetStringAsync(new Uri("/api/instruments", UriKind.Relative), cancellationToken));
        return doc.RootElement.EnumerateArray().ToDictionary(
            e => e.GetProperty("instrument").GetProperty("root").GetString()!,
            e => e.GetProperty("status").GetProperty("depthSubscribed").GetBoolean());
    }

    private static List<string> Strings(JsonElement array) => [.. array.EnumerateArray().Select(e => e.GetString()!)];

    private HubConnection Connect()
    {
        var server = factory.Server;
        return new HubConnectionBuilder()
            .WithUrl(new Uri(server.BaseAddress, MarketHub.Path), o =>
            {
                o.HttpMessageHandlerFactory = _ => server.CreateHandler();
                o.Transports = HttpTransportType.LongPolling;
            })
            .Build();
    }
}
