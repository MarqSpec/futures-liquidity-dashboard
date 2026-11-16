using System.Collections;
using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using System.Reflection;
using System.Text;

namespace MarqSpec.FuturesLiquidityDashboard.Api.Auth;

/// <summary>
/// Applies <see cref="SecretRedactor"/> to structured state, scopes and exception text.
/// A clean value keeps its type. A value is replaced only when the text would still carry a secret.
/// </summary>
internal static class SecretLogRedaction
{
    private const string RedactedValue = "[redacted]";
    private const int MaxDepth = 8;
    private const int MaxSequenceItems = 256;
    private const int MinStrippedLength = 8;

    internal static string Render(object? value)
    {
        if (value is null)
        {
            return string.Empty;
        }

        if (value is string text)
        {
            return text;
        }

        try
        {
            return value.ToString() ?? string.Empty;
        }
        catch (Exception)
        {
            return string.Empty;
        }
    }

    internal static object Scope<TState>(TState state)
        where TState : notnull
    {
        if (state is string text)
        {
            var redacted = SecretRedactor.Redact(text);
            return string.Equals(redacted, text, StringComparison.Ordinal) ? text : redacted;
        }

        var original = Render(state);
        var redactedText = SecretRedactor.Redact(original);
        if (TryState(state, original, redactedText, out var structured))
        {
            return structured;
        }

        if (!string.Equals(redactedText, original, StringComparison.Ordinal))
        {
            return redactedText;
        }

        return state;
    }

    internal static bool TryState(
        object? state,
        string originalMessage,
        string redactedMessage,
        [NotNullWhen(true)] out RedactedLogState? redacted)
    {
        redacted = null;
        if (state is null || state is string)
        {
            return false;
        }

        var read = ReadPairs(state);
        if (read.Kind == PairKind.Failed)
        {
            redacted = new RedactedLogState([], redactedMessage);
            return true;
        }

        if (read.Kind == PairKind.None)
        {
            return false;
        }

        var changed = !string.Equals(originalMessage, redactedMessage, StringComparison.Ordinal);
        var items = RedactPairs(read.Items, originalMessage, redactedMessage, [], 0, ref changed);
        if (!changed)
        {
            return false;
        }

        redacted = new RedactedLogState(items, Scrub(redactedMessage, read.Items, items));
        return true;
    }

    internal static Exception? RedactException(Exception? exception)
    {
        if (exception is null)
        {
            return null;
        }

        return WalkException(exception, [], 0);
    }

    private static KeyValuePair<string, object?>[] RedactPairs(
        KeyValuePair<string, object?>[] items,
        string originalMessage,
        string redactedMessage,
        HashSet<object> seen,
        int depth,
        ref bool changed)
    {
        var redacted = new KeyValuePair<string, object?>[items.Length];
        for (var i = 0; i < items.Length; i++)
        {
            var pair = items[i];
            var key = SecretRedactor.Redact(pair.Key);
            if (!string.Equals(key, pair.Key, StringComparison.Ordinal))
            {
                changed = true;
            }

            var value = RedactValue(pair.Value, pair.Key, originalMessage, redactedMessage, seen, depth, ref changed);
            redacted[i] = new KeyValuePair<string, object?>(key, value);
        }

        return redacted;
    }

    private static object? RedactValue(
        object? value,
        string key,
        string originalMessage,
        string redactedMessage,
        HashSet<object> seen,
        int depth,
        ref bool changed)
    {
        if (value is null)
        {
            return null;
        }

        if (value is SequenceTail tail)
        {
            return RedactTail(tail, key, originalMessage, redactedMessage, ref changed);
        }

        if (value is string text)
        {
            var redacted = RedactString(text, originalMessage, redactedMessage);
            if (string.Equals(redacted, text, StringComparison.Ordinal) && SecretInPair(key, text))
            {
                changed = true;
                return RedactedValue;
            }

            if (!string.Equals(redacted, text, StringComparison.Ordinal))
            {
                changed = true;
            }

            return redacted;
        }

        if (value is Exception exception)
        {
            var redactedException = WalkException(exception, [], depth + 1);
            if (!ReferenceEquals(redactedException, exception))
            {
                changed = true;
            }

            return redactedException;
        }

        // A cycle or a walk past the cap must not hand the original object back: its properties were not redacted.
        // Value types use value equality, so they are not tracked; two boxed copies are not a cycle.
        if (depth > MaxDepth || (!value.GetType().IsValueType && !seen.Add(value)))
        {
            return RedactUnwalked(value, key, originalMessage, redactedMessage, ref changed);
        }

        var nested = ReadPairs(value);
        if (nested.Kind == PairKind.Yes)
        {
            var nestedChanged = false;
            var items = RedactPairs(nested.Items, originalMessage, redactedMessage, seen, depth + 1, ref nestedChanged);
            if (nestedChanged)
            {
                changed = true;
                var nestedText = Render(value);
                return new RedactedLogState(items, Scrub(SecretRedactor.Redact(nestedText), nested.Items, items));
            }
        }

        var rendered = Render(value);
        if (rendered.Length == 0)
        {
            return value;
        }

        var redactedRendered = RedactString(rendered, originalMessage, redactedMessage);
        if (!string.Equals(redactedRendered, rendered, StringComparison.Ordinal))
        {
            changed = true;
            return redactedRendered;
        }

        if (SecretInPair(key, rendered))
        {
            changed = true;
            return RedactedValue;
        }

        return value;
    }

