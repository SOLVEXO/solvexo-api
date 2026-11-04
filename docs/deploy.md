# Deploying solvexo-api to the VPS

Every push to `main` (and `staging`) runs `.github/workflows/deploy.yml` (`staging.yml`). Both run
`scripts/deploy.sh` on the VPS, which:

1. updates `/home/deploy/apps/solvexo-api` to the branch (fast-forward only on `main`, so local edits on the
   server stop the deploy instead of being overwritten),
2. `npm ci` and `npm run build`. **It stops here if the build fails, so the running API is left alone.**
3. restarts pm2 `solvexo-api-staging` with `--update-env`, so `.env` changes are picked up,
4. waits up to 60 s for `GET /health/live` on the `.env` `PORT` (default 3002), and fails the run with the
   last 50 log lines if the API does not come up.

You can also run it by hand on the server: `bash scripts/deploy.sh main solvexo-api-staging`.

## Why deploys were failing

Every run since late October ended with `dial tcp …: i/o timeout` after 30 s: GitHub's machine never reached SSH
on the server, so nothing was deployed (the server only changed when someone deployed by hand). Usual causes:

| Cause | Check / fix |
| --- | --- |
| `VPS_HOST` is a domain proxied by Cloudflare (orange cloud). Cloudflare only forwards web traffic, never SSH. | Set `VPS_HOST` to the server's **IP address**. |
| `VPS_PORT` is not the port SSH listens on. | On the server: `sudo ss -tlnp \| grep sshd`. |
| A firewall only lets known IPs reach SSH (ufw, fail2ban, the hosting panel's firewall). GitHub's runners use thousands of changing IPs. | `sudo ufw status`, the provider's firewall page. |

## Recommended: a self-hosted runner on the VPS

A GitHub Actions runner on the server connects **out** to GitHub over HTTPS, so no firewall or Cloudflare rule
can block the deploy, and no SSH key or open SSH port is needed for it.

1. GitHub → **SOLVEXO/solvexo-api** → Settings → Actions → **Runners** → **New self-hosted runner** → Linux x64.
   Keep that page open: it shows the download URL and a one-time `--token`.
2. On the VPS, as the **same user that runs pm2** (`deploy`):

   ```bash
   mkdir -p ~/actions-runner && cd ~/actions-runner
   # download + extract: copy the two "Download" commands from the GitHub page
   ./config.sh --url https://github.com/SOLVEXO/solvexo-api --token <TOKEN FROM THE PAGE> \
     --name solvexo-vps --labels solvexo-vps --unattended
   sudo ./svc.sh install deploy
   sudo ./svc.sh start
   ```

   The runner now shows as **Idle** on the Runners page.
3. GitHub → Settings → Secrets and variables → Actions → **Variables** → New repository variable:
   `DEPLOY_VIA` = `runner`.
4. Actions → **Deploy solvexo-api** → **Run workflow** (or push to `main`). The run should end with
   `solvexo-api is up`.

To go back to SSH, delete the `DEPLOY_VIA` variable (or set it to anything else).

The runner job uses the labels `self-hosted` + `solvexo-vps`; if no runner with those labels is online, the run
waits in the queue instead of failing.
