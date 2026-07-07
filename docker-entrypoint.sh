#!/bin/sh
set -e

# CareLane runs as the unprivileged `node` user. The data/ and uploads/ dirs are
# commonly bind-mounted from the host (see docker-compose.yml) and can therefore
# be root-owned, which the app could not write to as `node`. So: while we still
# have root, make sure those two dirs exist and are owned by `node`, then drop
# privileges and exec the app as `node`. When the container is already started
# as a non-root user (e.g. compose `user:` override), skip straight to exec.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /app/data /app/uploads
  chown -R node:node /app/data /app/uploads
  exec gosu node "$@"
fi

exec "$@"
