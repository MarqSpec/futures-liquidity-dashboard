using MarqSpec.Client.ProjectX;
using MarqSpec.Client.ProjectX.Api.Models;
using MarqSpec.Client.ProjectX.DependencyInjection;
using MarqSpec.Client.ProjectX.WebSocket;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Api.Auth;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.ProjectX;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace MarqSpec.FuturesLiquidityDashboard.Api.ProjectX;

/// <summary>
/// Headless read of the ProjectX market hub. It logs in, resolves MES, MCL and MGC, subscribes to quotes, trades
/// and depth, and prints counts. It never opens the user hub and never calls an order, position or account route.
/// A session conflict stops the process immediately.
/// </summary>
public static class LiveSmokeCommand
{
    public static bool IsRequested(string[] args) => args.Any(a => string.Equals(a, "live-smoke", StringComparison.OrdinalIgnoreCase));

    public static async Task<int> RunAsync(string[] args)
    {
        var seconds = ReadSeconds(args);
        if (!ProjectXLogin.TryResolve(Environment.GetEnvironmentVariable, out _))
        {
            Console.Error.WriteLine(
                "Missing ProjectX credentials. Set exactly one pair: PROJECTX_USERNAME and PROJECTX_API_KEY "
                + "(loginKey userName and apiKey; this pair wins if both are set). "
                + "The older pair PROJECTX_API_KEY (user name) and PROJECTX_API_SECRET (api key) is also accepted. "
                + "Values are not printed.");
            return 2;
        }

        // After the presence check: the client library reads PROJECTX_API_KEY as the login user name.
        ProjectXLogin.AlignProcessEnvironment();

        var builder = Host.CreateApplicationBuilder(new HostApplicationBuilderSettings
        {
            Args = [],
            ContentRootPath = AppContext.BaseDirectory,
        });
        builder.Configuration["ProjectX:WebSocket:AutoReconnect"] = "false";
        builder.Services.AddProjectXApiClient(builder.Configuration);
        using var host = builder.Build();
        await using var scope = host.Services.CreateAsyncScope();
        var api = scope.ServiceProvider.GetRequiredService<IProjectXApiClient>();
        var socket = host.Services.GetRequiredService<IProjectXWebSocketClient>();
        var report = new ProjectXSmokeReport();
        var conflict = 0;
        var names = new Dictionary<string, string>(StringComparer.Ordinal);

        void OnStatus(object? sender, ConnectionStatusChange change)
        {
            if (ProjectXSessionGuard.IsConflict(change.ErrorMessage) || ProjectXSessionGuard.IsConflict(change.Exception))
            {
                Interlocked.Exchange(ref conflict, 1);
            }
        }

        void OnQuote(object? sender, PriceUpdate quote) => Observe(names, report, quote.ContractId, "quote", quote.Timestamp);
        void OnTrade(object? sender, TradeUpdate trade) => Observe(names, report, trade.ContractId, "trade", trade.Timestamp);
        void OnDepth(object? sender, OrderBookUpdate row) => Observe(names, report, row.ContractId, "depth", row.Timestamp);

        socket.ConnectionStatusChanged += OnStatus;
        socket.PriceUpdateReceived += OnQuote;
        socket.TradeUpdateReceived += OnTrade;
        socket.OrderBookUpdateReceived += OnDepth;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(seconds + 30));
        try
        {
            var contracts = new List<Contract>();
            foreach (var root in ProjectXSmokeTargets.Roots)
            {
                var contract = await ResolveFrontMonthAsync(api, root, timeout.Token).ConfigureAwait(false);
                contracts.Add(contract);
                names[contract.Id] = root.ToString();
                Console.WriteLine($"{root}  {contract.Id}  {contract.Name}  symbol {contract.SymbolId}  tick {contract.TickSize}");
            }

            await socket.ConnectMarketHubAsync(timeout.Token).ConfigureAwait(false);
            if (conflict == 1)
            {
                Console.Error.WriteLine(ProjectXSessionConflictException.StopMessage);
                return 3;
            }

            foreach (var contract in contracts)
            {
                await socket.SubscribeToPriceUpdatesAsync(contract.Id, timeout.Token).ConfigureAwait(false);
                await socket.SubscribeToTradeUpdatesAsync(contract.Id, timeout.Token).ConfigureAwait(false);
                await socket.SubscribeToOrderBookUpdatesAsync(contract.Id, timeout.Token).ConfigureAwait(false);
            }

            var until = DateTimeOffset.UtcNow.AddSeconds(seconds);
            while (DateTimeOffset.UtcNow < until)
            {
                if (conflict == 1)
                {
                    Console.Error.WriteLine(ProjectXSessionConflictException.StopMessage);
                    return 3;
                }

                await Task.Delay(250, timeout.Token).ConfigureAwait(false);
            }

            Console.WriteLine(report.Render());
            return 0;
        }
        catch (Exception ex) when (ProjectXSessionGuard.IsConflict(ex))
        {
            Console.Error.WriteLine(ProjectXSessionConflictException.StopMessage);
            return 3;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("live-smoke failed: " + ex.GetType().Name + ": " + SecretRedactor.Redact(ex.Message));
            return 1;
        }
        finally
        {
            socket.ConnectionStatusChanged -= OnStatus;
            socket.PriceUpdateReceived -= OnQuote;
            socket.TradeUpdateReceived -= OnTrade;
            socket.OrderBookUpdateReceived -= OnDepth;
            try
            {
                await socket.DisconnectMarketHubAsync(CancellationToken.None).ConfigureAwait(false);
            }
            catch (InvalidOperationException)
            {
                // The hub was never connected.
            }
        }
    }

    internal static async Task<Contract> ResolveFrontMonthAsync(IProjectXApiClient api, InstrumentRoot root, CancellationToken cancellationToken)
    {
        foreach (var live in new[] { false, true })
        {
            var found = await api.SearchContractsAsync(root.ToString(), live, cancellationToken).ConfigureAwait(false);
            if (ProjectXMarketFeed.PickContract(root, found) is { } picked)
            {
                return picked;
            }
        }

        foreach (var live in new[] { false, true })
        {
            var available = await api.GetAvailableContractsAsync(live, cancellationToken).ConfigureAwait(false);
            if (ProjectXMarketFeed.PickContract(root, available) is { } picked)
            {
                return picked;
            }
        }

        throw new InvalidOperationException($"ProjectX lists no {root} contract.");
    }

    private static void Observe(Dictionary<string, string> names, ProjectXSmokeReport report, string? contractId, string kind, DateTime timestamp)
    {
        var symbol = contractId is not null && names.TryGetValue(contractId, out var root) ? root : contractId ?? "unknown";
        DateTimeOffset? source = timestamp == default ? null : new DateTimeOffset(DateTime.SpecifyKind(timestamp, DateTimeKind.Utc));
        report.Observe(symbol, kind, source, DateTimeOffset.UtcNow);
    }

    private static int ReadSeconds(string[] args)
    {
        var index = Array.FindIndex(args, a => string.Equals(a, "--seconds", StringComparison.OrdinalIgnoreCase));
        if (index < 0 || index + 1 >= args.Length || !int.TryParse(args[index + 1], out var seconds))
        {
            return 60;
        }

        return Math.Clamp(seconds, 1, 600);
    }
}
