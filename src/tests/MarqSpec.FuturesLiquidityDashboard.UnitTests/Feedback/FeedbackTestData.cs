using System.Net;
using System.Text;
using System.Text.Json;
using MarqSpec.FuturesLiquidityDashboard.Api.Feedback;
using MarqSpec.FuturesLiquidityDashboard.Core.Plans;
using MarqSpec.FuturesLiquidityDashboard.Core.Regime;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Feedback;

// Invented tick keys around 1000 and an invented key; nothing here is market data or a real credential.
internal static class FeedbackTestData
{
    public const string SyntheticKey = "sk-ant-synthetic-0000-test-key-not-real-abcdef123456";
    public const long AsOfMs = 1_763_500_000_000;

    private static readonly string[] StopCites = ["throughFrequency.60", "stopPlacement"];
    private static readonly string[] TargetCites = ["rewardRisk"];
    private static readonly string[] RiskCites = ["throughFrequency.60"];

    public static readonly PlanSpec LongLimit = new(true, false, 996, 2, 992, [new PlanTarget(1004, 1), new PlanTarget(1008, 1)]);

    public static PlanMetrics Metrics(bool stopJustInside = false) => new()
    {
        Instrument = "MES",
        ContractId = "CON.F.US.MES.Z26",
        AsOfMs = AsOfMs,
        StatusCode = "SIMULATED",
        LastTicks = 1000,
        AtrTicks = 4,
        Legs =
        [
            Leg("entry", null, 996, new ThroughFrequency(60, "below", 60, 18, 0.3, 1, false)),
            Leg("stop", null, 992, new ThroughFrequency(60, "below", 60, 3, 0.05, 1, false)),
            Leg("target", 0, 1004, new ThroughFrequency(60, "above", 60, 36, 0.6, 1, false)),
            Leg("target", 1, 1008, new ThroughFrequency(60, "above", 0, 0, null, 0, true)),
        ],
        RewardRisk = [new RewardRisk(0, 1004, 2, null), new RewardRisk(1, 1008, 3, null)],
        StopAtr = 1,
        StopPlacement = stopJustInside
            ? new StopPlacement(true, [new StopNear("profile", "VAL", 991, 1)], true)
            : new StopPlacement(false, [], true),
        Regimes = [],
        Coverage = new PlanCoverage(),
    };

    public static LegMetrics Leg(string leg, int? index, long price, ThroughFrequency sixty) => new(
        leg,
        index,
        price,
        price - 1000,
        (price - 1000) / 4.0,
        null,
        leg == "stop" ? null : new RestingSize(leg == "entry" ? "bid" : "ask", 40, null, 35.5, null, 1, false),
        [sixty, sixty with { Bars = 240 }],
        AsOfMs - 120_000,
        new InTheWay(true, [], null),
        [],
        null,
        new FlowContext(12, false, [], [], [], null));

    /// <summary>A structured-output reply as the model would write it, with one cite that names no metric.</summary>
    public static string ValidOutput(string unknownCite = "vibes") => JsonSerializer.Serialize(new
    {
        summary = "Entry sits one ATR below the last price; the stop is rarely traded through.",
        legs = new object[]
        {
            new { leg = "entry", index = (int?)null, fillLikelihood = "medium", assessment = "Traded through in 18 of 60 known minutes.", suggestion = (object?)null, cites = new[] { "throughFrequency.60", unknownCite } },
            new { leg = "stop", index = (int?)null, fillLikelihood = "low", assessment = "Traded through in 3 of 60 known minutes.", suggestion = (object?)new { priceTicks = 990, why = "Below the 991 VAL." }, cites = StopCites },
            new { leg = "target", index = (int?)0, fillLikelihood = "high", assessment = "Reward to risk 2.", suggestion = (object?)null, cites = TargetCites },
        },
        risks = new[] { new { text = "The second target window has no known bars.", cites = RiskCites } },
    });

    public static ModelReply Reply(string stopReason, string? text, params TokenUsage[] usage) => new(stopReason, text, usage);

    public static TokenUsage Usage(long input = 1_000_000, long output = 0, long cacheWrite = 0, long cacheRead = 0, string model = "claude-opus-5-5") =>
        new(model, input, output, cacheWrite, cacheRead);

    /// <summary>An HTTP response from the Messages API, in its wire shape.</summary>
    public static HttpResponseMessage ClaudeMessage(string text, string stopReason = "end_turn", string? extraUsage = null)
    {
        var content = text.Length == 0 ? "[]" : $"[{{\"type\":\"text\",\"text\":{JsonSerializer.Serialize(text)}}}]";
        var json = $$$"""
            {"id":"msg_synthetic","type":"message","role":"assistant","model":"claude-opus-5-5","content":{{{content}}},
             "stop_reason":"{{{stopReason}}}","stop_sequence":null,
             "usage":{"input_tokens":1200,"output_tokens":400,"cache_creation_input_tokens":2000,"cache_read_input_tokens":900{{{extraUsage}}}}}
            """;
        return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
    }

    /// <summary>An error response whose body echoes the key, as a careless upstream might.</summary>
    public static HttpResponseMessage ClaudeError(HttpStatusCode status, string type) => new(status)
    {
        Content = new StringContent(
            $$$"""{"type":"error","error":{"type":"{{{type}}}","message":"rejected key {{{SyntheticKey}}}"}}""",
            Encoding.UTF8,
            "application/json"),
    };
}
