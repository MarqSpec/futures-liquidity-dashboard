using MarqSpec.Client.ProjectX.Exceptions;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.ProjectX;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Ingestion;

// reference: MarqSpec.Client.ProjectX AuthenticationService messages; LoginErrorCode values
public sealed class ProjectXLoginGuardTests
{
    [Theory]
    [InlineData("Authentication failed with status code 400 (BadRequest). Please verify your API credentials.")]
    [InlineData("Authentication failed with status code 401 (Unauthorized). Please verify your API credentials.")]
    [InlineData("Authentication failed with status code 403 (Forbidden). Please verify your API credentials.")]
    [InlineData("Authentication failed: user not found (errorCode 1: UserNotFound)")]
    [InlineData("Authentication failed: bad password (errorCode 2: PasswordVerificationFailed)")]
    [InlineData("Authentication failed: invalid (errorCode 3: InvalidCredentials)")]
    [InlineData("Authentication failed: no app (errorCode 4: AppNotFound)")]
    [InlineData("Authentication failed: app check (errorCode 5: AppVerificationFailed)")]
    [InlineData("Authentication failed: device (errorCode 6: InvalidDevice)")]
    [InlineData("Authentication failed: agreements (errorCode 7: AgreementsNotSigned)")]
    [InlineData("Authentication failed: no subscription (errorCode 9: ApiSubscriptionNotFound)")]
    [InlineData("Authentication failed: key login off (errorCode 10: ApiKeyAuthenticationDisabled)")]
    public void IsRefused_ShouldBeTrue_WhenTheGatewayRefusesTheLogin(string message)
    {
        ProjectXLoginGuard.IsRefused(new AuthenticationException(message)).Should().BeTrue();
        ProjectXLoginGuard.IsRefused(new InvalidOperationException("wrapper", new AuthenticationException(message)))
            .Should().BeTrue("the client may wrap the login failure in the call that needed the token");
    }

    [Theory]
    [InlineData("Authentication failed with status code 429 (TooManyRequests). Please verify your API credentials.")]
    [InlineData("Authentication failed with status code 500 (InternalServerError). Please verify your API credentials.")]
    [InlineData("Authentication failed with status code 503 (ServiceUnavailable). Please verify your API credentials.")]
    [InlineData("Authentication failed: try later (errorCode 8: UnknownError)")]
    [InlineData("Authentication failed: new reason (errorCode 42: SomethingNew)")]
    [InlineData("Network error occurred during authentication. Please check your connection.")]
    [InlineData("Unexpected error occurred during authentication.")]
    [InlineData("")]
    public void IsRefused_ShouldBeFalse_WhenTheLoginFailureMayPassOnItsOwn(string message)
    {
        ProjectXLoginGuard.IsRefused(new AuthenticationException(message)).Should().BeFalse();
    }

    [Fact]
    public void IsRefused_ShouldBeFalse_WhenTheFailureIsNotALoginFailure()
    {
        ProjectXLoginGuard.IsRefused(new InvalidOperationException("status code 401 (errorCode 3: InvalidCredentials)"))
            .Should().BeFalse("only the client's authentication exception says the login itself was refused");
        ProjectXLoginGuard.IsRefused(null).Should().BeFalse();
    }
}
