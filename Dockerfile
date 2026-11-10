# Imagem única: PWA (Angular) servido pela API (.NET) a partir do wwwroot.
# As bases são fixadas por digest; o Dependabot (ecossistema docker) propõe as atualizações.

# --- Etapa 1: build do PWA ---
FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS web
WORKDIR /src/apps/web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web/ ./
RUN npm run build

# --- Etapa 1b: os arquivos com hash das últimas versões ---
# Uma página aberta (ou um aparelho sem service worker ativo) ainda pede os pedaços de código da versão que carregou; sem eles
# o pedido dá 404 depois do deploy. Cada versão publica os seus no Release (`web-assets-<versão>.tar.gz`, ver o web-assets.yml)
# e esta etapa baixa os das últimas RETAIN_RELEASES versões anteriores. É de melhor esforço: sem rede, com limite de
# requisições ou sem Release a pasta fica vazia e a imagem é a de sempre (nunca falha o build: a publicação não depende do
# GitHub). A falha sai no log como linhas AVISO e uma faixa final, e o web-assets.yml a confere no ar depois de publicar.
# RETAIN_RELEASES=0 desliga.
# O VERSION entra antes do RUN para o cache de camadas ser refeito a cada versão (senão a lista congelaria).
FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS retained
ARG RETAIN_RELEASES=3
ARG RETAIN_REPO=n33miaz/uniover
WORKDIR /work
COPY VERSION ./VERSION
COPY apps/web/scripts/retained-assets.mjs ./retained-assets.mjs
RUN mkdir -p /retained \
    && node retained-assets.mjs fetch --repo "$RETAIN_REPO" --count "$RETAIN_RELEASES" --out /retained --current "$(tr -d '\r\n' < VERSION)"

# --- Etapa 1c: só os arquivos do PWA (não faz parte da imagem) ---
# `docker build --target web-dist --output type=local,dest=<pasta> .` entrega o build do PWA exatamente como a imagem o tem:
# é daqui que o web-assets.yml tira o artefato web-assets-<versão>.
FROM scratch AS web-dist
COPY --from=web /src/apps/web/dist/web/browser /

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
# Primeiro os arquivos com hash das versões anteriores, depois a versão atual por cima (ela sempre vence). O sw.js e o
# precache são só os da versão atual: os retidos servem a quem ainda carrega uma casca antiga, não entram no precache.
COPY --from=retained /retained ./wwwroot
COPY --from=web /src/apps/web/dist/web/browser ./wwwroot
ENV PORT=10000
EXPOSE 10000
USER $APP_UID
ENTRYPOINT ["dotnet", "UniOver.Host.dll"]
