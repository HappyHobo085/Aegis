#!/usr/bin/env bash
# Regenerates the committed self-signed pair used by startCertServer().
# Run from this directory:  bash gen-cert.sh
set -euo pipefail
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout key.pem -out cert.pem -days 3650 \
  -subj "/CN=127.0.0.1" \
  -addext "subjectAltName=IP:127.0.0.1"
echo "wrote key.pem and cert.pem"
