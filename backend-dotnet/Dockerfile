# --- Build stage ---
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src

# Restore first for layer caching.
COPY TranscribeApi.csproj ./
RUN dotnet restore TranscribeApi.csproj

# Build + publish.
COPY . ./
RUN dotnet publish TranscribeApi.csproj -c Release -o /app --no-restore

# --- Runtime stage ---
FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS runtime
WORKDIR /app

COPY --from=build /app ./

ENV DOTNET_PORT=8080
EXPOSE 8080

ENTRYPOINT ["dotnet", "TranscribeApi.dll"]
