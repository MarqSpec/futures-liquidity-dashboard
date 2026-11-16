using System.Globalization;
using System.Text.RegularExpressions;
using MarqSpec.Client.ProjectX.Exceptions;

namespace MarqSpec.FuturesLiquidityDashboard.Ingestion.ProjectX;

/// <summary>
/// Tells a login the gateway refused (bad or disabled credentials, no API subscription) from one that may pass on
/// a retry (a network fault, a rate limit, a server error). The client library throws
/// <see cref="AuthenticationException"/> for both and tells them apart only in the message, so this reads the HTTP
/// status or the gateway's <c>errorCode</c> from it. Anything it does not recognise counts as transient.
/// </summary>
public static partial class ProjectXLoginGuard
{
    // LoginErrorCode: 1 UserNotFound, 2 PasswordVerificationFailed, 3 InvalidCredentials, 4 AppNotFound,
    // 5 AppVerificationFailed, 6 InvalidDevice, 7 AgreementsNotSigned, 9 ApiSubscriptionNotFound,
    // 10 ApiKeyAuthenticationDisabled. 8 UnknownError may pass, so it is not here.
    private static readonly HashSet<int> RefusedCodes = [1, 2, 3, 4, 5, 6, 7, 9, 10];

    public static bool IsRefused(Exception? exception)
    {
        for (var current = exception; current is not null; current = current.InnerException)
        {
            if (current is AuthenticationException && IsRefused(current.Message))
            {
                return true;
            }
        }

        return false;
    }

    private static bool IsRefused(string message)
    {
        var status = HttpStatus().Match(message);
        if (status.Success)
        {
            var code = int.Parse(status.Groups["status"].Value, CultureInfo.InvariantCulture);
            return code is 400 or 401 or 403;
        }

        var error = ErrorCode().Match(message);
        return error.Success
            && int.TryParse(error.Groups["code"].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var value)
            && RefusedCodes.Contains(value);
    }

    [GeneratedRegex(@"status code (?<status>[0-9]{3})\b", RegexOptions.CultureInvariant, 1000)]
    private static partial Regex HttpStatus();

    [GeneratedRegex(@"\(errorCode (?<code>[0-9]{1,9})\b", RegexOptions.CultureInvariant, 1000)]
    private static partial Regex ErrorCode();
}
