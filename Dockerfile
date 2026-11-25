# syntax=docker/dockerfile:1
ARG GO_IMAGE=golang:1.26.11-alpine

FROM ${GO_IMAGE} AS live
RUN apk add --no-cache ca-certificates su-exec \
    && CGO_ENABLED=0 GOBIN=/usr/local/bin go install github.com/air-verse/air@v1.67.4 \
    && install -d -m 0755 /etc/listarr
COPY docker/entrypoint.sh /usr/local/bin/listarr-entrypoint
COPY --chmod=0644 docker/air.toml /etc/listarr/air.toml
RUN su-exec 1000:1000 /bin/sh -c 'test -r /etc/listarr/air.toml'
WORKDIR /src
ENV LISTEN_ADDR=0.0.0.0:8080 DATA_DIR=/data \
    GOCACHE=/tmp/listarr-go-cache GOPATH=/tmp/listarr-go CGO_ENABLED=0
EXPOSE 8080
ENTRYPOINT ["/bin/sh", "/usr/local/bin/listarr-entrypoint"]
CMD ["air", "-c", "/etc/listarr/air.toml"]

FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS build
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
