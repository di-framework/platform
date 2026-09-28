FROM oven/bun:1.2.21 AS build
WORKDIR /src
COPY package.json ./
COPY src ./src
RUN bun build --compile ./src/main.ts --outfile /out/backup-destination

FROM debian:bookworm
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/backup-destination /usr/local/bin/backup-destination
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/backup-destination"]
