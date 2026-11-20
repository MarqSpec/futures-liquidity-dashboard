using System.Text.Json;
using System.Text.RegularExpressions;
using MarqSpec.FuturesLiquidityDashboard.Api.Layouts;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Layouts;

// reference: REQUIREMENTS.md FR-9, FR-72, NFR-6; ARCHITECTURE.md D-18
// The disk is a FakeItEasy fake (LayoutDisk): a second store over the same fake is a process restart.
public sealed partial class LayoutStoreTests
{
    private static readonly CancellationToken None = CancellationToken.None;

    /// <summary>A long that filled and took its first target, with every FR-72 tracking field set.</summary>
    internal const string FilledLong = """
        {"side":"long","entryType":"limit","entryTicks":20000,"quantity":3,"stopTicks":19990,
         "targets":[{"priceTicks":20010,"quantity":1},{"priceTicks":20020,"quantity":2}],
         "contractId":"MESZ26","createdMs":1760000000000,
         "state":"filled","fill":{"timeMs":1760000060000,"priceTicks":20000,"riskTicks":10},
         "exits":[{"timeMs":1760000120000,"priceTicks":20010,"quantity":1,"kind":"target"}]}
        """;

    private static LayoutSettings Planned(int historyMinutes = 45) => JsonSerializer.Deserialize<LayoutSettings>(
        $$$"""{"instrument":"MGC","historyMinutes":{{{historyMinutes}}},"watchlist":["MES","MGC"],"panes":{"heatmap":true},"positions":{"MES":{{{FilledLong}}}}}""",
        Json)!;

    private static string File(string layouts) => $$$"""{"version":1,"layouts":{{{{layouts}}}}}""";

    [Fact]
    public async Task GetAsync_ShouldReturnTheLastSavedLayoutWithItsPositions_WhenANewStoreReadsTheSameDisk()
    {
        var disk = new LayoutDisk();
        var before = disk.Store();
        await before.SaveAsync("viewer", Planned(), 0, None);
        await before.SaveAsync("viewer", Planned(historyMinutes: 90), 1, None);

        var after = await disk.Store().GetAsync("viewer", None);

        after.Saved.Should().BeTrue();
        after.Revision.Should().Be(2);
        JsonSerializer.Serialize(after.Layout, Json).Should().Be(JsonSerializer.Serialize(Planned(historyMinutes: 90), Json),
            "the plan, its fill and its exits must come back as they were saved");
    }

    [Fact]
    public async Task SaveAsync_ShouldContinueTheRevisionCounter_WhenTheStoreRestarts()
    {
        var disk = new LayoutDisk();
        var before = disk.Store();
        await before.SaveAsync("viewer", Planned(), 0, None);
        await before.SaveAsync("viewer", Planned(), 1, None);
        var restarted = disk.Store();

        var stale = await restarted.SaveAsync("viewer", new LayoutSettings { Instrument = "MCL" }, 0, None);
        var next = await restarted.SaveAsync("viewer", new LayoutSettings { Instrument = "MCL" }, 2, None);

        stale.Applied.Should().BeFalse("revision 0 is a client that never saw the stored layout");
        stale.Document.Revision.Should().Be(2);
        next.Applied.Should().BeTrue();
        next.Document.Revision.Should().Be(3);
        (await disk.Store().GetAsync("viewer", None)).Revision.Should().Be(3);
    }

    [Fact]
    public async Task GetAsync_ShouldReportUnsaved_WhenTheStoreFileIsMissing()
    {
        var disk = new LayoutDisk();

        var document = await disk.Store().GetAsync("viewer", None);

        document.Saved.Should().BeFalse();
        document.Revision.Should().Be(0);
        document.Layout.Instrument.Should().Be("MES");
    }

    [Fact]
    public async Task GetAsync_ShouldLogOneWarning_WhenTheStoreFileIsMissing()
    {
        var disk = new LayoutDisk();
        var store = disk.Store();

        await store.GetAsync("viewer", None);
        await store.GetAsync("other", None);

        disk.Warnings.Should().Be(1, "the file is read once per process");
    }