    private static string RedactString(string text, string originalMessage, string redactedMessage)
    {
        var redacted = SecretRedactor.Redact(text);
        if (!string.Equals(redacted, text, StringComparison.Ordinal))
        {
            return redacted;
        }

        return WasStripped(originalMessage, redactedMessage, text) ? RedactedValue : text;
    }

    private static string RedactUnwalked(object value, string key, string originalMessage, string redactedMessage, ref bool changed)
    {
        // A capped walk's ToString can be `{ access_token = key }`; SecretRedactor accepts the spaces.
        var rendered = Render(value);
        var redacted = RedactString(rendered, originalMessage, redactedMessage);
        if (string.Equals(redacted, rendered, StringComparison.Ordinal) && SecretInPair(key, rendered))
        {
            changed = true;
            return RedactedValue;
        }

        changed = true;
        return redacted;
    }

    private static string RedactTail(SequenceTail tail, string key, string originalMessage, string redactedMessage, ref bool changed)
    {
        var text = new StringBuilder();
        foreach (var item in tail.Items)
        {
            if (item is null)
            {
                continue;
            }

            text.Append(RedactUnwalked(item, key, originalMessage, redactedMessage, ref changed));
        }

        // The tail objects themselves must not be logged, even when their text had no secret.
        changed = true;
        return text.ToString();
    }

    private static string Scrub(string message, KeyValuePair<string, object?>[] original, KeyValuePair<string, object?>[] redacted)
    {
        var text = message;
        var count = Math.Min(original.Length, redacted.Length);
        for (var i = 0; i < count; i++)
        {
            if (original[i].Value is not string raw || raw.Length < MinStrippedLength)
            {
                continue;
            }

            if (redacted[i].Value is not string cleaned || string.Equals(cleaned, raw, StringComparison.Ordinal))
            {
                continue;
            }

            text = ReplaceBounded(text, raw, cleaned);
        }

        return text;
    }

    private static string ReplaceBounded(string text, string value, string replacement)
    {
        if (!text.Contains(value, StringComparison.Ordinal))
        {
            return text;
        }

        var result = new StringBuilder(text.Length);
        var index = 0;
        while (index < text.Length)
        {
            var found = text.IndexOf(value, index, StringComparison.Ordinal);
            if (found < 0)
            {
                result.Append(text, index, text.Length - index);
                break;
            }

            var before = found == 0 || !IsTokenChar(text[found - 1]);
            var end = found + value.Length;
            var after = end >= text.Length || !IsTokenChar(text[end]);
            if (before && after)
            {
                result.Append(text, index, found - index);
                result.Append(replacement);
                index = end;
                continue;
            }

            result.Append(text, index, found - index + 1);
            index = found + 1;
        }

        return result.ToString();
    }

    private static bool SecretInPair(string key, string value)
    {
        if (value.Length == 0)
        {
            return false;
        }

        var asQuery = key + "=" + value;
        var asHeader = key + ": " + value;
        return !string.Equals(SecretRedactor.Redact(asQuery), asQuery, StringComparison.Ordinal)
            || !string.Equals(SecretRedactor.Redact(asHeader), asHeader, StringComparison.Ordinal);
    }

    private static bool WasStripped(string original, string redacted, string value)
    {
        if (value.Length < MinStrippedLength || string.Equals(original, redacted, StringComparison.Ordinal))
        {
            return false;
        }

        return Bounded(original, value) && !redacted.Contains(value, StringComparison.Ordinal);
    }

