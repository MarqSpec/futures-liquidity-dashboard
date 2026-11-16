using MarqSpec.Client.ProjectX.DependencyInjection;
using MarqSpec.FuturesLiquidityDashboard.Core.Engine;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;
using MarqSpec.FuturesLiquidityDashboard.Core.Regime;
using MarqSpec.FuturesLiquidityDashboard.Core.Sessions;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Feeds;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.ProjectX;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Replay;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Synthetic;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace MarqSpec.FuturesLiquidityDashboard.Ingestion.Hosting;

/// <summary>Registers the engines, the configured feed and the ingestion service (DEPLOYMENT.md §3).</summary>
public static partial class IngestionServiceCollectionExtensions
{
    /// <summary>The configuration section listing the enabled instruments (default: <c>*</c>, every product). The default tabs are MES, MCL and MGC.</summary>
    public const string InstrumentsKey = "Engine:Instruments";

    /// <summary>Roots left out of the selection, for example when <see cref="InstrumentsKey"/> is <c>*</c>.</summary>
    public const string ExcludeKey = "Engine:ExcludeInstruments";

    public static IServiceCollection AddMarketData(this IServiceCollection services, IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(configuration);

        services.AddOptions<FeedOptions>().Bind(configuration.GetSection(FeedOptions.Section)).ValidateDataAnnotations().ValidateOnStart();
        services.TryAddSingleton(TimeProvider.System);
        services.AddSingleton<IngestMetrics>();
        services.TryAddSingleton(_ => new ExchangeCalendar());

        var engineOptions = ReadEngineOptions(configuration);
        var feed = configuration.GetSection(FeedOptions.Section).Get<FeedOptions>() ?? new FeedOptions();
        var selection = ReadSelection(configuration);
        if (feed.Provider != FeedProvider.ProjectX && selection.Uncatalogued() is { Count: > 0 } unknown)
        {
            throw new InvalidOperationException(
                $"{InstrumentsKey} lists {string.Join(", ", unknown)}, which the instrument catalog does not describe; only the ProjectX feed "
                + "can stream a product outside the catalog (it reads the contract from the gateway).");
        }

        services.AddSingleton(engineOptions);
        services.AddSingleton(selection);
        services.AddSingleton(sp => new EngineRegistry(selection.InitialSpecs(), engineOptions, sp.GetRequiredService<ExchangeCalendar>()));
        services.TryAddSingleton(sp => new DepthDemand(
            sp.GetRequiredService<IOptions<FeedOptions>>().Value.Depth,
            sp.GetRequiredService<TimeProvider>()));

        switch (feed.Provider)
        {
            case FeedProvider.Synthetic:
                services.AddSingleton(sp => new SyntheticMarketFeed(
                    sp.GetRequiredService<IOptions<FeedOptions>>().Value.Synthetic,
                    sp.GetRequiredService<ExchangeCalendar>(),
                    sp.GetRequiredService<TimeProvider>(),
                    sp.GetRequiredService<DepthDemand>()));
                services.AddSingleton<IMarketDataFeed>(sp => sp.GetRequiredService<SyntheticMarketFeed>());
                services.AddSingleton<IHistoricalTradeSource>(sp => sp.GetRequiredService<SyntheticMarketFeed>());
                break;
            case FeedProvider.Replay:
                services.AddSingleton<IMarketDataFeed>(sp => new ReplayMarketFeed(
                    sp.GetRequiredService<IOptions<FeedOptions>>().Value.Replay,
                    sp.GetRequiredService<TimeProvider>()));
                break;
            case FeedProvider.ProjectX:
                ProjectXLogin.AlignProcessEnvironment();
                RequireProjectXCredentials(configuration);
                services.AddProjectXApiClient(configuration);
                services.AddSingleton(sp =>
                {
                    var feedOptions = sp.GetRequiredService<IOptions<FeedOptions>>().Value;
                    return ActivatorUtilities.CreateInstance<ProjectXMarketFeed>(sp, feedOptions.ProjectX, feedOptions.Ingest);
                });
                services.AddSingleton<IMarketDataFeed>(sp => sp.GetRequiredService<ProjectXMarketFeed>());
                services.AddSingleton<IHistoricalTradeSource>(sp => sp.GetRequiredService<ProjectXMarketFeed>());
                services.AddSingleton<IMinuteBarSource>(sp => sp.GetRequiredService<ProjectXMarketFeed>());
                services.AddSingleton<IInstrumentResolver>(sp => sp.GetRequiredService<ProjectXMarketFeed>());
                break;
            default:
                throw new InvalidOperationException($"Unknown Feed:Provider {feed.Provider}.");
        }

        services.AddSingleton(sp =>
        {
            var source = sp.GetRequiredService<IMarketDataFeed>();
            return new IngestionState { FeedName = source.Name, Provenance = source.Provenance };
        });
        services.AddHostedService(sp => new IngestionService(
            sp.GetRequiredService<IMarketDataFeed>(),
            sp.GetRequiredService<EngineRegistry>(),
            sp.GetRequiredService<IOptions<FeedOptions>>(),
            sp.GetRequiredService<ExchangeCalendar>(),
            sp.GetRequiredService<IngestionState>(),
            sp.GetRequiredService<TimeProvider>(),
            sp.GetRequiredService<ILogger<IngestionService>>(),
            sp.GetService<IHistoricalTradeSource>(),
            sp.GetService<IInstrumentResolver>(),
            sp.GetRequiredService<InstrumentSelection>(),
            sp.GetService<IMinuteBarSource>(),
            configuration: configuration,
            metrics: sp.GetRequiredService<IngestMetrics>()));
        return services;
    }