    public static TheoryData<string> CorruptFiles => new()
    {
        string.Empty,
        "{not json",
        "null",
        "[]",
        "42",
        """{"version":2,"layouts":{"viewer":{"revision":1,"layout":{}}}}""",
        """{"layouts":{"viewer":{"revision":1,"layout":{}}}}""",
        """{"version":1}""",
        """{"version":1,"layouts":null}""",
        """{"version":1,"layouts":[]}""",
        """{"version":1,"layouts":{"viewer":{"revision":"one","layout":{}}}}""",
    };

    [Theory]
    [MemberData(nameof(CorruptFiles))]
    public async Task GetAsync_ShouldReportUnsaved_WhenTheStoreFileIsCorrupt(string text)
    {
        var disk = new LayoutDisk();
        disk.Files[LayoutDisk.StorePath] = text;

        var document = await disk.Store().GetAsync("viewer", None);

        document.Saved.Should().BeFalse();
        document.Revision.Should().Be(0);
    }

    [Theory]
    [MemberData(nameof(CorruptFiles))]
    public async Task GetAsync_ShouldLogAWarning_WhenTheStoreFileIsCorrupt(string text)
    {
        var disk = new LayoutDisk();
        disk.Files[LayoutDisk.StorePath] = text;

        await disk.Store().GetAsync("viewer", None);

        disk.Warnings.Should().Be(1);
    }

    [Theory]
    [InlineData(typeof(IOException))]
    [InlineData(typeof(UnauthorizedAccessException))]
    public async Task GetAsync_ShouldReportUnsaved_WhenTheStoreFileCannotBeRead(Type failure)
    {
        var disk = new LayoutDisk();
        A.CallTo(() => disk.FileSystem.ReadAsync(A<string>._, A<CancellationToken>._)).Throws((Exception)Activator.CreateInstance(failure)!);

        var document = await disk.Store().GetAsync("viewer", None);

        document.Saved.Should().BeFalse();
        disk.Warnings.Should().Be(1);
    }

    [Theory]
    [InlineData("null")]
    [InlineData("""{"revision":1}""")]
    [InlineData("""{"revision":1,"layout":null}""")]
    [InlineData("""{"revision":0,"layout":{}}""")]
    [InlineData("""{"revision":-3,"layout":{}}""")]
    [InlineData("""{"revision":1,"layout":{"panes":{"orders":true}}}""")]
    [InlineData("""{"revision":1,"layout":{"instrument":"es"}}""")]
    [InlineData("""{"revision":1,"layout":{"instrument":null}}""")]
    [InlineData("""{"revision":1,"layout":{"watchlist":null}}""")]
    [InlineData("""{"revision":1,"layout":{"panes":null}}""")]
    [InlineData("""{"revision":1,"layout":{"signals":null}}""")]
    [InlineData("""{"revision":1,"layout":{"positions":{"MES":{"side":"sideways"}}}}""")]
    public async Task GetAsync_ShouldDropOnlyThatEntry_WhenOneStoredLayoutIsNotOneTheApiWouldAccept(string entry)
    {
        var disk = new LayoutDisk();
        disk.Files[LayoutDisk.StorePath] = File($$$""" "bob":{{{entry}}},"alice":{"revision":4,"layout":{"instrument":"MGC"}} """);
        var store = disk.Store();

        var bob = await store.GetAsync("bob", None);
        var alice = await store.GetAsync("alice", None);

        bob.Saved.Should().BeFalse();
        bob.Revision.Should().Be(0);
        alice.Saved.Should().BeTrue("one bad entry must not cost the other viewers their layouts");
        alice.Revision.Should().Be(4);
        alice.Layout.Instrument.Should().Be("MGC");
    }

    [Fact]
    public async Task GetAsync_ShouldLogAWarning_WhenAStoredLayoutIsDropped()
    {
        var disk = new LayoutDisk();
        disk.Files[LayoutDisk.StorePath] = File(""" "bob":{"revision":0,"layout":{}} """);

        await disk.Store().GetAsync("bob", None);

        disk.Warnings.Should().Be(1);
    }

    [Fact]
    public async Task GetAsync_ShouldLogNoWarning_WhenTheStoreFileIsValid()
    {
        var disk = new LayoutDisk();
        disk.Files[LayoutDisk.StorePath] = File(""" "alice":{"revision":4,"layout":{"instrument":"MGC"}} """);

        await disk.Store().GetAsync("alice", None);

        disk.Warnings.Should().Be(0);
    }