    private static bool Bounded(string text, string value)
    {
        var index = 0;
        while ((index = text.IndexOf(value, index, StringComparison.Ordinal)) >= 0)
        {
            var before = index == 0 || !IsTokenChar(text[index - 1]);
            var end = index + value.Length;
            var after = end >= text.Length || !IsTokenChar(text[end]);
            if (before && after)
            {
                return true;
            }

            index = end;
        }

        return false;
    }

    private static bool IsTokenChar(char c) => char.IsAsciiLetterOrDigit(c) || c is '_' or '-' or '.';

    private static PairList ReadPairs(object state)
    {
        try
        {
            if (state is IReadOnlyList<KeyValuePair<string, object?>> list)
            {
                var items = new KeyValuePair<string, object?>[list.Count];
                for (var i = 0; i < list.Count; i++)
                {
                    items[i] = list[i];
                }

                return PairList.Ok(items);
            }

            if (state is IEnumerable<KeyValuePair<string, object?>> pairs)
            {
                return PairList.Ok(Copy(pairs));
            }

            if (state is IEnumerable<KeyValuePair<string, string>> stringPairs)
            {
                var buffer = new List<KeyValuePair<string, object?>>();
                foreach (var pair in stringPairs)
                {
                    buffer.Add(new KeyValuePair<string, object?>(pair.Key, pair.Value));
                }

                return PairList.Ok(buffer.ToArray());
            }

            if (state is IDictionary dictionary)
            {
                var buffer = new List<KeyValuePair<string, object?>>();
                foreach (DictionaryEntry entry in dictionary)
                {
                    buffer.Add(new KeyValuePair<string, object?>(Render(entry.Key), entry.Value));
                }

                return PairList.Ok(buffer.ToArray());
            }

            // ReadProperties skips indexers, so a string[] or List<string> would otherwise keep its elements.
            // Char and byte sequences stay on the ToString path. Past the cap, the rest is a SequenceTail:
            // RedactValue runs RedactUnwalked on it instead of walking every element.
            if (state is IEnumerable enumerable and not string and not IEnumerable<char> and not IEnumerable<byte>)
            {
                var buffer = new List<KeyValuePair<string, object?>>();
                List<object?>? tail = null;
                var index = 0;
                foreach (var item in enumerable)
                {
                    if (index >= MaxSequenceItems)
                    {
                        tail ??= [];
                        tail.Add(item);
                        continue;
                    }

                    buffer.Add(new KeyValuePair<string, object?>(index.ToString(CultureInfo.InvariantCulture), item));
                    index++;
                }

                if (tail is not null)
                {
                    buffer.Add(new KeyValuePair<string, object?>("more", new SequenceTail(tail)));
                }

                return buffer.Count == 0 ? PairList.Empty() : PairList.Ok(buffer.ToArray());
            }

            return ReadProperties(state);
        }
        catch (Exception)
        {
            return PairList.Fail();
        }
    }

    private static KeyValuePair<string, object?>[] Copy(IEnumerable<KeyValuePair<string, object?>> pairs)
    {
        var buffer = new List<KeyValuePair<string, object?>>();
        foreach (var pair in pairs)
        {
            buffer.Add(pair);
        }

        return buffer.ToArray();
    }

    private static PairList ReadProperties(object state)
    {
        var type = state.GetType();
        if (type.IsPrimitive || type.IsEnum)
        {
            return PairList.Empty();
        }

        PropertyInfo[] properties;
        try
        {
            properties = type.GetProperties(BindingFlags.Instance | BindingFlags.Public);
        }
        catch (Exception)
        {
            return PairList.Empty();
        }

        if (properties.Length == 0)
        {
            return PairList.Empty();
        }

        var buffer = new List<KeyValuePair<string, object?>>(properties.Length);
        foreach (var property in properties)
        {
            if (!property.CanRead || property.GetIndexParameters().Length > 0)
            {
                continue;
            }

            try
            {
                buffer.Add(new KeyValuePair<string, object?>(property.Name, property.GetValue(state)));
            }
            catch (Exception)
            {
                // One getter must not hide the other properties or fail the log call.
            }
        }

        return buffer.Count == 0 ? PairList.Empty() : PairList.Ok(buffer.ToArray());
    }

