using MarqSpec.Client.ProjectX.Api.Models;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.ProjectX;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Ingestion;

// reference: INTERFACES.md Interface A.5; ARCHITECTURE.md D-15; REQUIREMENTS.md FR-5
public sealed class ProjectXEventMapperTests
{
    private static readonly InstrumentSpec Es = InstrumentCatalog.MES;

    [Theory]
    [InlineData(DomType.Bid, BookSide.Bid)]
    [InlineData(DomType.BestBid, BookSide.Bid)]
    [InlineData(DomType.NewBestBid, BookSide.Bid)]
    [InlineData(DomType.Ask, BookSide.Ask)]
    [InlineData(DomType.BestAsk, BookSide.Ask)]
    [InlineData(DomType.NewBestAsk, BookSide.Ask)]
    public void Classify_BookRows_AreLevelsOnTheirSide(DomType type, BookSide side)
    {
        ProjectXEventMapper.Classify(type).Should().Be(ProjectXEventMapper.DepthAction.Level);
        ProjectXEventMapper.SideOf(type).Should().Be(side);
    }

    [Theory]
    [InlineData(DomType.Trade)]
    [InlineData(DomType.Fill)]
    [InlineData(DomType.Low)]
    [InlineData(DomType.High)]
    [InlineData(DomType.Unknown)]
    public void Classify_NonBookRows_AreIgnored(DomType type)
    {
        ProjectXEventMapper.Classify(type).Should().Be(ProjectXEventMapper.DepthAction.Ignore);
        ProjectXEventMapper.SideOf(type).Should().BeNull();
    }

    [Fact]
    public void Classify_Reset_IsABookReset() =>
        ProjectXEventMapper.Classify(DomType.Reset).Should().Be(ProjectXEventMapper.DepthAction.Reset);

    [Fact]
    public void Level_VolumeIsTheAbsoluteSize_AndZeroRemovesTheLevel()
    {
        var level = ProjectXEventMapper.Level(new OrderBookUpdate { Type = DomType.Bid, Price = 6800.25m, Volume = 42 }, Es);
        level.Should().Be((BookSide.Bid, 27201L, 42L));

        ProjectXEventMapper.Level(new OrderBookUpdate { Type = DomType.Ask, Price = 6800.50m, Volume = 0 }, Es)!.Value.Quantity.Should().Be(0);
    }

    [Fact]
    public void Level_OffTheTickGrid_IsRefused() =>
        ProjectXEventMapper.Level(new OrderBookUpdate { Type = DomType.Bid, Price = 6800.10m, Volume = 5 }, Es).Should().BeNull();

    [Fact]
    public void Trade_WithVenueAggressor_UsesIt()
    {
        var buy = ProjectXEventMapper.Trade(Trade(6800.25m, 3, TradeLogType.Buy), Es, 1000, epoch: 2, sequence: 7, null, null)!;
        buy.Aggressor.Should().Be(BookSide.Bid);
        buy.PriceTicks.Should().Be(27201);
        buy.Quantity.Should().Be(3);
        buy.TradeId.Should().Be("PX-MES-2-7");

        ProjectXEventMapper.Trade(Trade(6800.25m, 3, TradeLogType.Sell), Es, 1000, 2, 8, null, null)!.Aggressor.Should().Be(BookSide.Ask);
    }

    [Fact]
    public void Trade_WithoutAggressor_FollowsTheTickRule()
    {
        var unknown = (TradeLogType)99;
        ProjectXEventMapper.Trade(Trade(6800.50m, 1, unknown), Es, 0, 1, 1, previousPriceTicks: 27201, previousAggressor: BookSide.Ask)!
            .Aggressor.Should().Be(BookSide.Bid, "an uptick is buyer-initiated");
        ProjectXEventMapper.Trade(Trade(6800.00m, 1, unknown), Es, 0, 1, 2, 27201, BookSide.Bid)!
            .Aggressor.Should().Be(BookSide.Ask, "a downtick is seller-initiated");
        ProjectXEventMapper.Trade(Trade(6800.25m, 1, unknown), Es, 0, 1, 3, 27201, BookSide.Ask)!
            .Aggressor.Should().Be(BookSide.Ask, "an unchanged price keeps the previous aggressor");
    }

    [Fact]
    public void Trade_NonPositiveSizeOrOffGrid_IsRefused()
    {
        ProjectXEventMapper.Trade(Trade(6800.25m, 0, TradeLogType.Buy), Es, 0, 1, 1, null, null).Should().BeNull();
        ProjectXEventMapper.Trade(Trade(6800.30m, 1, TradeLogType.Buy), Es, 0, 1, 1, null, null).Should().BeNull();
    }

    [Fact]
    public void ToUnixMs_TreatsUnspecifiedAsUtc_AndFallsBackWhenUnset()
    {
        var utc = new DateTime(2026, 11, 10, 14, 0, 0, DateTimeKind.Utc);
        var expected = new DateTimeOffset(utc).ToUnixTimeMilliseconds();
        ProjectXEventMapper.ToUnixMs(utc, 0).Should().Be(expected);
        ProjectXEventMapper.ToUnixMs(DateTime.SpecifyKind(utc, DateTimeKind.Unspecified), 0).Should().Be(expected);
        ProjectXEventMapper.ToUnixMs(default, 1234).Should().Be(1234);
    }

