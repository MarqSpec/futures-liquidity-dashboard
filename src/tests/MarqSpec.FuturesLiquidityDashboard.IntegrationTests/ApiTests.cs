using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using MarqSpec.FuturesLiquidityDashboard.Api.Endpoints;
using MarqSpec.FuturesLiquidityDashboard.Core.Overlays;

namespace MarqSpec.FuturesLiquidityDashboard.IntegrationTests;

// reference: INTERFACES.md Interfaces C and D.1; REQUIREMENTS.md FR-4, FR-8, FR-9, NFR-1
[Trait("Deployment", "None")]
public sealed class ApiTests(DashboardFactory factory) : IClassFixture<DashboardFactory>
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    [Fact]
    public async Task Ready_AfterWarmup_ReportsEveryInstrumentSimulated()
    {
        using var client = factory.CreateClient();
        await DashboardFactory.WaitUntilReadyAsync(client);

        using var doc = JsonDocument.Parse(await client.GetStringAsync(new Uri("/health/ready", UriKind.Relative)));
        var data = doc.RootElement.GetProperty("checks").GetProperty("ingestion").GetProperty("data");

        // Synthetic data is labelled SIMULATED, never LIVE (REQUIREMENTS.md FR-4).
        data.GetProperty("MES").GetString().Should().Be("SIMULATED");
        data.GetProperty("MGC").GetString().Should().Be("SIMULATED");
        data.GetProperty("MCL").GetString().Should().Be("SIMULATED");
    }

    [Fact]
    public async Task Snapshot_ForEachInstrument_HasItsOwnContractDepthAndOrderFlow()
    {
        using var client = factory.CreateClient();
        await DashboardFactory.WaitUntilReadyAsync(client);

        foreach (var root in new[] { "MES", "MGC", "MCL" })
        {
            using var doc = JsonDocument.Parse(await client.GetStringAsync(new Uri($"/api/snapshot/{root}?historyMinutes=5", UriKind.Relative)));
            var s = doc.RootElement;
            s.GetProperty("root").GetString().Should().Be(root);
            s.GetProperty("instrument").GetProperty("root").GetString().Should().Be(root);
            s.GetProperty("status").GetProperty("provenance").GetString().Should().Be("SIMULATED");
            s.GetProperty("bars").GetArrayLength().Should().BeGreaterThan(0, "warmup history builds bars");
            s.GetProperty("indicators").EnumerateArray().Select(i => i.GetProperty("id").GetString())
                .Should().Contain(["ema10", "ema13", "ema24", "ema48", "ema200", "rsi14", "macd", "atr14"]);
            s.GetProperty("orderFlow").GetProperty("cvdPoints").GetArrayLength().Should().BeGreaterThan(0);
            s.GetProperty("orderFlow").GetProperty("tpo").GetProperty("rows").GetArrayLength().Should().BeGreaterThan(0);
        }
    }

    [Fact]
    public async Task Instruments_ListEveryProduct_WithASummaryAndA5mAnd15mRegime()
    {
        using var client = factory.CreateClient();
        await DashboardFactory.WaitUntilReadyAsync(client);

        using var doc = JsonDocument.Parse(await client.GetStringAsync(new Uri("/api/instruments", UriKind.Relative)));
        var rows = doc.RootElement.EnumerateArray().ToList();

        rows.Count.Should().BeGreaterThan(10, "every catalog product is enabled by default");
        foreach (var row in rows)
        {
            row.GetProperty("instrument").GetProperty("sector").GetString().Should().NotBeNullOrEmpty();
            var regimes = row.GetProperty("summary").GetProperty("regimes").EnumerateArray().ToList();
            regimes.Select(r => r.GetProperty("timeframeSeconds").GetInt32()).Should().Equal(300, 900);
            regimes.Should().OnlyContain(r => r.GetProperty("trend").ValueKind == JsonValueKind.String);
        }
    }

    [Fact]
    public async Task Snapshot_UnknownInstrument_IsNotFound()
    {
        using var client = factory.CreateClient();
        using var response = await client.GetAsync(new Uri("/api/snapshot/ZZZ", UriKind.Relative));
        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Overlay_FromTheContext_IsAcceptedThenAStaleVersionIsRejected()
    {
        using var client = factory.CreateClient();
        await DashboardFactory.WaitUntilReadyAsync(client);
        using var context = JsonDocument.Parse(await client.GetStringAsync(new Uri("/api/context/MCL", UriKind.Relative)));
        var contractId = context.RootElement.GetProperty("instrument").GetProperty("contractId").GetString()!;
        using var clock = JsonDocument.Parse(await client.GetStringAsync(new Uri("/api/snapshot/MCL?historyMinutes=1", UriKind.Relative)));
        var now = DateTimeOffset.FromUnixTimeMilliseconds(clock.RootElement.GetProperty("serverTimeMs").GetInt64());
        var request = new OverlayRequest
        {
            ContractId = contractId,
            Version = now.ToUnixTimeMilliseconds() + 1_000_000,
            GeneratedAt = now,
            AsOf = now,
            ExpiresAt = now.AddMinutes(5),
            Levels = [new OverlayLevel { Price = 60.00m, Label = "Synthetic test level" }],
            Rationale = "Integration test overlay.",
        };

        using var accepted = await client.PostAsJsonAsync(new Uri("/api/overlays/MCL", UriKind.Relative), request, Json);
        accepted.StatusCode.Should().Be(HttpStatusCode.OK);

        using var stale = await client.PostAsJsonAsync(new Uri("/api/overlays/MCL", UriKind.Relative), request with { Version = request.Version - 1 }, Json);
        stale.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        var body = await stale.Content.ReadFromJsonAsync<DashboardEndpoints.ProblemDetailsBody>(Json);
        body!.Reason.Should().Be("StaleVersion");
    }

    [Fact]
    public async Task Overlay_WrongContract_IsRejectedWithAReason()
    {
        using var client = factory.CreateClient();
        var now = DateTimeOffset.UtcNow;
        var request = new OverlayRequest
        {
            ContractId = "NOT-A-CONTRACT",
            Version = 1,
            GeneratedAt = now,
            AsOf = now,
            ExpiresAt = now.AddMinutes(5),
            Levels = [],
        };

        using var response = await client.PostAsJsonAsync(new Uri("/api/overlays/MES", UriKind.Relative), request, Json);
        response.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await response.Content.ReadFromJsonAsync<DashboardEndpoints.ProblemDetailsBody>(Json))!.Reason.Should().Be("WrongContract");
    }

    [Fact]
    public async Task ReferenceAgent_PublishesAnOverlay_ThatTheSnapshotCarries()
    {
        using var client = factory.CreateClient();
        await DashboardFactory.WaitUntilReadyAsync(client);
        var deadline = DateTime.UtcNow.AddSeconds(30);
        JsonElement overlay = default;
        while (DateTime.UtcNow < deadline)
        {
            using var doc = JsonDocument.Parse(await client.GetStringAsync(new Uri("/api/snapshot/MGC?historyMinutes=1", UriKind.Relative)));
            if (doc.RootElement.TryGetProperty("overlay", out var o) && o.ValueKind == JsonValueKind.Object)
            {
                overlay = o.Clone();
                break;
            }

            await Task.Delay(500);
        }

        overlay.ValueKind.Should().Be(JsonValueKind.Object, "the reference agent publishes within seconds (REQUIREMENTS.md UC-5)");
        overlay.GetProperty("levels").GetArrayLength().Should().BeGreaterThan(0);
        overlay.GetProperty("rationale").GetString().Should().NotBeNullOrWhiteSpace();
    }

    [Fact]
    public async Task Layout_RoundTrips_AndAnUnknownPaneIsRefused()
    {
        using var client = factory.CreateClient();
        var revision = await LayoutRevision(client);
        var layout = new
        {
            revision,
            layout = new { instrument = "MGC", sliceSeconds = 5, historyMinutes = 15, indicatorMinutes = 15, heatContrast = 1.5, panes = new { footprint = true, tpo = false }, signals = new Dictionary<string, bool> { ["Spoof"] = false } },
        };
        using var put = await client.PutAsJsonAsync(new Uri("/api/layouts/me", UriKind.Relative), layout, Json);
        put.StatusCode.Should().Be(HttpStatusCode.OK);
        using var saved = JsonDocument.Parse(await client.GetStringAsync(new Uri("/api/layouts/me", UriKind.Relative)));
        saved.RootElement.GetProperty("saved").GetBoolean().Should().BeTrue();
        saved.RootElement.GetProperty("revision").GetInt64().Should().Be(revision + 1);
        var body = saved.RootElement.GetProperty("layout");
        body.GetProperty("instrument").GetString().Should().Be("MGC");
        body.GetProperty("signals").GetProperty("Spoof").GetBoolean().Should().BeFalse();

        using var snapshot = JsonDocument.Parse(await client.GetStringAsync(new Uri("/api/snapshot/MES?historyMinutes=1", UriKind.Relative)));
        snapshot.RootElement.GetProperty("indicators").EnumerateArray()
            .Where(series => series.GetProperty("id").GetString() == "ema10")
            .Select(series => series.GetProperty("tf").GetInt32())
            .Should().BeEquivalentTo([60, 300, 900], "a layout's indicator minutes must not retune the shared engines");

        var bad = new { revision = revision + 1, layout = new { instrument = "MGC", sliceSeconds = 1, historyMinutes = 15, heatContrast = 1.0, panes = new { orders = true } } };
        using var refused = await client.PutAsJsonAsync(new Uri("/api/layouts/me", UriKind.Relative), bad, Json);
        refused.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Layout_RoundTripsEventDotSizeAndCenterPrice_AndRejectsANullDotSize()
    {
        using var client = factory.CreateClient();
        var revision = await LayoutRevision(client);
        var layout = new
        {
            revision,
            layout = new { instrument = "MGC", eventDotSize = "large", centerPrice = true },
        };
        using var put = await client.PutAsJsonAsync(new Uri("/api/layouts/me", UriKind.Relative), layout, Json);
        put.StatusCode.Should().Be(HttpStatusCode.OK);
        using var saved = JsonDocument.Parse(await put.Content.ReadAsStringAsync());
        var body = saved.RootElement.GetProperty("layout");
        body.GetProperty("eventDotSize").GetString().Should().Be("large");
        body.GetProperty("centerPrice").GetBoolean().Should().BeTrue();

        var nullSize = "{\"revision\":" + (revision + 1) + ",\"layout\":{\"instrument\":\"MGC\",\"eventDotSize\":null}}";
        using var content = new StringContent(nullSize, Encoding.UTF8, "application/json");
        using var rejected = await client.PutAsync(new Uri("/api/layouts/me", UriKind.Relative), content);
        rejected.StatusCode.Should().Be(HttpStatusCode.BadRequest);

        var nullCenter = "{\"revision\":" + (revision + 1) + ",\"layout\":{\"instrument\":\"MGC\",\"centerPrice\":null}}";
        using var nullCenterBody = new StringContent(nullCenter, Encoding.UTF8, "application/json");
        using var nullCenterRejected = await client.PutAsync(new Uri("/api/layouts/me", UriKind.Relative), nullCenterBody);
        nullCenterRejected.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Layout_RoundTripsTheIndicatorPane_AndRejectsAnUnknownOne()
    {
        using var client = factory.CreateClient();
        var revision = await LayoutRevision(client);
        var layout = new
        {
            revision,
            layout = new { instrument = "MGC", indicatorPane = "rsi14" },
        };
        using var put = await client.PutAsJsonAsync(new Uri("/api/layouts/me", UriKind.Relative), layout, Json);
        put.StatusCode.Should().Be(HttpStatusCode.OK);
        using var saved = JsonDocument.Parse(await put.Content.ReadAsStringAsync());
        saved.RootElement.GetProperty("layout").GetProperty("indicatorPane").GetString().Should().Be("rsi14");

        var bad = "{\"revision\":" + (revision + 1) + ",\"layout\":{\"instrument\":\"MGC\",\"indicatorPane\":\"volume\"}}";
        using var content = new StringContent(bad, Encoding.UTF8, "application/json");
        using var rejected = await client.PutAsync(new Uri("/api/layouts/me", UriKind.Relative), content);
        rejected.StatusCode.Should().Be(HttpStatusCode.BadRequest);

        var older = "{\"revision\":" + (revision + 1) + ",\"layout\":{\"instrument\":\"MGC\",\"historyMinutes\":45}}";
        using var olderBody = new StringContent(older, Encoding.UTF8, "application/json");
        using var kept = await client.PutAsync(new Uri("/api/layouts/me", UriKind.Relative), olderBody);
        kept.StatusCode.Should().Be(HttpStatusCode.OK);
        using var preserved = JsonDocument.Parse(await kept.Content.ReadAsStringAsync());
        preserved.RootElement.GetProperty("layout").GetProperty("indicatorPane").GetString().Should().Be("rsi14");
        preserved.RootElement.GetProperty("layout").GetProperty("historyMinutes").GetInt32().Should().Be(45);
        preserved.RootElement.GetProperty("layout").GetProperty("instrument").GetString().Should().Be("MGC");

        var reset = "{\"revision\":" + (revision + 2) + ",\"layout\":{\"instrument\":\"MGC\",\"indicatorPane\":\"footprint\"}}";
        using var resetBody = new StringContent(reset, Encoding.UTF8, "application/json");
        using var replaced = await client.PutAsync(new Uri("/api/layouts/me", UriKind.Relative), resetBody);
        replaced.StatusCode.Should().Be(HttpStatusCode.OK);
        using var footprint = JsonDocument.Parse(await replaced.Content.ReadAsStringAsync());
        footprint.RootElement.GetProperty("layout").GetProperty("indicatorPane").GetString().Should().Be("footprint");
    }

    [Fact]
    public async Task Layout_RoundTripsShowPriceLine_AndRejectsANull()
    {
        using var client = factory.CreateClient();
        var revision = await LayoutRevision(client);
        var layout = new
        {
            revision,
            layout = new { instrument = "MGC", showPriceLine = false },
        };
        using var put = await client.PutAsJsonAsync(new Uri("/api/layouts/me", UriKind.Relative), layout, Json);
        put.StatusCode.Should().Be(HttpStatusCode.OK);
        using var saved = JsonDocument.Parse(await put.Content.ReadAsStringAsync());
        saved.RootElement.GetProperty("layout").GetProperty("showPriceLine").GetBoolean().Should().BeFalse();

        var restored = new
        {
            revision = revision + 1,
            layout = new { instrument = "MGC" },
        };
        using var again = await client.PutAsJsonAsync(new Uri("/api/layouts/me", UriKind.Relative), restored, Json);
        again.StatusCode.Should().Be(HttpStatusCode.OK);
        using var kept = JsonDocument.Parse(await again.Content.ReadAsStringAsync());
        kept.RootElement.GetProperty("layout").GetProperty("showPriceLine").GetBoolean().Should().BeFalse();

        var explicitOn = "{\"revision\":" + (revision + 2) + ",\"layout\":{\"instrument\":\"MGC\",\"showPriceLine\":true}}";
        using var explicitOnBody = new StringContent(explicitOn, Encoding.UTF8, "application/json");
        using var turnedOn = await client.PutAsync(new Uri("/api/layouts/me", UriKind.Relative), explicitOnBody);
        turnedOn.StatusCode.Should().Be(HttpStatusCode.OK);
        using var defaults = JsonDocument.Parse(await turnedOn.Content.ReadAsStringAsync());
        defaults.RootElement.GetProperty("layout").GetProperty("showPriceLine").GetBoolean().Should().BeTrue();

        var nullLine = "{\"revision\":" + (revision + 3) + ",\"layout\":{\"instrument\":\"MGC\",\"showPriceLine\":null}}";
        using var content = new StringContent(nullLine, Encoding.UTF8, "application/json");
        using var rejected = await client.PutAsync(new Uri("/api/layouts/me", UriKind.Relative), content);
        rejected.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Layout_ShouldKeepOptionalFields_WhenAnOlderClientOmitsThem()
    {
        using var client = factory.CreateClient();
        var revision = await LayoutRevision(client);
        var saved = "{\"revision\":" + revision + ",\"layout\":{\"instrument\":\"MGC\",\"watchlist\":[\"MES\"],\"chartMinutes\":5,\"indicatorMinutes\":15,\"heatMode\":\"flow\",\"preset\":\"rips\",\"showCandles\":true,\"showVolumeDots\":false,\"heatDim\":0.4,\"heatLowPercentile\":10,\"heatHighPercentile\":90,\"heatAutoContrast\":false,\"dotMinQuantity\":4,\"eventDotSize\":\"large\",\"centerPrice\":true,\"indicatorPane\":\"cvd\",\"showPriceLine\":false,\"hideValueArea\":true,\"emphasizeNodes\":true}}";
        using var putBody = new StringContent(saved, Encoding.UTF8, "application/json");
        using var put = await client.PutAsync(new Uri("/api/layouts/me", UriKind.Relative), putBody);
        put.StatusCode.Should().Be(HttpStatusCode.OK);

        var older = "{\"revision\":" + (revision + 1) + ",\"layout\":{\"instrument\":\"MCL\",\"sliceSeconds\":5,\"historyMinutes\":45,\"heatContrast\":1.5,\"panes\":{\"vwap\":false},\"signals\":{\"Spoof\":false}}}";
        using var olderBody = new StringContent(older, Encoding.UTF8, "application/json");
        using var keptResponse = await client.PutAsync(new Uri("/api/layouts/me", UriKind.Relative), olderBody);
        keptResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        using var kept = JsonDocument.Parse(await keptResponse.Content.ReadAsStringAsync());
        var layout = kept.RootElement.GetProperty("layout");
        layout.GetProperty("instrument").GetString().Should().Be("MCL");
        layout.GetProperty("sliceSeconds").GetInt32().Should().Be(5);
        layout.GetProperty("historyMinutes").GetInt32().Should().Be(45);
        layout.GetProperty("heatContrast").GetDouble().Should().Be(1.5);
        layout.GetProperty("panes").GetProperty("vwap").GetBoolean().Should().BeFalse();
        layout.GetProperty("signals").GetProperty("Spoof").GetBoolean().Should().BeFalse();
        layout.GetProperty("watchlist").EnumerateArray().Select(item => item.GetString()).Should().Equal("MES");
        layout.GetProperty("chartMinutes").GetInt32().Should().Be(5);
        layout.GetProperty("indicatorMinutes").GetInt32().Should().Be(15);
        layout.GetProperty("heatMode").GetString().Should().Be("flow");
        layout.GetProperty("preset").GetString().Should().Be("rips");
        layout.GetProperty("showCandles").GetBoolean().Should().BeTrue();
        layout.GetProperty("showVolumeDots").GetBoolean().Should().BeFalse();
        layout.GetProperty("heatDim").GetDouble().Should().Be(0.4);
        layout.GetProperty("heatLowPercentile").GetDouble().Should().Be(10);
        layout.GetProperty("heatHighPercentile").GetDouble().Should().Be(90);
        layout.GetProperty("heatAutoContrast").GetBoolean().Should().BeFalse();
        layout.GetProperty("dotMinQuantity").GetInt32().Should().Be(4);
        layout.GetProperty("eventDotSize").GetString().Should().Be("large");
        layout.GetProperty("centerPrice").GetBoolean().Should().BeTrue();
        layout.GetProperty("indicatorPane").GetString().Should().Be("cvd");
        layout.GetProperty("showPriceLine").GetBoolean().Should().BeFalse();
        layout.GetProperty("hideValueArea").GetBoolean().Should().BeTrue();
        layout.GetProperty("emphasizeNodes").GetBoolean().Should().BeTrue();

        var defaults = "{\"revision\":" + (revision + 2) + ",\"layout\":{\"instrument\":\"MCL\",\"eventDotSize\":\"medium\",\"centerPrice\":false,\"showPriceLine\":true,\"indicatorPane\":\"footprint\"}}";
        using var defaultsBody = new StringContent(defaults, Encoding.UTF8, "application/json");
        using var replaced = await client.PutAsync(new Uri("/api/layouts/me", UriKind.Relative), defaultsBody);
        replaced.StatusCode.Should().Be(HttpStatusCode.OK);
        using var replacedDoc = JsonDocument.Parse(await replaced.Content.ReadAsStringAsync());
        var replacedLayout = replacedDoc.RootElement.GetProperty("layout");
        replacedLayout.GetProperty("eventDotSize").GetString().Should().Be("medium");
        replacedLayout.GetProperty("centerPrice").GetBoolean().Should().BeFalse();
        replacedLayout.GetProperty("showPriceLine").GetBoolean().Should().BeTrue();
        replacedLayout.GetProperty("indicatorPane").GetString().Should().Be("footprint");
        replacedLayout.GetProperty("preset").GetString().Should().Be("rips");

        var nullCenter = "{\"revision\":" + (revision + 3) + ",\"layout\":{\"instrument\":\"MCL\",\"centerPrice\":null}}";
        using var nullCenterBody = new StringContent(nullCenter, Encoding.UTF8, "application/json");
        using var nullCenterRejected = await client.PutAsync(new Uri("/api/layouts/me", UriKind.Relative), nullCenterBody);
        nullCenterRejected.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await LayoutRevision(client)).Should().Be(revision + 3);
    }

    [Fact]
    public async Task Layout_CompareAndSet_IncrementsAndReturnsTheStoredDocumentOnMismatch()
    {
        using var client = factory.CreateClient();
        var current = await LayoutRevision(client);
        var first = new
        {
            revision = current,
            layout = new { instrument = "MGC", sliceSeconds = 1, historyMinutes = 30, heatContrast = 1.0 },
        };
        using var put = await client.PutAsJsonAsync(new Uri("/api/layouts/me", UriKind.Relative), first, Json);
        put.StatusCode.Should().Be(HttpStatusCode.OK);
        using var saved = JsonDocument.Parse(await put.Content.ReadAsStringAsync());
        saved.RootElement.GetProperty("revision").GetInt64().Should().Be(current + 1);
        saved.RootElement.GetProperty("layout").GetProperty("instrument").GetString().Should().Be("MGC");

        var stale = new
        {
            revision = current,
            layout = new { instrument = "MCL", sliceSeconds = 1, historyMinutes = 60, heatContrast = 1.0 },
        };
        using var conflict = await client.PutAsJsonAsync(new Uri("/api/layouts/me", UriKind.Relative), stale, Json);
        conflict.StatusCode.Should().Be(HttpStatusCode.Conflict);
        using var body = JsonDocument.Parse(await conflict.Content.ReadAsStringAsync());
        body.RootElement.GetProperty("saved").GetBoolean().Should().BeTrue();
        body.RootElement.GetProperty("revision").GetInt64().Should().Be(current + 1);
        body.RootElement.GetProperty("layout").GetProperty("instrument").GetString().Should().Be("MGC");

        var next = new
        {
            revision = current + 1,
            layout = new { instrument = "MCL", sliceSeconds = 1, historyMinutes = 60, heatContrast = 1.0 },
        };
        using var second = await client.PutAsJsonAsync(new Uri("/api/layouts/me", UriKind.Relative), next, Json);
        second.StatusCode.Should().Be(HttpStatusCode.OK);
        using var incremented = JsonDocument.Parse(await second.Content.ReadAsStringAsync());
        incremented.RootElement.GetProperty("revision").GetInt64().Should().Be(current + 2);
        incremented.RootElement.GetProperty("layout").GetProperty("instrument").GetString().Should().Be("MCL");
        (await LayoutRevision(client)).Should().Be(current + 2);
    }

    [Fact]
    public async Task Snapshot_ShouldCarryOnlyTheRequestedIndicatorTimeframe_WhenIndicatorMinutesIsSet()
    {
        using var client = factory.CreateClient();
        await DashboardFactory.WaitUntilReadyAsync(client);

        using var fifteen = JsonDocument.Parse(await client.GetStringAsync(
            new Uri("/api/snapshot/MES?historyMinutes=1&indicatorMinutes=15", UriKind.Relative)));
        var series = fifteen.RootElement.GetProperty("indicators").EnumerateArray().ToList();
        series.Should().NotBeEmpty();
        series.Should().OnlyContain(item => item.GetProperty("tf").GetInt32() == 900);

        using var other = JsonDocument.Parse(await client.GetStringAsync(
            new Uri("/api/snapshot/MES?historyMinutes=1&indicatorMinutes=2", UriKind.Relative)));
        other.RootElement.GetProperty("indicators").EnumerateArray().Should().OnlyContain(item => item.GetProperty("tf").GetInt32() == 60);
    }

    [Fact]
    public async Task Snapshot_ShouldCarryEveryIndicatorTimeframe_WhenIndicatorMinutesIsOmitted()
    {
        using var client = factory.CreateClient();
        await DashboardFactory.WaitUntilReadyAsync(client);

        using var snapshot = JsonDocument.Parse(await client.GetStringAsync(
            new Uri("/api/snapshot/MES?historyMinutes=1", UriKind.Relative)));
        var timeframes = snapshot.RootElement.GetProperty("indicators").EnumerateArray()
            .Select(series => series.GetProperty("tf").GetInt32())
            .Distinct()
            .ToList();

        timeframes.Should().BeEquivalentTo([60, 300, 900]);
    }

    private static async Task<long> LayoutRevision(HttpClient client)
    {
        using var doc = JsonDocument.Parse(await client.GetStringAsync(new Uri("/api/layouts/me", UriKind.Relative)));
        return doc.RootElement.GetProperty("revision").GetInt64();
    }

    [Fact]
    public async Task Metrics_ExposeFeedGauges()
    {
        using var client = factory.CreateClient();
        await DashboardFactory.WaitUntilReadyAsync(client);
        var text = await client.GetStringAsync(new Uri("/metrics", UriKind.Relative));
        text.Should().Contain("fld_feed_connected");
    }
}
