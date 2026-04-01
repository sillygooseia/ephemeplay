# Publishing EphemePlay → play.epheme.org

All deploys run from the **repo root** (`sillygooseia-corp/`) via `infra/deploy.ps1`.

---

## First deploy (one-time setup)

### 1. Create the secrets file

```powershell
Copy-Item ephemeplay\secrets\ephemeplay.example.json ephemeplay\secrets\ephemeplay.json
# Edit the file and fill in real values for redisPassword and playerJwtSecret
notepad ephemeplay\secrets\ephemeplay.json
```

`ephemeplay.json` is gitignored and never committed.

### 2. Build, push, and deploy

```powershell
# From repo root
.\infra\deploy.ps1 -Tag v1 -Target ephemeplay
```

This will:
1. Build `silentcoil.sillygooseia.com:5000/ephemeplay/backend:<tag>` and push it.
2. Run `helm upgrade --install ephemeplay` in namespace `ephemeplay` (created if absent).
3. Deploy the backend + a dedicated Redis StatefulSet.
4. Apply an Ingress for `play.epheme.org` with cert-manager TLS (letsencrypt-prod).

### 3. Verify TLS

cert-manager will automatically issue a certificate for `play.epheme.org`.
Check progress:

```bash
kubectl get certificate -n ephemeplay
kubectl describe certificaterequest -n ephemeplay
```

The site is live once `READY = True`.

---

## Subsequent deploys

```powershell
.\infra\deploy.ps1 -Tag v2 -Target ephemeplay
```

---

## Architecture

```
play.epheme.org (Traefik Ingress, TLS via cert-manager)
        │
        └─► ephemeplay-backend  (Node.js, port 8787)
                    │  serves static files + Socket.IO
                    └─► ephemeplay-redis  (Redis 7 StatefulSet, 256 Mi PVC)
```

- Namespace: `ephemeplay`
- Image registry: `silentcoil.sillygooseia.com:5000/ephemeplay/backend`
- Helm chart: `ephemeplay/infra/helm/ephemeplay/`
- Secrets (gitignored): `ephemeplay/secrets/ephemeplay.json`