    private static Exception WalkException(Exception exception, HashSet<Exception> seen, int depth)
    {
        if (!seen.Add(exception))
        {
            return Terminal(exception);
        }

        if (depth > MaxDepth)
        {
            var limitedMessage = Read(() => exception.Message);
            var limitedText = Read(() => exception.ToString());
            return new RedactedException(limitedMessage.Value ?? string.Empty, null, null, limitedText.Value ?? string.Empty);
        }

        var message = Read(() => exception.Message);
        var text = Read(() => exception.ToString());
        var stack = Read(() => exception.StackTrace);
        var help = Read(() => exception.HelpLink);
        var source = Read(() => exception.Source);
        var (inners, innersChanged) = RedactInners(exception, seen, depth);
        var (data, dataChanged) = ReadData(exception, seen, depth);
        var changed = message.Changed || text.Changed || stack.Changed || help.Changed || source.Changed || innersChanged || dataChanged
            || message.Threw || text.Threw || stack.Threw || help.Threw || source.Threw;
        if (!changed)
        {
            return exception;
        }

        Exception redacted = exception is AggregateException
            ? new RedactedAggregateException(message.Value ?? string.Empty, inners, stack.Threw ? null : stack.Value, text.Value ?? string.Empty)
            : new RedactedException(message.Value ?? string.Empty, inners.Length == 0 ? null : inners[0], stack.Threw ? null : stack.Value, text.Value ?? string.Empty);
        CopyDetails(exception, redacted, data, help.Threw ? null : help.Value, source.Threw ? null : source.Value);
        return redacted;
    }

    private static RedactedException Terminal(Exception exception)
    {
        var message = Read(() => exception.Message);
        var text = Read(() => exception.ToString());
        return new RedactedException(message.Value ?? string.Empty, null, null, text.Value ?? string.Empty);
    }

    private static (Exception[] Inners, bool Changed) RedactInners(Exception exception, HashSet<Exception> seen, int depth)
    {
        if (exception is AggregateException aggregate)
        {
            Exception[] originals;
            try
            {
                originals = new Exception[aggregate.InnerExceptions.Count];
                for (var i = 0; i < originals.Length; i++)
                {
                    originals[i] = aggregate.InnerExceptions[i];
                }
            }
            catch (Exception)
            {
                return ([], true);
            }

            var changed = false;
            var redacted = new List<Exception>(originals.Length);
            foreach (var inner in originals)
            {
                if (inner is null)
                {
                    changed = true;
                    continue;
                }

                var replacement = WalkException(inner, seen, depth + 1);
                redacted.Add(replacement);
                if (!ReferenceEquals(replacement, inner))
                {
                    changed = true;
                }
            }

            return (redacted.ToArray(), changed);
        }

        Exception? single;
        try
        {
            single = exception.InnerException;
        }
        catch (Exception)
        {
            return ([], true);
        }

        if (single is null)
        {
            return ([], false);
        }

        var redactedSingle = WalkException(single, seen, depth + 1);
        return ([redactedSingle], !ReferenceEquals(redactedSingle, single));
    }

    private static (List<DictionaryEntry>? Entries, bool Changed) ReadData(Exception exception, HashSet<Exception> seen, int depth)
    {
        IDictionary data;
        try
        {
            data = exception.Data;
        }
        catch (Exception)
        {
            return (null, true);
        }

        var entries = new List<DictionaryEntry>();
        var changed = false;
        try
        {
            foreach (DictionaryEntry entry in data)
            {
                var keyText = entry.Key as string ?? Render(entry.Key);
                var key = RedactDataKey(entry.Key, ref changed);
                var value = RedactDataValue(keyText, entry.Value, seen, depth, ref changed);
                entries.Add(new DictionaryEntry(key, value));
            }
        }
        catch (Exception)
        {
            changed = true;
        }

        return (entries, changed);
    }

    private static object RedactDataKey(object key, ref bool changed)
    {
        if (key is string text)
        {
            var redacted = SecretRedactor.Redact(text);
            if (!string.Equals(redacted, text, StringComparison.Ordinal))
            {
                changed = true;
                return redacted;
            }

            return text;
        }

        var rendered = Render(key);
        var redactedRendered = SecretRedactor.Redact(rendered);
        if (!string.Equals(redactedRendered, rendered, StringComparison.Ordinal))
        {
            changed = true;
            return redactedRendered;
        }

        return key;
    }

    private static object? RedactDataValue(string key, object? value, HashSet<Exception> seen, int depth, ref bool changed)
    {
        if (value is null)
        {
            return null;
        }

        if (value is string text)
        {
            var redacted = SecretRedactor.Redact(text);
            if (string.Equals(redacted, text, StringComparison.Ordinal) && SecretInPair(key, text))
            {
                changed = true;
                return RedactedValue;
            }

            if (!string.Equals(redacted, text, StringComparison.Ordinal))
            {
                changed = true;
            }

            return redacted;
        }

