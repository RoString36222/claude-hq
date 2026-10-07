# The Rust Arena. Built from the REPO ROOT (it embeds backend/app/*.json at
# compile time):  docker build -f backend-rs/Dockerfile .
# ops/release.sh does this for you with ARENA_IMPL=rs.
FROM rust:1-slim AS build
WORKDIR /src
COPY backend-rs/Cargo.toml backend-rs/Cargo.lock backend-rs/
COPY backend-rs/src backend-rs/src
COPY backend/app/kart_tracks.json backend/app/platformer_levels.json backend/app/fps_map.json backend/app/
RUN cd backend-rs && cargo build --release --locked --bin arena

FROM debian:bookworm-slim
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/backend-rs/target/release/arena /usr/local/bin/arena
RUN printf '#!/bin/sh\nexec /usr/local/bin/arena --health\n' > /usr/local/bin/arena-health \
    && chmod 0755 /usr/local/bin/arena-health

ARG ARENA_VERSION=dev
ENV ARENA_VERSION=$ARENA_VERSION \
    ARENA_BIND_PORT=8080 \
    RUST_LOG=info
EXPOSE 8080
CMD ["/usr/local/bin/arena"]
