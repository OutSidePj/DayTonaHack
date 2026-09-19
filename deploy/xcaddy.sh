#!/usr/bin/env bash
set -euo pipefail

# Official module: https://github.com/caddy-dns/dnsimple
# Caddyfile directives verified from UnmarshalCaddyfile:
#   api_access_token  (required)
#   account_id        (required for user tokens, optional for account tokens)
xcaddy build --with github.com/caddy-dns/dnsimple
