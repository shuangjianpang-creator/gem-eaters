# Snake Game

Multiplayer snake game — Node.js + WebSocket, served as a static page from the same server.

## Hosting on your LAN with Docker

Build the image (from the repo root):

```bash
docker build -t snake-game .
```

Run it, mapping container port 8080 to the host:

```bash
docker run -d \
  --name snake-game \
  --restart unless-stopped \
  -p 8080:8080 \
  snake-game
```

Find your host's LAN IP:

```bash
hostname -I            # quick
ip -4 addr show        # full detail
```

Share `http://<your-lan-ip>:8080` with anyone on the same Wi-Fi / LAN.

### Open the firewall (one-time)

```bash
# Ubuntu / Debian
sudo ufw allow 8080/tcp

# Fedora / RHEL
sudo firewall-cmd --add-port=8080/tcp --permanent && sudo firewall-cmd --reload
```

### Updating after a `git pull`

```bash
docker build -t snake-game .
docker rm -f snake-game
docker run -d --name snake-game --restart unless-stopped -p 8080:8080 snake-game
```

### Logs

```bash
docker logs -f snake-game
```

### Optional: persist rooms across restarts

Set Upstash Redis creds to keep room metadata alive across container restarts:

```bash
docker run -d \
  --name snake-game \
  --restart unless-stopped \
  -p 8080:8080 \
  -e UPSTASH_REDIS_REST_URL=https://... \
  -e UPSTASH_REDIS_REST_TOKEN=... \
  snake-game
```

## Running without Docker

```bash
npm ci
node server.js
```

Server listens on `0.0.0.0:8080` by default. Override with `PORT=3000 node server.js`.

## Gotchas

- **Mobile devices need to be on the same Wi-Fi as the host** (not on cellular). Some routers enable "AP isolation" / "guest network isolation" — if pings work but the page won't load, that's the cause.
- **CGNAT / sandboxed environments** (ChromeOS Crostini, Docker Desktop on macOS/Windows, GitHub Codespaces, etc.) put the container behind another NAT layer the LAN can't route to. Either run Docker on a "real" Linux host on the LAN, or use a tunneling service like `cloudflared` / `ngrok`.
