#!/usr/bin/env bash
# TLS helpers for single-bot (sourced by provision-single-bot.sh and ombot-admin).
# Requires: ombist_as_root from as_root.sh, TLS_DIR set (default /etc/ombot/tls).
# shellcheck shell=bash

TLS_DIR="${TLS_DIR:-/etc/ombot/tls}"

ombist_tls_san_line() {
  local pubhost="$1"
  local san_line="DNS:${pubhost}"
  if [[ "${pubhost}" =~ ^[0-9.]+$ ]]; then
    san_line="IP:${pubhost}"
  elif [[ "${pubhost}" == *:* ]]; then
    san_line="IP:${pubhost}"
  fi
  printf '%s' "${san_line}"
}

# OpenSSL 3 x509 -extfile expects [alt_names] entries as DNS.n / IP.n (not "DNS:host" lines).
ombist_tls_alt_names_ini_lines() {
  local pubhost="$1"
  if [[ "${pubhost}" =~ ^[0-9.]+$ ]]; then
    printf 'IP.1 = %s\n' "${pubhost}"
  elif [[ "${pubhost}" == *:* ]]; then
    printf 'IP.1 = %s\n' "${pubhost}"
  else
    printf 'DNS.1 = %s\n' "${pubhost}"
  fi
}

# Generate Root CA + server cert (no delete). Used by first-time provision.
ombist_tls_provision_initial() {
  local pubhost="$1"

  ombist_as_root openssl genrsa -out "${TLS_DIR}/RootCA.key" 4096
  ombist_as_root openssl req -x509 -new -nodes -key "${TLS_DIR}/RootCA.key" -sha256 -days 3650 \
    -subj "/CN=Ombist Single-Bot Root CA" -out "${TLS_DIR}/RootCA.crt"
  ombist_as_root openssl genrsa -out "${TLS_DIR}/server.key" 2048
  ombist_as_root openssl req -new -key "${TLS_DIR}/server.key" -out "${TLS_DIR}/server.csr" \
    -subj "/CN=${pubhost}"
  ombist_as_root tee "${TLS_DIR}/server.ext" >/dev/null <<EOF
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage = digitalSignature, nonRepudiation, keyEncipherment, dataEncipherment
subjectAltName = @alt_names
[alt_names]
$(ombist_tls_alt_names_ini_lines "${pubhost}")
EOF

  if ! ombist_as_root openssl x509 -req -in "${TLS_DIR}/server.csr" \
    -CA "${TLS_DIR}/RootCA.crt" -CAkey "${TLS_DIR}/RootCA.key" \
    -CAcreateserial -out "${TLS_DIR}/server.crt" -days 825 -sha256 \
    -extfile "${TLS_DIR}/server.ext"; then
    echo "ombist_tls: openssl x509 signing failed" >&2
    return 1
  fi
  if [[ ! -s "${TLS_DIR}/server.crt" ]]; then
    echo "ombist_tls: server.crt missing or empty" >&2
    return 1
  fi
  if ! ombist_as_root openssl x509 -in "${TLS_DIR}/server.crt" -noout -subject -ext subjectAltName >/dev/null 2>&1; then
    echo "ombist_tls: server.crt unreadable" >&2
    return 1
  fi

  ombist_as_root chmod 640 "${TLS_DIR}/RootCA.key" "${TLS_DIR}/server.key"
  ombist_as_root chmod 644 "${TLS_DIR}/RootCA.crt" "${TLS_DIR}/server.crt"
  ombist_as_root chown root:root "${TLS_DIR}/RootCA.key" "${TLS_DIR}/server.key"
  ombist_as_root chown root:root "${TLS_DIR}/RootCA.crt" "${TLS_DIR}/server.crt"
  return 0
}

# Remove existing material and re-issue (TLS rotate).
ombist_tls_rotate() {
  local pubhost="$1"

  if ! command -v openssl >/dev/null 2>&1; then
    return 8
  fi

  ombist_as_root mkdir -p "${TLS_DIR}" || return 7
  ombist_as_root rm -f \
    "${TLS_DIR}/RootCA.crt" \
    "${TLS_DIR}/RootCA.key" \
    "${TLS_DIR}/RootCA.srl" \
    "${TLS_DIR}/server.csr" \
    "${TLS_DIR}/server.key" \
    "${TLS_DIR}/server.crt" \
    "${TLS_DIR}/server.ext"

  ombist_tls_provision_initial "${pubhost}" || return 1

  TLS_NGINX_STATE="skip"
  if command -v nginx >/dev/null 2>&1; then
    if ombist_as_root nginx -t >/dev/null 2>&1; then
      ombist_as_root systemctl reload nginx.service >/dev/null 2>&1 || ombist_as_root systemctl restart nginx.service >/dev/null 2>&1 || true
      TLS_NGINX_STATE="reloaded"
    else
      TLS_NGINX_STATE="nginx_config_invalid"
    fi
  fi
  export TLS_NGINX_STATE
  TLS_ROOTCA_B64="$(ombist_as_root base64 -w0 "${TLS_DIR}/RootCA.crt" 2>/dev/null || ombist_as_root base64 "${TLS_DIR}/RootCA.crt" | tr -d '\n')"
  export TLS_ROOTCA_B64
  return 0
}

ombist_tls_rootca_pem_base64() {
  ombist_as_root base64 -w0 "${TLS_DIR}/RootCA.crt" 2>/dev/null || ombist_as_root base64 "${TLS_DIR}/RootCA.crt" | tr -d '\n'
}

# Lowercase hex SHA256 of exact Root CA PEM file bytes (matches client hash of rootCaPemBase64 decode).
ombist_tls_pem_file_sha256_hex() {
  local path="$1"
  [[ -n "$path" ]] || return 1
  local out=""
  if command -v sha256sum >/dev/null 2>&1; then
    out="$(ombist_as_root sha256sum "$path" 2>/dev/null | awk '{print tolower($1)}')"
  elif command -v shasum >/dev/null 2>&1; then
    out="$(ombist_as_root shasum -a 256 "$path" 2>/dev/null | awk '{print tolower($1)}')"
  else
    out="$(ombist_as_root openssl dgst -sha256 "$path" 2>/dev/null | awk '{print tolower($NF)}')"
  fi
  [[ ${#out} -eq 64 ]] || return 1
  printf '%s' "$out"
}

# Optional: notAfter from server cert (ISO-ish); empty if missing.
ombist_tls_server_not_after() {
  if [[ ! -r "${TLS_DIR}/server.crt" ]]; then
    printf ''
    return 0
  fi
  ombist_as_root openssl x509 -in "${TLS_DIR}/server.crt" -noout -enddate 2>/dev/null | sed 's/^notAfter=//' || true
}
