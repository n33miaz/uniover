# Imagem única: PWA (Angular) servido pela API (.NET) a partir do wwwroot.
# As bases são fixadas por digest; o Dependabot (ecossistema docker) propõe as atualizações.

# --- Etapa 1: build do PWA ---
FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS web
WORKDIR /src/apps/web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web/ ./
RUN npm run build

# --- Etapa 2: publicação da API ---
FROM mcr.microsoft.com/dotnet/sdk:10.0@sha256:0d99ebf1ccad15037b5c98c9fe8979d6b8dbac23812feae2277a0b277b5c5ffa AS api
WORKDIR /src
# Os esquemas do agente são embutidos no assembly do protocolo.
COPY contracts/agent/ contracts/agent/
COPY apps/api/ apps/api/
RUN dotnet publish apps/api/src/UniOver.Host -c Release -o /out \
    && rm -rf /out/wwwroot

# --- Etapa 3: runtime mínimo, sem shell, usuário não root ---
FROM mcr.microsoft.com/dotnet/aspnet:10.0-noble-chiseled@sha256:5165aeeb688df15e869a56a7584bb94bf16a14e0b3ba77b49fcdbe350f6b8020 AS final
# O Host lê wwwroot e appsettings.json do diretório atual.
WORKDIR /app
COPY --from=api /out ./
COPY --from=web /src/apps/web/dist/web/browser ./wwwroot
ENV PORT=10000
EXPOSE 10000
USER $APP_UID
ENTRYPOINT ["dotnet", "UniOver.Host.dll"]
