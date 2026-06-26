# Security

This repository is designed to be safe to publish publicly as long as only the checked-in example files are committed.

## Never Commit

- `.env`
- `.env.docker`
- any other real `.env.*` file
- `.wwebjs_auth/`
- `.wwebjs_cache/`
- Docker volumes containing WhatsApp session data
- screenshots or logs that contain QR codes, API keys, phone numbers, or message content

The WhatsApp QR code is effectively a login credential while it is active. Treat it like a password.

## Public Repo Deployment

For a public GitHub repo, keep secrets outside GitHub:

- In Portainer, set `API_KEY` as a stack environment variable.
- In local Docker Compose, pass `--env-file .env.docker`.
- In CI or GitHub Actions, use repository secrets if you later add automation.

The app refuses to start in production without a non-placeholder `API_KEY` of at least 32 characters.
