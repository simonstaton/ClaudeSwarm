# Release to Production

Deploy the latest main branch to production by syncing the public repo and triggering the Cloud Run deploy pipeline. **This is a destructive action — always confirm with the user before proceeding.**

## Steps

1. **STOP and ask the user for explicit confirmation** before doing anything else. Show them what will happen:
   - The public repo (`simonstaton/ClaudeSwarm`) will be force-pushed to match the private repo (`simonstaton/ClaudeSwarm_PRIVATE`) main branch
   - The GitHub Actions deploy workflow will be triggered on the private repo, which builds a Docker image and deploys to GCP Cloud Run
   - This will replace the currently running production service

   Ask: **"This will sync the public repo and deploy main to production on Cloud Run. Are you sure you want to proceed?"**

   If the user does not confirm, abort immediately.

2. **Sync the public repository** with the private repo's main branch:

```bash
# Clone the public repo, reset to private main, and force push
cd /tmp
rm -rf _release_sync
git clone https://github.com/simonstaton/ClaudeSwarm.git _release_sync
cd _release_sync
git remote add private https://github.com/simonstaton/ClaudeSwarm_PRIVATE.git
git fetch private main
git reset --hard private/main
git push origin main --force
```

3. **Trigger the deploy workflow** on the private repo:

```bash
gh workflow run deploy.yml --repo simonstaton/ClaudeSwarm_PRIVATE --ref main
```

4. **Monitor the deployment** — wait for the workflow to start and report its status:

```bash
# Wait a few seconds for the run to register, then check status
sleep 5
gh run list --repo simonstaton/ClaudeSwarm_PRIVATE --workflow=deploy.yml --limit=1
```

5. Report the result to the user. Include:
   - The commit SHA that was deployed
   - The GitHub Actions run URL (so they can monitor progress)
   - Remind them that Cloud Run deploys typically complete within a few minutes

$ARGUMENTS