    [Fact]
    public async Task SaveAsync_ShouldReplaceTheStoreFromATempFileBesideIt_WhenASaveApplies()
    {
        var disk = new LayoutDisk();

        await disk.Store().SaveAsync("viewer", Planned(), 0, None);

        var written = Fake.GetCalls(disk.FileSystem).Where(call => call.Method.Name == nameof(ILayoutFileSystem.WriteAsync)).Select(call => call.GetArgument<string>(0));
        var temp = written.Should().ContainSingle().Which!;
        temp.Should().NotBe(LayoutDisk.StorePath, "a crash mid-write must not leave half a store");
        Path.GetDirectoryName(temp).Should().Be(Path.GetDirectoryName(LayoutDisk.StorePath), "a rename is atomic only on one volume");
        A.CallTo(() => disk.FileSystem.WriteAsync(temp, A<string>._, A<CancellationToken>._)).MustHaveHappenedOnceExactly()
            .Then(A.CallTo(() => disk.FileSystem.Replace(temp, LayoutDisk.StorePath)).MustHaveHappenedOnceExactly());
    }

    [Fact]
    public async Task SaveAsync_ShouldLeaveTheStoreFileAsItWas_WhenTheTempWriteFails()
    {
        var disk = new LayoutDisk();
        await disk.Store().SaveAsync("viewer", Planned(), 0, None);
        var before = disk.Stored;
        A.CallTo(() => disk.FileSystem.WriteAsync(A<string>._, A<string>._, A<CancellationToken>._)).Throws(new IOException("disk full"));

        await disk.Store().SaveAsync("viewer", new LayoutSettings { Instrument = "MCL" }, 1, None);

        disk.Stored.Should().Be(before);
        A.CallTo(() => disk.FileSystem.Replace(A<string>._, A<string>._)).MustHaveHappenedOnceExactly();
    }

    [Theory]
    [InlineData(typeof(IOException))]
    [InlineData(typeof(UnauthorizedAccessException))]
    public async Task SaveAsync_ShouldReportAStoreFailure_WhenTheStoreCannotBeWritten(Type failure)
    {
        var disk = new LayoutDisk();
        A.CallTo(() => disk.FileSystem.Replace(A<string>._, A<string>._)).Throws((Exception)Activator.CreateInstance(failure)!);

        var saved = await disk.Store().SaveAsync("viewer", Planned(), 0, None);

        saved.Applied.Should().BeFalse("a save that did not reach the file is not acknowledged");
        saved.StoreFailed.Should().BeTrue();
        disk.Errors.Should().Be(1);
    }

    [Fact]
    public async Task SaveAsync_ShouldKeepThePreviousRevision_WhenTheStoreCannotBeWritten()
    {
        var disk = new LayoutDisk();
        var store = disk.Store();
        await store.SaveAsync("viewer", Planned(), 0, None);
        A.CallTo(() => disk.FileSystem.Replace(A<string>._, A<string>._)).Throws(new IOException("disk full"));

        var refused = await store.SaveAsync("viewer", new LayoutSettings { Instrument = "MCL" }, 1, None);
        var read = await store.GetAsync("viewer", None);

        refused.Document.Revision.Should().Be(1);
        read.Revision.Should().Be(1, "memory is rolled back with the file");
        read.Layout.Instrument.Should().Be("MGC");
    }

    [Fact]
    public async Task SaveAsync_ShouldLeaveNothingSaved_WhenAFirstSaveCannotBeWritten()
    {
        var disk = new LayoutDisk();
        A.CallTo(() => disk.FileSystem.WriteAsync(A<string>._, A<string>._, A<CancellationToken>._)).Throws(new IOException("disk full"));
        var store = disk.Store();

        await store.SaveAsync("viewer", Planned(), 0, None);
        var read = await store.GetAsync("viewer", None);

        read.Saved.Should().BeFalse();
        read.Revision.Should().Be(0);
    }

    [Fact]
    public async Task GetAsync_ShouldServeTheEarlierRevision_WhenTheApiRestartsAfterAFailedWrite()
    {
        var disk = new LayoutDisk();
        await disk.Store().SaveAsync("viewer", Planned(), 0, None);
        var failing = disk.Store();
        A.CallTo(() => disk.FileSystem.WriteAsync(A<string>._, A<string>._, A<CancellationToken>._)).Throws(new IOException("disk full"));
        await failing.SaveAsync("viewer", new LayoutSettings { Instrument = "MCL" }, 1, None);

        var restarted = await disk.Store().GetAsync("viewer", None);

        restarted.Revision.Should().Be(1, "the failed save was never acknowledged, so the client still cites revision 1");
        restarted.Layout.Instrument.Should().Be("MGC");
    }

