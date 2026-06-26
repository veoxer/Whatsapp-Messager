# WhatsApp Local API

A local HTTP API for sending WhatsApp messages through WhatsApp Web.

This does not use Twilio, Meta Cloud API, Zapier, or any third-party messaging service. It does use WhatsApp Web, so the machine or container running this API must stay online and logged in to WhatsApp.

Use this responsibly and only message people who expect to hear from you. WhatsApp can restrict accounts for spammy or automated behavior.

## Security Model

- The committed repo contains only example env files with placeholders, not real secrets.
- Real env files such as `.env` and `.env.docker` are ignored by Git.
- Docker mode requires a long `API_KEY` and refuses to start without one.
- The Docker Compose port is bound to `127.0.0.1` only.
- QR endpoints are protected when API key auth is enabled because the QR code is a login credential.
- Express security headers are enabled with `helmet`.
- Message sends are rate-limited separately from general API traffic.
- Request bodies are capped and JSON parsing errors return safe responses.
- The container runs as the unprivileged `node` user with `no-new-privileges` and all Linux capabilities dropped.
- WhatsApp session data is kept in a Docker volume, not baked into the image.

Do not expose this API directly to the public internet. Put a real reverse proxy with TLS, IP allow-listing, logging, and monitoring in front of it if you intentionally need network access beyond this machine.

## Public GitHub Repo Safety

This project is safe to push to a public GitHub repo after you confirm that no local runtime files are staged. The public files use placeholders only. Your real `API_KEY`, WhatsApp login session, and Docker volumes must stay outside Git.

Before pushing, run:

```powershell
git status --short --ignored
```

Expected ignored local-only entries may include:

```text
!! .env
!! .env.docker
!! .wwebjs_auth/
!! node_modules/
```

Do not force-add ignored files. In particular, never run `git add -f .env .env.docker .wwebjs_auth`.

## Run With Docker

Create a Docker env file:

```powershell
Copy-Item .env.docker.example .env.docker
```

Generate a long API key:

```powershell
-join ((48..57 + 65..90 + 97..122) | Get-Random -Count 48 | ForEach-Object {[char]$_})
```

Put that value in `.env.docker`, then start the container:

```powershell
docker compose --env-file .env.docker up --build
```

Open the QR page:

[http://127.0.0.1:3030/qr.html](http://127.0.0.1:3030/qr.html)

Your browser will ask for Basic Auth. Use any username and your `API_KEY` as the password.

On first run, scan the QR code with WhatsApp on your phone:

```text
WhatsApp > Linked devices > Link a device
```

The login session is saved in the `whatsapp_auth` Docker volume, so you usually only need to scan once.

## Run On Raspberry Pi With Portainer

Use [docker-compose.portainer.yml](<docker-compose.portainer.yml>) for a headless Raspberry Pi. It publishes port `3030` on the Pi so you can open the QR page from another device on your LAN.

This is compatible with a public GitHub repository. The stack file references `${API_KEY}`, but the real value must be entered in Portainer as a stack environment variable. Do not put a real key in the repo.

In Portainer:

1. Go to `Stacks`.
2. Create a new stack.
3. Use the Git repository option and point it at your public GitHub repo so Portainer can see the `Dockerfile`, `package.json`, and `src` folder.
4. Set the compose path to `docker-compose.portainer.yml`.
5. Add an environment variable named `API_KEY` with a random value of at least 32 characters.
6. Deploy the stack.

Generate a key on the Pi:

```bash
openssl rand -base64 36
```

Then open the QR page from another device:

```text
http://raspberrypi.local:3030/qr.html
```

If `raspberrypi.local` does not resolve, use the Pi's IP address:

```text
http://192.168.1.50:3030/qr.html
```

Your browser will ask for Basic Auth. Use any username and your `API_KEY` as the password.

If you are not deploying from Git, copy this project folder to the Pi and build once over SSH:

```bash
docker build -t whatsapp-local-api:raspi .
```

Then paste [docker-compose.portainer-image.yml](<docker-compose.portainer-image.yml>) into Portainer's stack editor. That stack uses the local image tag and does not need a build context.

Raspberry Pi notes:

- A 64-bit Raspberry Pi OS is strongly recommended. The image uses Debian multi-arch packages for Node and Chromium.
- First build can be slow because Chromium and npm dependencies are installed on the Pi.
- Keep this on your trusted LAN only. Do not port-forward `3030` from your router.
- The Portainer stack uses `shm_size: "256mb"` because Chromium is unstable with Docker's tiny default shared memory size on small devices.
- If the Pi is under memory pressure, close other heavy containers before first QR login.

## Run Without Docker

```powershell
npm install
Copy-Item .env.example .env
npm start
```

Local development defaults to `HOST=127.0.0.1` and allows no API key. For stricter local testing, set:

```env
REQUIRE_API_KEY=true
API_KEY=your-random-secret-with-at-least-32-characters
```

## Endpoints

### Health

Does not require auth. Reports whether the server is alive:

```powershell
Invoke-RestMethod http://127.0.0.1:3030/health
```

### Ready

Returns `200` only when WhatsApp is logged in and ready to send:

```powershell
Invoke-RestMethod http://127.0.0.1:3030/ready
```

### Status

Requires auth when auth is enabled:

```powershell
Invoke-RestMethod `
  -Uri http://127.0.0.1:3030/status `
  -Headers @{ Authorization = "Bearer your-api-key" }
```

### QR Code

Only available while waiting for login:

```powershell
Invoke-RestMethod `
  -Uri http://127.0.0.1:3030/qr `
  -Headers @{ Authorization = "Bearer your-api-key" }
```

The HTML version is easier for scanning:

[http://127.0.0.1:3030/qr.html](http://127.0.0.1:3030/qr.html)

### Send a Message

Use international phone format. For example, a US number is `15551234567`.

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:3030/messages `
  -Headers @{ Authorization = "Bearer your-api-key" } `
  -ContentType "application/json" `
  -Body '{"to":"15551234567","message":"Hello from my local API"}'
```

### Logout

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:3030/logout `
  -Headers @{ Authorization = "Bearer your-api-key" }
```

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `HOST` | `127.0.0.1` locally, `0.0.0.0` in Docker | Keep Docker published to `127.0.0.1` unless you intentionally need LAN access. |
| `PORT` | `3030` | API port. |
| `API_KEY` | empty locally, required in Docker | Must be at least 32 characters when auth is required. |
| `REQUIRE_API_KEY` | true in production or non-loopback | Set true for strict local testing. |
| `AUTH_DATA_PATH` | `.wwebjs_auth` locally | Docker uses `/home/node/.wwebjs_auth`. |
| `SEND_RATE_LIMIT_MAX` | `20` | Max send attempts per window. |
| `GENERAL_RATE_LIMIT_MAX` | `120` | Max general requests per window. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window. |
| `MESSAGE_MAX_LENGTH` | `4096` | Maximum text message length. |
| `WHATSAPP_TIMEOUT_MS` | `30000` | Timeout for WhatsApp operations. |

## Operational Notes

- Keep the server running while sending messages.
- Keep the WhatsApp account in good standing and avoid bulk unsolicited messaging.
- Group messages can be sent by passing a WhatsApp group chat id ending in `@g.us`.
- If you change the API key, restart the process or container.
