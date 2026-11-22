# ---- build stage: static-ish musl binary ----
# Builder Alpine pinned to 3.22 to match the runtime base below, so the binary links against
# the same musl it runs against (no skew if the floating `rust:alpine` tag bumps its Alpine).
# The Rust version is pinned to the crates' `rust-version` (Cargo.toml): `rust:alpine3.20` froze
# at 1.94.1, which `--locked` refuses once the MSRV moved to 1.95.
FROM rust:1.95-alpine3.22 AS builder
RUN apk add --no-cache musl-dev
WORKDIR /build
# The build context is `sync-server/` (see docker-compose.yml), because this crate path-depends on
# `../core` (`aegis-sync-core`), which lives beside it. Both keep their sync-server/ layout here.
# Dependency-cache layer: compile deps against stubs so editing src/ or core/src doesn't rebuild
# them. This RUN stays CACHED across source edits (only the manifests/Cargo.lock invalidate it).
# The core needs its manifest to resolve the path dependency at all; it gets an empty stub lib for
# the same reason main.rs gets a stub main.
COPY legacy-docker/Cargo.toml legacy-docker/Cargo.lock ./legacy-docker/
COPY core/Cargo.toml ./core/
RUN mkdir legacy-docker/src core/src \
    && echo 'fn main() {}' > legacy-docker/src/main.rs \
    && touch core/src/lib.rs \
    && cargo build --release --locked --manifest-path legacy-docker/Cargo.toml \
    && rm -rf legacy-docker/src core/src
# Real sources; `touch` forces cargo to rebuild BOTH crates while reusing the cached deps (a COPY
# can carry an mtime older than the stub build, which cargo would read as fresh).
COPY core/src ./core/src
COPY legacy-docker/src ./legacy-docker/src
RUN touch legacy-docker/src/main.rs core/src/lib.rs \
    && cargo build --release --locked --manifest-path legacy-docker/Cargo.toml

# ---- runtime stage: minimal, non-root ----
FROM alpine:3.22
RUN addgroup -S aegis \
    && adduser -S -G aegis aegis \
    && mkdir -p /data \
    && chown aegis:aegis /data
COPY --from=builder /build/legacy-docker/target/release/aegis-sync-server /usr/local/bin/aegis-sync-server
USER aegis
ENV AEGIS_SYNC_ADDR=0.0.0.0:8787 \
    AEGIS_SYNC_DATA=/data/aegis-sync.json
EXPOSE 8787
VOLUME ["/data"]
ENTRYPOINT ["/usr/local/bin/aegis-sync-server"]