    [Fact]
    public async Task SaveAsync_ShouldApplyTheResend_WhenTheStoreRecovers()
    {
        var disk = new LayoutDisk();
        var store = disk.Store();
        A.CallTo(() => disk.FileSystem.Replace(A<string>._, A<string>._)).Throws(new IOException("disk full")).Once();

        await store.SaveAsync("viewer", Planned(), 0, None);
        var resent = await store.SaveAsync("viewer", Planned(), 0, None);

        resent.Applied.Should().BeTrue("the client re-sends at the revision it cited, which is still the stored one");
        resent.Document.Revision.Should().Be(1);
    }

    [Fact]
    public async Task SaveAsync_ShouldWriteNothing_WhenTheRevisionDoesNotMatch()
    {
        var disk = new LayoutDisk();

        await disk.Store().SaveAsync("viewer", Planned(), 7, None);

        A.CallTo(() => disk.FileSystem.WriteAsync(A<string>._, A<string>._, A<CancellationToken>._)).MustNotHaveHappened();
        A.CallTo(() => disk.FileSystem.Replace(A<string>._, A<string>._)).MustNotHaveHappened();
    }

    [Fact]
    public async Task SaveAsync_ShouldStoreOnlyTheVersionAndEachLayoutWithItsRevision_WhenASaveApplies()
    {
        var disk = new LayoutDisk();

        await disk.Store().SaveAsync("viewer", Planned(), 0, None);

        using var stored = JsonDocument.Parse(disk.Stored!);
        stored.RootElement.EnumerateObject().Select(p => p.Name).Should().Equal("version", "layouts");
        stored.RootElement.GetProperty("layouts").EnumerateObject().Select(p => p.Name).Should().Equal("viewer");
        stored.RootElement.GetProperty("layouts").GetProperty("viewer").EnumerateObject().Select(p => p.Name)
            .Should().Equal(["revision", "layout"], "no market state, flag or caller detail rides along");
    }

    private const string MovedAside = LayoutDisk.StorePath + ".corrupt-20261119T143005Z";

    [Theory]
    [InlineData("{not json")]
    [InlineData("""{"version":2,"layouts":{}}""")]
    public async Task SaveAsync_ShouldMoveTheCorruptFileAside_WhenItSavesOverIt(string corrupt)
    {
        var disk = new LayoutDisk();
        disk.Files[LayoutDisk.StorePath] = corrupt;

        await disk.Store().SaveAsync("viewer", Planned(), 0, None);

        disk.Files.Should().ContainKey(MovedAside).WhoseValue.Should().Be(corrupt);
        (await disk.Store().GetAsync("viewer", None)).Revision.Should().Be(1, "the store file is the new save");
    }

    [Fact]
    public async Task SaveAsync_ShouldLogTheMove_WhenItMovesACorruptFileAside()
    {
        var disk = new LayoutDisk();
        disk.Files[LayoutDisk.StorePath] = "{not json";

        await disk.Store().SaveAsync("viewer", Planned(), 0, None);

        disk.Warnings.Should().Be(2, "one for the corrupt file at load and one for moving it aside");
    }

    [Fact]
    public async Task SaveAsync_ShouldMoveTheFileAside_WhenAStoredLayoutWasDropped()
    {
        var disk = new LayoutDisk();
        var text = File(""" "bob":{"revision":0,"layout":{}},"alice":{"revision":4,"layout":{"instrument":"MGC"}} """);
        disk.Files[LayoutDisk.StorePath] = text;

        await disk.Store().SaveAsync("alice", Planned(), 4, None);

        disk.Files.Should().ContainKey(MovedAside).WhoseValue.Should().Be(text, "the dropped entry is kept for the maintainer");
    }

    [Fact]
    public async Task SaveAsync_ShouldMoveTheUnreadableFileAside_WhenItSavesOverIt()
    {
        var disk = new LayoutDisk();
        disk.Files[LayoutDisk.StorePath] = "unreadable";
        A.CallTo(() => disk.FileSystem.ReadAsync(A<string>._, A<CancellationToken>._)).Throws(new IOException("locked"));

        await disk.Store().SaveAsync("viewer", Planned(), 0, None);

        disk.Files.Should().ContainKey(MovedAside).WhoseValue.Should().Be("unreadable");
    }

