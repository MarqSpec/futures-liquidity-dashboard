using MarqSpec.FuturesLiquidityDashboard.Api.Layouts;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Layouts;

// Paths only: nothing here touches the disk.
public sealed class LayoutStoreOptionsTests
{
    private static readonly string ContentRoot = Path.Combine(Path.GetTempPath(), "content-root");

    [Fact]
    public void StorePath_ShouldBeDataLayoutsJson_WhenNotConfigured()
    {
        new LayoutStoreOptions().StorePath.Should().Be("data/layouts.json");
    }

    [Fact]
    public void ResolvePath_ShouldAnchorAtTheContentRoot_WhenTheStorePathIsRelative()
    {
        var resolved = new LayoutStoreOptions().ResolvePath(ContentRoot);

        resolved.Should().Be(Path.GetFullPath(Path.Combine(ContentRoot, "data", "layouts.json")));
    }

    [Fact]
    public void ResolvePath_ShouldKeepThePath_WhenTheStorePathIsAbsolute()
    {
        var absolute = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "volume", "layouts.json"));

        new LayoutStoreOptions { StorePath = absolute }.ResolvePath(ContentRoot).Should().Be(absolute);
    }

    [Fact]
    public void Validate_ShouldAccept_WhenTheStorePathIsTheDefault()
    {
        new LayoutStoreOptions().Validate().Should().BeEmpty();
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void IsPersistent_ShouldBeFalse_WhenTheStorePathIsBlank(string? path)
    {
        new LayoutStoreOptions { StorePath = path! }.IsPersistent.Should().BeFalse();
    }

    [Fact]
    public void IsPersistent_ShouldBeTrue_WhenTheStorePathNamesAFile()
    {
        new LayoutStoreOptions().IsPersistent.Should().BeTrue();
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void Validate_ShouldAccept_WhenTheStorePathIsBlank(string? path)
    {
        new LayoutStoreOptions { StorePath = path! }.Validate().Should().BeEmpty("a blank path keeps layouts in memory only");
    }

    [Theory]
    [InlineData("data/")]
    [InlineData("data\\")]
    public void Validate_ShouldRefuse_WhenTheStorePathNamesADirectory(string path)
    {
        new LayoutStoreOptions { StorePath = path }.Validate().Should().ContainSingle()
            .Which.Should().Contain("Layouts:StorePath");
    }
}
