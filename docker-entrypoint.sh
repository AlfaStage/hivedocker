#!/bin/sh
set -e

# O volume de dados pode ser criado pelo orquestrador como root.
# Garante que /app/data exista e pertenca ao usuario node antes de baixar privilegio.
mkdir -p /app/data
chown -R node:node /app/data 2>/dev/null || true
chmod 700 /app/data 2>/dev/null || true

exec su-exec node "$@"
