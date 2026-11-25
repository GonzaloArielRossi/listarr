# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM golang:1.26.11-alpine AS build
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
RUN apk add --no-cache ca-certificates
COPY go.mod main.go tmdb.go ./
COPY web/ ./web/
RUN CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" \
    go build -trimpath -buildvcs=false -ldflags="-s -w" -o /out/wishlist . \
    && mkdir -p /out/data && touch /out/data/.keep

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/wishlist /wishlist
COPY --from=build --chown=1000:1000 /out/data/ /data/
ENV LISTEN_ADDR=0.0.0.0:8080 DATA_DIR=/data
USER 1000:1000
EXPOSE 8080
VOLUME ["/data"]
ENTRYPOINT ["/wishlist"]
