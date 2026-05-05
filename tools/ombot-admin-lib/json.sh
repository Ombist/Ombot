#!/usr/bin/env bash
# Minimal JSON string escaping and envelope emission (no jq). Sourced only.
# shellcheck shell=bash

ombist_json_escape_string() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\t'/\\t}
  printf '"%s"' "$s"
}

# Emit one JSON object line to stdout. summary must not contain raw newlines.
ombist_emit_envelope() {
  local ok="$1"
  local mode="$2"
  local summary="$3"
  local data_json="$4"
  local warnings_json="${5:-[]}"
  local errors_json="${6:-[]}"
  local sum_json
  sum_json="$(ombist_json_escape_string "${summary}")"
  printf '{"ok":%s,"mode":"%s","summary":%s,"data":%s,"warnings":%s,"errors":%s}\n' \
    "${ok}" "${mode}" "${sum_json}" "${data_json}" "${warnings_json}" "${errors_json}"
}