    /// <summary>
    /// <c>Engine:OrderFlow:SignalRetention</c> (<c>Engine__OrderFlow__SignalRetention</c>) used to be the per-kind ring.
    /// It is not read (ARCHITECTURE.md D-41). A desk that still sets it would think the old ring was in force.
    /// </summary>
    public static void WarnRetiredSignalRetention(IConfiguration configuration, ILogger logger)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentNullException.ThrowIfNull(logger);
        if (configuration.GetSection("Engine:OrderFlow:SignalRetention").Exists())
        {
            Log.RetiredSignalRetention(logger);
        }
    }

    private static partial class Log
    {
        [LoggerMessage(
            Level = LogLevel.Warning,
            Message = "Engine:OrderFlow:SignalRetention (Engine__OrderFlow__SignalRetention) is set and is not read. Signals are kept for Engine:HistoryRetentionMinutes and capped by Engine:OrderFlow:SignalHistoryCap.")]
        public static partial void RetiredSignalRetention(ILogger logger);
    }

    /// <summary>
    /// The ProjectX credentials must be present before startup continues, so a missing key fails at once with a
    /// clear message rather than as a 401 on the first call. They are read from configuration, which includes the
    /// environment and user-secrets; they are never logged.
    /// </summary>
    public static void RequireProjectXCredentials(IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        if (!ProjectXLogin.HasCredentials(configuration))
        {
            throw new InvalidOperationException(
                "Feed:Provider is ProjectX but no ProjectX credentials were found. Set exactly one pair: "
                + "PROJECTX_USERNAME and PROJECTX_API_KEY (the loginKey userName and apiKey; this pair wins if both are set), "
                + "or PROJECTX_API_KEY and PROJECTX_API_SECRET where PROJECTX_API_KEY is the user name the client library sends. "
                + "Or set Feed:Provider to Synthetic for the no-credentials demo.");
        }
    }

    public static EngineOptions ReadEngineOptions(IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        var section = configuration.GetSection("Engine");
        var defaults = EngineOptions.Default;

        // Each part is bound into a fresh instance so the shared Default records are never mutated.
        var orderFlow = new OrderFlowOptions();
        section.GetSection("OrderFlow").Bind(orderFlow);
        orderFlow = orderFlow with { SignalHistoryCap = OrderFlowOptions.ClampSignalHistoryCap(orderFlow.SignalHistoryCap) };
        var regime = ReadRegime(section.GetSection("Regime"));
        return defaults with
        {
            SliceMs = section.GetValue(nameof(EngineOptions.SliceMs), defaults.SliceMs),
            RetentionMinutes = section.GetValue(nameof(EngineOptions.RetentionMinutes), defaults.RetentionMinutes),
            HistoryRetentionMinutes = section.GetValue(nameof(EngineOptions.HistoryRetentionMinutes), defaults.HistoryRetentionMinutes),
            StaleAfterMs = section.GetValue(nameof(EngineOptions.StaleAfterMs), defaults.StaleAfterMs),
            LadderLevels = section.GetValue(nameof(EngineOptions.LadderLevels), defaults.LadderLevels),
            PrintCapacity = Math.Max(1, section.GetValue(nameof(EngineOptions.PrintCapacity), defaults.PrintCapacity)),
            OrderFlow = orderFlow,
            Regime = regime,
        };
    }

    /// <summary>
    /// <c>Engine:Regime</c> (REQUIREMENTS.md FR-56). The timeframe list is read on its own, because binding a list onto the
    /// default would add to it instead of replacing it.
    /// </summary>
    private static RegimeOptions ReadRegime(IConfigurationSection section)
    {
        var d = RegimeOptions.Default;
        var timeframes = section.GetSection(nameof(RegimeOptions.TimeframesSeconds)).Get<int[]>();
        var options = d with
        {
            TimeframesSeconds = timeframes is { Length: > 0 } ? timeframes : d.TimeframesSeconds,
            AdxPeriod = section.GetValue(nameof(RegimeOptions.AdxPeriod), d.AdxPeriod),
            EfficiencyPeriod = section.GetValue(nameof(RegimeOptions.EfficiencyPeriod), d.EfficiencyPeriod),
            EmaFast = section.GetValue(nameof(RegimeOptions.EmaFast), d.EmaFast),
            EmaSlow = section.GetValue(nameof(RegimeOptions.EmaSlow), d.EmaSlow),
            TrendAdx = section.GetValue(nameof(RegimeOptions.TrendAdx), d.TrendAdx),
            TrendEfficiency = section.GetValue(nameof(RegimeOptions.TrendEfficiency), d.TrendEfficiency),
            RangeAdx = section.GetValue(nameof(RegimeOptions.RangeAdx), d.RangeAdx),
            RangeEfficiency = section.GetValue(nameof(RegimeOptions.RangeEfficiency), d.RangeEfficiency),
        };
        if (options.TimeframesSeconds.Any(t => t < 1) || options.RangeAdx > options.TrendAdx || options.RangeEfficiency > options.TrendEfficiency)
        {
            throw new InvalidOperationException(
                "Engine:Regime needs positive timeframes, RangeAdx ≤ TrendAdx and RangeEfficiency ≤ TrendEfficiency.");
        }

        return options;
    }

    /// <summary>
    /// The product selection: <see cref="InstrumentsKey"/> absent, empty or <c>*</c> is every product, otherwise the
    /// roots named; <see cref="ExcludeKey"/> takes roots out either way.
    /// </summary>
    public static InstrumentSelection ReadSelection(IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        var configured = configuration.GetSection(InstrumentsKey).Get<string[]>() ?? [];
        var excluded = ParseRoots(configuration.GetSection(ExcludeKey).Get<string[]>() ?? [], ExcludeKey).ToHashSet();
        if (configured.Length == 0 || configured.Any(v => v.Trim() == InstrumentSelection.AllToken))
        {
            return InstrumentSelection.Everything with { Excluded = excluded };
        }

        return new InstrumentSelection { All = false, Roots = ParseRoots(configured, InstrumentsKey).Distinct().ToList(), Excluded = excluded };
    }

    /// <summary>The catalog products the selection names (what the engines start with before the feed resolves).</summary>
    public static IReadOnlyList<InstrumentRoot> ReadInstruments(IConfiguration configuration) =>
        ReadSelection(configuration).InitialSpecs().Select(s => s.Root).ToList();

    private static IEnumerable<InstrumentRoot> ParseRoots(IEnumerable<string> values, string key)
    {
        foreach (var value in values)
        {
            if (!InstrumentRoot.TryParse(value?.Trim(), out var root))
            {
                throw new InvalidOperationException($"{key} lists '{value}', which is not an instrument root (1-6 letters or digits, or * for all).");
            }

            yield return root;
        }
    }
}
