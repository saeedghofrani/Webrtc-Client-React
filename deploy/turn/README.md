# TURN Deployment

Keep the actual `turnserver.conf` on the server, outside Git. Include long-term
credentials, realm, external IP, fingerprint, and `min-port=49160` /
`max-port=49200`. Set matching client build variables through private config.

The coturn image runs as UID/GID 65534. A root-owned config with mode 600 is
unreadable: coturn can silently start with defaults, bypassing authentication
and ignoring the port range. Use owner root, group 65534, mode 640. The startup
check intentionally fails if the config cannot be read.

Allow 3478 TCP/UDP and 49160:49200 UDP in the firewall. Request approval before
changing production permissions, firewall rules, or restarting TURN.

Run `docker compose config --quiet`, then `docker compose up -d --pull never`.
Use the already-validated local image; do not upgrade it during a config repair.
Check health and run browser tests with `TEST_RELAY=1` and TCP/UDP separately.
