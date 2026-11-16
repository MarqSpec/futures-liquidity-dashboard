using System.Text.Json;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Instruments;

// reference: REQUIREMENTS.md FR-10, FR-54; ARCHITECTURE.md D-4
public sealed class InstrumentRootTests
{
    [Fact]
    public void Parse_ShouldUpperCase_AndCompareByValue()
    {
        InstrumentRoot.Parse("mnq").Should().Be(InstrumentRoot.Parse("MNQ"));
        InstrumentRoot.Parse("es").Should().Be(InstrumentRoot.ES);
        InstrumentRoot.Parse("ES").ToString().Should().Be("ES");
    }

    [Fact]
    public void Parse_ShouldThrowFormatException_WhenTheValueIsNotARoot()
    {
        var act = () => InstrumentRoot.Parse("TOOLONG");

        act.Should().Throw<FormatException>().WithMessage("*TOOLONG*");
    }

    [Fact]
    public void Json_ShouldBeThePlainString_AsValueAndAsDictionaryKey()
    {
        var value = new Dictionary<InstrumentRoot, InstrumentRoot> { [InstrumentRoot.Parse("6E")] = InstrumentRoot.GC };

        var json = JsonSerializer.Serialize(value);

        json.Should().Be("{\"6E\":\"GC\"}");
        JsonSerializer.Deserialize<Dictionary<InstrumentRoot, InstrumentRoot>>(json).Should().BeEquivalentTo(value);
    }

    [Fact]
    public void Json_ShouldRefuseAMalformedRoot()
    {
        var act = () => JsonSerializer.Deserialize<InstrumentRoot>("\"E-S\"");

        act.Should().Throw<JsonException>();
    }

    [Fact]
    public void StableHash_ShouldNotDependOnTheProcess()
    {
        // FNV-1a of "ES", masked to a non-negative int: fixed, so seeds derived from it never change between runs.
        InstrumentRoot.ES.StableHash().Should().Be(InstrumentRoot.Parse("ES").StableHash());
        InstrumentRoot.ES.StableHash().Should().NotBe(InstrumentRoot.Parse("MES").StableHash());
        InstrumentRoot.Parse("ZN").StableHash().Should().BeGreaterThanOrEqualTo(0);
    }

    [Fact]
    public void CompareTo_ShouldOrderOrdinally()
    {
        new[] { InstrumentRoot.Parse("NQ"), InstrumentRoot.CL, InstrumentRoot.Parse("6E") }.Order()
            .Select(r => r.Value).Should().Equal("6E", "CL", "NQ");
        (InstrumentRoot.CL < InstrumentRoot.ES).Should().BeTrue();
    }
}
