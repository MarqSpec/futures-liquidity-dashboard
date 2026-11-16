using System.Diagnostics.CodeAnalysis;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace MarqSpec.FuturesLiquidityDashboard.Core.Instruments;

/// <summary>
/// A product root, for example <c>MES</c>, <c>MNQ</c> or <c>6E</c> (REQUIREMENTS.md FR-10; ARCHITECTURE.md D-26, D-28). Any
/// root the feed offers is valid, so this is an upper-case symbol of one to six letters or digits rather than a
/// fixed list: the instrument set comes from configuration and, on the ProjectX feed, from the gateway's contract
/// list. MES, MCL and MGC are the default tabs. Serialized as its plain string.
/// </summary>
[JsonConverter(typeof(InstrumentRootJsonConverter))]
public readonly record struct InstrumentRoot : IComparable<InstrumentRoot>
{
    public const int MaxLength = 6;

    private readonly string? _value;

    private InstrumentRoot(string value) => _value = value;

    /// <summary>E-mini S&amp;P 500 (CME).</summary>
    public static InstrumentRoot ES { get; } = new("ES");

    /// <summary>Gold (COMEX).</summary>
    public static InstrumentRoot GC { get; } = new("GC");

    /// <summary>Crude oil WTI (NYMEX).</summary>
    public static InstrumentRoot CL { get; } = new("CL");

    /// <summary>Micro E-mini S&amp;P 500 (CME). One of the three default tabs (ARCHITECTURE.md D-28).</summary>
    public static InstrumentRoot MES { get; } = new("MES");

    /// <summary>Micro WTI crude oil (NYMEX). One of the three default tabs (ARCHITECTURE.md D-28).</summary>
    public static InstrumentRoot MCL { get; } = new("MCL");

    /// <summary>Micro gold (COMEX). One of the three default tabs (ARCHITECTURE.md D-28).</summary>
    public static InstrumentRoot MGC { get; } = new("MGC");

    public string Value => _value ?? string.Empty;

    /// <summary>Parses a root case-insensitively; false for anything but one to six ASCII letters or digits.</summary>
    public static bool TryParse([NotNullWhen(true)] string? value, out InstrumentRoot root)
    {
        root = default;
        if (string.IsNullOrWhiteSpace(value) || value.Length > MaxLength)
        {
            return false;
        }

        foreach (var c in value)
        {
            if (!char.IsAsciiLetterOrDigit(c))
            {
                return false;
            }
        }

        root = new InstrumentRoot(value.ToUpperInvariant());
        return true;
    }

    /// <summary>Parses a root or throws <see cref="FormatException"/>.</summary>
    public static InstrumentRoot Parse(string value) =>
        TryParse(value, out var root) ? root : throw new FormatException($"'{value}' is not an instrument root (1-{MaxLength} letters or digits).");

    public int CompareTo(InstrumentRoot other) => string.CompareOrdinal(Value, other.Value);

    public static bool operator <(InstrumentRoot left, InstrumentRoot right) => left.CompareTo(right) < 0;

    public static bool operator <=(InstrumentRoot left, InstrumentRoot right) => left.CompareTo(right) <= 0;

    public static bool operator >(InstrumentRoot left, InstrumentRoot right) => left.CompareTo(right) > 0;

    public static bool operator >=(InstrumentRoot left, InstrumentRoot right) => left.CompareTo(right) >= 0;

    public override string ToString() => Value;

    /// <summary>A stable, process-independent hash (string.GetHashCode is randomized per process), for seeding.</summary>
    public int StableHash()
    {
        unchecked
        {
            var hash = (int)2166136261;
            foreach (var c in Value)
            {
                hash = (hash ^ c) * 16777619;
            }

            return hash & int.MaxValue;
        }
    }
}

/// <summary>Reads and writes an <see cref="InstrumentRoot"/> as its string.</summary>
public sealed class InstrumentRootJsonConverter : JsonConverter<InstrumentRoot>
{
    public override InstrumentRoot Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        InstrumentRoot.TryParse(reader.GetString(), out var root) ? root : throw new JsonException("Invalid instrument root.");

    public override void Write(Utf8JsonWriter writer, InstrumentRoot value, JsonSerializerOptions options)
    {
        ArgumentNullException.ThrowIfNull(writer);
        writer.WriteStringValue(value.Value);
    }

    public override InstrumentRoot ReadAsPropertyName(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        Read(ref reader, typeToConvert, options);

    public override void WriteAsPropertyName(Utf8JsonWriter writer, InstrumentRoot value, JsonSerializerOptions options)
    {
        ArgumentNullException.ThrowIfNull(writer);
        writer.WritePropertyName(value.Value);
    }
}