    [Fact]
    public async Task SaveAsync_ShouldMoveAsideOnlyOnce_WhenSavesFollowACorruptFile()
    {
        var disk = new LayoutDisk();
        disk.Files[LayoutDisk.StorePath] = "{not json";
        var store = disk.Store();

        await store.SaveAsync("viewer", Planned(), 0, None);
        disk.Clock.Advance(TimeSpan.FromMinutes(1));
        await store.SaveAsync("viewer", Planned(), 1, None);

        A.CallTo(() => disk.FileSystem.Move(A<string>._, A<string>._)).MustHaveHappenedOnceExactly();
    }

    [Fact]
    public async Task SaveAsync_ShouldLeaveTheCorruptFileInPlace_WhenItCannotBeMovedAside()
    {
        var disk = new LayoutDisk();
        disk.Files[LayoutDisk.StorePath] = "{not json";
        A.CallTo(() => disk.FileSystem.Move(A<string>._, A<string>._)).Throws(new IOException("read-only"));
        var store = disk.Store();

        var saved = await store.SaveAsync("viewer", Planned(), 0, None);
        await store.SaveAsync("viewer", Planned(), 0, None);

        disk.Stored.Should().Be("{not json", "a file that could not be kept is never overwritten, on any later save either");
        A.CallTo(() => disk.FileSystem.Replace(A<string>._, A<string>._)).MustNotHaveHappened();
        saved.StoreFailed.Should().BeTrue("a save that could not be written is refused");
        disk.Errors.Should().Be(2, "each save tries the move again and logs that it could not");
    }

    [Theory]
    [InlineData(null)]
    [InlineData(""" {"version":1,"layouts":{"alice":{"revision":4,"layout":{}}}} """)]
    public async Task SaveAsync_ShouldMoveNothing_WhenTheStoreFileWasMissingOrValid(string? text)
    {
        var disk = new LayoutDisk();
        if (text is not null)
        {
            disk.Files[LayoutDisk.StorePath] = text;
        }

        await disk.Store().SaveAsync("viewer", Planned(), 0, None);

        A.CallTo(() => disk.FileSystem.Move(A<string>._, A<string>._)).MustNotHaveHappened();
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public async Task SaveAsync_ShouldTouchNoFile_WhenTheStorePathIsBlank(string path)
    {
        var disk = new LayoutDisk();
        var store = disk.Store(path);

        var saved = await store.SaveAsync("viewer", Planned(), 0, None);
        var read = await store.GetAsync("viewer", None);

        saved.Applied.Should().BeTrue();
        read.Revision.Should().Be(1);
        Fake.GetCalls(disk.FileSystem).Should().BeEmpty();
        disk.Warnings.Should().Be(0);
    }

    [Fact]
    public async Task GetAsync_ShouldReportUnsaved_WhenAMemoryOnlyStoreRestarts()
    {
        var disk = new LayoutDisk();
        await disk.Store(string.Empty).SaveAsync("viewer", Planned(), 0, None);

        var after = await disk.Store(string.Empty).GetAsync("viewer", None);

        after.Saved.Should().BeFalse();
        after.Revision.Should().Be(0);
    }

    [GeneratedRegex("key|secret|token|password|credential|sha|hash|grant|auth", RegexOptions.IgnoreCase)]
    private static partial Regex SecretName();

    [Fact]
    public async Task SaveAsync_ShouldStoreNoSecretField_WhenASaveApplies()
    {
        var disk = new LayoutDisk();

        await disk.Store().SaveAsync("viewer", Planned(), 0, None);

        using var stored = JsonDocument.Parse(disk.Stored!);
        Names(stored.RootElement).Should().NotBeEmpty().And.NotContain(name => SecretName().IsMatch(name));
    }

    private static IEnumerable<string> Names(JsonElement element) => element.ValueKind switch
    {
        JsonValueKind.Object => element.EnumerateObject().SelectMany(p => Names(p.Value).Prepend(p.Name)),
        JsonValueKind.Array => element.EnumerateArray().SelectMany(Names),
        _ => [],
    };
}
