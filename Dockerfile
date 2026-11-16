# syntax=docker/dockerfile:1
#
# Live Futures Liquidity Dashboard — MarqSpec.FuturesLiquidityDashboard.Api image. Tracked by SemVer tags only: :X.Y.Z, plus the moving :staging and :production
# (DEPLOYMENT.md, *Promotion flow*). VERSION is passed by the workflows.
#   docker build -t futuresliquiditydashboard.api:dev -f Dockerfile .
#   docker build --target test -f Dockerfile .

# Matches global.json so the container builds with the same SDK as developers and CI.
ARG DOTNET_SDK_VERSION=10.0.301

FROM mcr.microsoft.com/dotnet/sdk:${DOTNET_SDK_VERSION} AS build
WORKDIR /repo

# Restore from project files first, so the layer is cached until a dependency changes. .editorconfig comes with
# the props: it holds the analyzer and code-style severities, so the image and its test stage build as strictly
# as a local build does.
COPY .editorconfig global.json Directory.Build.props Directory.Packages.props ./
COPY src/*.slnx src/
COPY src/MarqSpec.FuturesLiquidityDashboard.Api/MarqSpec.FuturesLiquidityDashboard.Api.csproj src/MarqSpec.FuturesLiquidityDashboard.Api/
COPY src/MarqSpec.FuturesLiquidityDashboard.Ingestion/MarqSpec.FuturesLiquidityDashboard.Ingestion.csproj src/MarqSpec.FuturesLiquidityDashboard.Ingestion/
COPY src/MarqSpec.FuturesLiquidityDashboard.Core/MarqSpec.FuturesLiquidityDashboard.Core.csproj src/MarqSpec.FuturesLiquidityDashboard.Core/
COPY src/tests/MarqSpec.FuturesLiquidityDashboard.UnitTests/MarqSpec.FuturesLiquidityDashboard.UnitTests.csproj src/tests/MarqSpec.FuturesLiquidityDashboard.UnitTests/
COPY src/tests/MarqSpec.FuturesLiquidityDashboard.IntegrationTests/MarqSpec.FuturesLiquidityDashboard.IntegrationTests.csproj src/tests/MarqSpec.FuturesLiquidityDashboard.IntegrationTests/
RUN dotnet restore src/MarqSpec.FuturesLiquidityDashboard.Api/MarqSpec.FuturesLiquidityDashboard.Api.csproj \
 && dotnet restore src/tests/MarqSpec.FuturesLiquidityDashboard.UnitTests/MarqSpec.FuturesLiquidityDashboard.UnitTests.csproj

COPY src/ src/
RUN dotnet publish src/MarqSpec.FuturesLiquidityDashboard.Api/MarqSpec.FuturesLiquidityDashboard.Api.csproj -c Release --no-restore -o /app

# Unit tier (CONVENTIONS.md §8.1): `docker build --target test .`
FROM build AS test
RUN dotnet test src/tests/MarqSpec.FuturesLiquidityDashboard.UnitTests/MarqSpec.FuturesLiquidityDashboard.UnitTests.csproj -c Release --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
ARG VERSION=0.0.0-dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="MarqSpec.FuturesLiquidityDashboard.Api" \
      org.opencontainers.image.source="https://github.com/MarqSpec/futures-liquidity-dashboard" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
WORKDIR /app
COPY --from=build /app ./
# The base image's non-root user.
USER $APP_UID
EXPOSE 8080
ENTRYPOINT ["dotnet", "MarqSpec.FuturesLiquidityDashboard.Api.dll"]
