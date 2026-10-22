# The Arena. Built from this folder:  docker build -t claude-hq-arena .
# ops/release.sh does this for you (through docker-compose.yml).
FROM rust:1-slim AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src src
# sqlx::migrate!() is a compile-time macro: it reads migrations/ during
# `cargo build` and embeds the SQL in the binary, which applies it at startup.
COPY migrations migrations
# Every game's data file is read at COMPILE time with include_str!.
COPY data data
# The build directory (several GB) and the crate cache are deleted in the same step that makes
# them, so the layer this leaves behind is just the binary: no multi-GB layer per deploy for the
# disk to keep (ops/release.sh prunes what is left). Works with the classic builder and BuildKit.
RUN cargo build --release --locked --bin arena \
    && cp target/release/arena /usr/local/bin/arena \
    && rm -rf target /usr/local/cargo/registry

FROM debian:bookworm-slim
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/arena /usr/local/bin/arena
RUN printf '#!/bin/sh\nexec /usr/local/bin/arena --health\n' > /usr/local/bin/arena-health \
    && chmod 0755 /usr/local/bin/arena-health
ARG ARENA_VERSION=dev
ENV ARENA_VERSION=$ARENA_VERSION \
    ARENA_BIND_PORT=8080 \
    RUST_LOG=info
EXPOSE 8080
CMD ["/usr/local/bin/arena"]
