# ---- build stage: static-ish musl binary ----
FROM rust:alpine AS builder
RUN apk add --no-cache musl-dev
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

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