        if (value is Exception exception)
        {
            var redactedException = WalkException(exception, seen, depth + 1);
            if (!ReferenceEquals(redactedException, exception))
            {
                changed = true;
            }

            return redactedException;
        }

        if (!CanRender(value))
        {
            changed = true;
            return string.Empty;
        }

        // Nested bags and lists are walked, not flattened through ToString. A throwing render stays empty above.
        var objects = new HashSet<object>();
        var original = Render(value);
        var redactedText = SecretRedactor.Redact(original);
        return RedactValue(value, key, original, redactedText, objects, depth, ref changed);
    }

    private static bool CanRender(object value)
    {
        try
        {
            _ = value.ToString();
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }

    private static void CopyDetails(Exception source, Exception target, List<DictionaryEntry>? data, string? helpLink, string? sourceName)
    {
        Try(() => target.HResult = source.HResult);
        Try(() => target.HelpLink = helpLink);
        Try(() => target.Source = sourceName);
        if (data is null)
        {
            return;
        }

        Try(() =>
        {
            foreach (var entry in data)
            {
                target.Data[entry.Key] = entry.Value;
            }
        });
    }

    private static void Try(Action action)
    {
        try
        {
            action();
        }
        catch (Exception)
        {
            // A hostile exception property must not stop the log call.
        }
    }

    private static ReadText Read(Func<string?> read)
    {
        try
        {
            var value = read();
            if (value is null)
            {
                return default;
            }

            var redacted = SecretRedactor.Redact(value);
            return new ReadText(redacted, !string.Equals(redacted, value, StringComparison.Ordinal), false);
        }
        catch (Exception)
        {
            return new ReadText(string.Empty, true, true);
        }
    }

    private readonly record struct ReadText(string? Value, bool Changed, bool Threw);

    private sealed class SequenceTail(List<object?> items)
    {
        public List<object?> Items { get; } = items;
    }

    private enum PairKind
    {
        None,
        Yes,
        Failed,
    }

    private readonly struct PairList
    {
        private PairList(PairKind kind, KeyValuePair<string, object?>[] items)
        {
            Kind = kind;
            Items = items;
        }

        public PairKind Kind { get; }

        public KeyValuePair<string, object?>[] Items { get; }

        public static PairList Ok(KeyValuePair<string, object?>[] items) => new(PairKind.Yes, items);

        public static PairList Fail() => new(PairKind.Failed, []);

        public static PairList Empty() => new(PairKind.None, []);
    }

    // Exception.Message cannot be changed in place. The logged object is this stand-in, not the original CLR type.
    // Its text keeps the original type name and stack frames with the secret removed.
    private sealed class RedactedException : Exception
    {
        private readonly string _message;
        private readonly string? _stackTrace;
        private readonly string _text;

        public RedactedException(string message, Exception? inner, string? stackTrace, string text)
            : base(message, inner)
        {
            _message = message;
            _stackTrace = stackTrace;
            _text = text;
        }

        public override string Message => _message;

        public override string? StackTrace => _stackTrace;

        public override string ToString() => _text;
    }

    private sealed class RedactedAggregateException : AggregateException
    {
        private readonly string _message;
        private readonly string? _stackTrace;
        private readonly string _text;

        public RedactedAggregateException(string message, Exception[] inners, string? stackTrace, string text)
            : base(message, inners)
        {
            _message = message;
            _stackTrace = stackTrace;
            _text = text;
        }

        public override string Message => _message;

        public override string? StackTrace => _stackTrace;

        public override string ToString() => _text;
    }
}

/// <summary>Structured log state whose values and rendered text have passed through <see cref="SecretRedactor"/>.</summary>
internal sealed class RedactedLogState : IReadOnlyList<KeyValuePair<string, object?>>
{
    private readonly KeyValuePair<string, object?>[] _items;

    public RedactedLogState(KeyValuePair<string, object?>[] items, string formatted)
    {
        _items = items;
        Formatted = formatted;
    }

    public string Formatted { get; }

    public int Count => _items.Length;

    public KeyValuePair<string, object?> this[int index] => _items[index];

    public override string ToString() => Formatted;

    public IEnumerator<KeyValuePair<string, object?>> GetEnumerator() => ((IEnumerable<KeyValuePair<string, object?>>)_items).GetEnumerator();

    IEnumerator IEnumerable.GetEnumerator() => _items.GetEnumerator();
}
