# Security Policy

FreeLLMAPI stores real provider credentials in encrypted local data. This fork is a private single-user deployment.

## Keep out of Git

Never commit provider API keys, ENCRYPTION_KEY, .env files, SQLite databases or backups, SSH keys, VPS credentials, runtime dist copies, or production backup archives. Redact secrets from logs and handover notes.

## Reporting

For this private fork, report suspected leaks through the repository's private GitHub channel or directly to the repository owner. Do not open a public issue containing credentials or exploit details.

## Operator hardening

Keep the service bound to localhost unless a trusted reverse proxy with TLS and authentication is in front of it. Rotate any credential that may have been exposed before continuing deployment.