    [Fact]
    public void FromBar_ExpandsToFourPoints_WithTheVolumeKept_AndZeroDelta()
    {
        var bar = new AggregateBar
        {
            Timestamp = new DateTime(2026, 11, 10, 14, 0, 0, DateTimeKind.Utc),
            Open = 6800.00m,
            High = 6801.00m,
            Low = 6799.50m,
            Close = 6800.75m,
            Volume = 100,
        };
        long sequence = 0;

        var prints = ProjectXEventMapper.FromBar(bar, Es, ref sequence).ToList();

        prints.Sum(p => p.Quantity).Should().Be(100);
        prints.Where(p => p.Aggressor == BookSide.Bid).Sum(p => p.Quantity)
            .Should().Be(prints.Where(p => p.Aggressor == BookSide.Ask).Sum(p => p.Quantity), "history has no aggressor");
        prints.Select(p => p.PriceTicks).Distinct().Should().Equal(27200, 27198, 27204, 27203); // up bar: open, low, high, close
        prints.Select(p => p.TradeId).Should().OnlyHaveUniqueItems();
        sequence.Should().Be(prints.Count);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(5)]
    [InlineData(1001)]
    public void FromBar_ThinBar_KeepsItsExactVolume(long volume)
    {
        long sequence = 0;
        var bar = new AggregateBar { Timestamp = new DateTime(2026, 11, 10, 3, 0, 0, DateTimeKind.Utc), Open = 6800, High = 6801, Low = 6799.75m, Close = 6800.5m, Volume = volume };

        var prints = ProjectXEventMapper.FromBar(bar, Es, ref sequence).ToList();

        prints.Sum(p => p.Quantity).Should().Be(volume, "warmup must not inflate thin overnight minutes");
        Math.Abs(prints.Where(p => p.Aggressor == BookSide.Bid).Sum(p => p.Quantity) - prints.Where(p => p.Aggressor == BookSide.Ask).Sum(p => p.Quantity))
            .Should().BeLessThanOrEqualTo(1);
    }

    [Theory]
    [InlineData(6800, 6800.25, 6800, 6800.25, 2)]
    [InlineData(6800.5, 6800.5, 6800, 6800.25, 3)]
    [InlineData(6800, 6800.5, 6800, 6800.25, 3)]
    [InlineData(6800, 6800, 6800, 6800, 1)]
    [InlineData(6800, 6800, 6800, 6800, 3)]
    [InlineData(6800, 6801, 6799.75, 6800.5, 4)]
    [InlineData(6800.5, 6801, 6799.75, 6800, 7)]
    public void FromBar_RebuildsTheBarsOhlcAndVolume(double o, double h, double l, double c, long volume)
    {
        long sequence = 0;
        var bar = new AggregateBar
        {
            Timestamp = new DateTime(2026, 11, 10, 3, 0, 0, DateTimeKind.Utc),
            Open = (decimal)o,
            High = (decimal)h,
            Low = (decimal)l,
            Close = (decimal)c,
            Volume = volume,
        };

        var prints = ProjectXEventMapper.FromBar(bar, Es, ref sequence).OrderBy(p => p.SourceTimeMs).ThenBy(p => p.Sequence).ToList();

        prints.Sum(p => p.Quantity).Should().Be(volume);
        Es.TryToTicks((decimal)o, out var open);
        Es.TryToTicks((decimal)h, out var high);
        Es.TryToTicks((decimal)l, out var low);
        Es.TryToTicks((decimal)c, out var close);
        prints[0].PriceTicks.Should().Be(open, "the first print is the open");
        prints[^1].PriceTicks.Should().Be(close, "the last print is the close");
        prints.Max(p => p.PriceTicks).Should().Be(high);
        prints.Min(p => p.PriceTicks).Should().Be(low);
    }

    [Fact]
    public void ToClosedMinute_ShouldKeepTheBarStartAndVolume_WhenThePricesSitOnTheTickGrid()
    {
        var stamp = new DateTime(2026, 11, 10, 14, 2, 0, DateTimeKind.Utc);
        var bar = new AggregateBar
        {
            Timestamp = stamp,
            Open = 6800m,
            High = 6801m,
            Low = 6799.75m,
            Close = 6800.5m,
            Volume = 12,
        };

        var minute = ProjectXEventMapper.ToClosedMinute(bar, Es);

        minute.Should().NotBeNull();
        minute!.Value.StartMs.Should().Be(new DateTimeOffset(stamp).ToUnixTimeMilliseconds());
        minute.Value.Volume.Should().Be(12);
        minute.Value.OpenTicks.Should().Be(Es.ToTicks(6800m));
        minute.Value.CloseTicks.Should().Be(Es.ToTicks(6800.5m));
    }

    [Fact]
    public void ToClosedMinute_ShouldReturnNothing_WhenAPriceIsOffTheTickGrid()
    {
        var bar = new AggregateBar { Timestamp = DateTime.UnixEpoch, Open = 6800.1m, High = 6801m, Low = 6799m, Close = 6800m, Volume = 4 };

        ProjectXEventMapper.ToClosedMinute(bar, Es).Should().BeNull();
    }

    [Fact]
    public void FromBar_EmptyOrOffGrid_YieldsNothing()
    {
        long sequence = 0;
        ProjectXEventMapper.FromBar(new AggregateBar { Open = 1, High = 1, Low = 1, Close = 1, Volume = 0 }, Es, ref sequence).Should().BeEmpty();
        ProjectXEventMapper.FromBar(new AggregateBar { Open = 6800.1m, High = 6801, Low = 6799, Close = 6800, Volume = 10 }, Es, ref sequence).Should().BeEmpty();
    }

    private static TradeUpdate Trade(decimal price, decimal volume, TradeLogType type) => new()
    {
        ContractId = "CON.F.US.EP.Z26",
        Price = price,
        Volume = volume,
        Type = type,
        Timestamp = new DateTime(2026, 11, 10, 14, 0, 0, DateTimeKind.Utc),
    };
}
