using MarqSpec.FuturesLiquidityDashboard.Core.Engine;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Engine;

// reference: REQUIREMENTS.md P4, FR-10
public sealed class EngineRegistryTests
{
    [Fact]
    public void Constructor_ShouldCreateOneEnginePerDistinctRoot_WhenRootsRepeat()
    {
        var registry = new EngineRegistry([InstrumentRoot.MES, InstrumentRoot.MCL, InstrumentRoot.MES], EngineOptions.Default, TestData.Calendar());

        registry.Enabled.Should().BeEquivalentTo(new[] { InstrumentRoot.MES, InstrumentRoot.MCL });
        registry.TryGet(InstrumentRoot.MGC, out _).Should().BeFalse();
    }

    [Fact]
    public void Rebind_ShouldSwapInAnEngineForTheNewContract_WhenTheRootIsEnabled()
    {
        var registry = new EngineRegistry([InstrumentRoot.MES], EngineOptions.Default, TestData.Calendar());
        registry.TryGet(InstrumentRoot.MES, out var original);
        var frontMonth = InstrumentCatalog.MES with { ContractId = "ESH27" };

        var rebound = registry.Rebind(frontMonth);

        registry.TryGet(InstrumentRoot.MES, out var current).Should().BeTrue();
        current.Should().BeSameAs(rebound).And.NotBeSameAs(original);
        current.Spec.ContractId.Should().Be("ESH27");
    }

    [Fact]
    public void Rebind_ShouldThrow_WhenTheRootIsNotEnabled()
    {
        var registry = new EngineRegistry([InstrumentRoot.MES], EngineOptions.Default, TestData.Calendar());

        var act = () => registry.Rebind(InstrumentCatalog.MGC);

        act.Should().Throw<InvalidOperationException>().WithMessage("*GC*not enabled*");
    }
}
