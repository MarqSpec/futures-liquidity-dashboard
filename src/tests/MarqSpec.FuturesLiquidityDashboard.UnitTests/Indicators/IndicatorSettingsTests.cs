using MarqSpec.FuturesLiquidityDashboard.Core.Engine;
using MarqSpec.FuturesLiquidityDashboard.Core.Indicators;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Indicators;

// reference: REQUIREMENTS.md FR-16, FR-17; ARCHITECTURE.md D-68
public sealed class IndicatorSettingsTests
{
    [Theory]
    [InlineData(60, 201)]
    [InlineData(300, 1_005)]
    [InlineData(900, 3_015)]
    public void EmaWarmupMinutes_ShouldBeOneBarMoreThanTheSlowestPeriodInOneMinuteBars_WhenTheDefaultSetIsRead(int sourceSeconds, int minutes)
    {
        IndicatorSettings.Default.EmaWarmupMinutes(sourceSeconds).Should().Be(minutes);
    }

    [Fact]
    public void EmaWarmupMinutes_ShouldUseTheLongestPeriod_WhenItIsNotListedLast()
    {
        var settings = IndicatorSettings.Default with { Emas = [new(200), new(10), new(48)] };

        settings.EmaWarmupMinutes(300).Should().Be(1_005);
    }

    [Fact]
    public void EmaWarmupMinutes_ShouldRoundAPartMinuteSourceUp_WhenTheSourceIsNotWholeMinutes()
    {
        var settings = IndicatorSettings.Default with { Emas = [new(10)] };

        settings.EmaWarmupMinutes(90).Should().Be(22, "eleven 90-second bars need two one-minute bars of history each");
    }

    [Fact]
    public void EmaWarmupMinutes_ShouldBeZero_WhenNoEmaIsConfigured()
    {
        var settings = IndicatorSettings.Default with { Emas = [] };

        settings.EmaWarmupMinutes(300).Should().Be(0);
    }

    [Fact]
    public void IndicatorWarmupMinutes_ShouldSeedTheFiveMinuteEma200AndNotTheFifteen_WhenTheDefaultsAreUsed()
    {
        EngineOptions.SeededIndicatorSeconds.Should().Be(300);
        EngineOptions.Default.IndicatorWarmupMinutes.Should().Be(1_005, "EMA 200 on five-minute bars is 1,000 one-minute bars, plus the forming bar");
    }
}
