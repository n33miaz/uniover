# Imagem única: PWA (Angular) servido pela API (.NET) a partir do wwwroot.
# As bases são fixadas por digest; o Dependabot (ecossistema docker) propõe as atualizações.

# --- Etapa 1: build do PWA ---
FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS web
WORKDIR /src/apps/web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web/ ./
RUN npm run build

# --- Etapa 2: publicação da API ---
FROM mcr.microsoft.com/dotnet/sdk:10.0@sha256:de4fe90a98845d75910b9769662465c84de1a934665c431279d1382b2bddc02b AS api
WORKDIR /src
# Os esquemas do agente são embutidos no assembly do protocolo.
COPY contracts/agent/ contracts/agent/
# As versões por módulo são embutidas no assembly (GET /health/version).
COPY modules.json modules.json
COPY apps/api/ apps/api/
RUN dotnet publish apps/api/src/UniOver.Host -c Release -o /out \
    && rm -rf /out/wwwroot

# --- Etapa 3: runtime mínimo, sem shell, usuário não root ---
FROM mcr.microsoft.com/dotnet/aspnet:10.0-noble-chiseled@sha256:c89a6a61f494f20a5ae302990e814627a8d91b332fd4a8e7c1707c2d4da9555d AS final
# O Host lê wwwroot e appsettings.json do diretório atual.
WORKDIR /app
COPY --from=api /out ./
COPY --from=web /src/apps/web/dist/web/browser ./wwwroot
ENV PORT=10000
EXPOSE 10000
USER $APP_UID
ENTRYPOINT ["dotnet", "UniOver.Host.dll"]
