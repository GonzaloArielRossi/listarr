#!/bin/sh
set -eu

uid=${PUID:-1000}
gid=${PGID:-1000}
for id in "$uid" "$gid"; do
    case "$id" in
        0*|*[!0-9]*)
            echo "PUID and PGID must be positive numeric IDs." >&2
            exit 1
            ;;
    esac
done

# Docker can create the host bind directory as root on the first start.
mkdir -p "$DATA_DIR"
chown -h "$uid:$gid" "$DATA_DIR"
wishlist="$DATA_DIR/wishlist.json"
if [ -L "$wishlist" ]; then
    echo "The wishlist data file must not be a symlink." >&2
    exit 1
fi
if [ -f "$wishlist" ]; then
    chown -h "$uid:$gid" "$wishlist"
fi

exec su-exec "$uid:$gid" "$@"
