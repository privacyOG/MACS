# macs.rctrusts.com Local Domain Cutover

The app is currently running on this machine:

- LAN app URL: `http://192.168.1.33:18890`
- Current public IP: `115.70.56.60`
- Domain target: `macs.rctrusts.com`

## DNS

In the DNS zone for `rctrusts.com`, set:

```text
Type: A
Host: macs
Value: 115.70.56.60
TTL: 300 or default
```

If the domain is managed in Hostinger DNS, keep Hostinger nameservers and add the record there. If the registrar is not using Hostinger nameservers yet, either move nameservers to Hostinger first or create the same `A` record at the current DNS provider.

## Router Port Forwarding

Reserve this laptop/server on the LAN as `192.168.1.33`, then forward:

```text
External TCP 80  -> 192.168.1.33:18890
External TCP 443 -> 192.168.1.33:18443
```

Port 80 is needed for Let's Encrypt HTTP validation and can also serve the app while SSL is being issued. Port 443 should go to the HTTPS instance after the certificate is created.

## HTTPS

The server supports TLS when these environment variables are set:

```text
TLS_CERT_FILE=/path/to/fullchain.cer
TLS_KEY_FILE=/path/to/private.key
PORT=18443
```

Live certificate files are installed to:

```text
/home/rabz/.local/share/lawnquote/certs/fullchain.cer
/home/rabz/.local/share/lawnquote/certs/macs.rctrusts.com.key
```

`acme.sh` is configured to restart `lebgent-lawnquote-https.service` after certificate renewal.

The prepared user service template is:

```text
systemd/lebgent-lawnquote-https.service
```

Do not expose admin logins publicly long-term over plain HTTP. Use HTTPS once DNS and port forwarding are active.

## Live Services

HTTP and HTTPS run as separate user services:

```bash
systemctl --user status lebgent-lawnquote
systemctl --user status lebgent-lawnquote-https
```

The HTTP service redirects normal requests to `https://macs.rctrusts.com`, while leaving `/.well-known/acme-challenge/` available for certificate renewals.

## Current Blocker

Resolved. HTTP and HTTPS are reachable through the domain after router forwarding was corrected.
