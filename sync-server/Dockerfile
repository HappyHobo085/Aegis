# ---- build stage: static-ish musl binary ----
# Builder Alpine pinned to 3.20 to match the runtime base below, so the binary links against
# the same musl it runs against (no skew if the floating `rust:alpine` tag bumps its Alpine).
FROM rust:alpine3.20 AS builder
RUN apk add --no-cache musl-dev
WORKDIR /build
# Dependency-cache layer: compile deps against a stub main so editing src/ doesn't rebuild them.
# This RUN stays CACHED across source edits (only Cargo.toml/Cargo.lock changes invalidate it).
COPY Cargo.toml Cargo.lock ./
RUN mkdir src \
    && echo 'fn main() {}' > src/main.rs \
    && cargo build --release --locked \
    && rm -rf src
# Real sources; `touch` forces cargo to rebuild the bin crate while reusing the cached deps.
COPY src ./src
RUN touch src/main.rs && cargo build --release --locked

# ---- runtime stage: minimal, non-root ----
FROM alpine:3.20
RUN addgroup -S aegis \
    && adduser -S -G aegis aegis \
    && mkdir -p /data \
    && chown aegis:aegis /data
COPY --from=builder /build/target/release/aegis-sync-server /usr/local/bin/aegis-sync-server
USER aegis
ENV AEGIS_SYNC_ADDR=0.0.0.0:8787 \
    AEGIS_SYNC_DATA=/data/aegis-sync.json
EXPOSE 8787
VOLUME ["/data"]
ENTRYPOINT ["/usr/local/bin/aegis-sync-server"]
