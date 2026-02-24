# Reversed public/private repo workflow

**Goal:** Public repo (simonstaton/AgentManager) is the canonical source; all work and PRs happen there. Private repo (simonstaton/AgentManager_PRIVATE) is used only for GCP Cloud Run deployment (deploy.yml + GCP secrets), maintainer CI, and optionally for agents that need private tooling/secrets. No GCP secrets or deploy workflow live in the public repo.

---

## 1) Branch strategy

- **Public `main` is canonical.** All feature work, PRs, and merges happen in the public repo. Contributors and maintainers work there.
- **Private `main`** is a downstream copy used for deployment. It is updated from public (see §2). Private may carry **only** additive, private-only content (e.g. deploy workflow, secret references, optional agent tooling); no divergence of shared code—that lives in public.

---

## 2) How PRIVATE gets updates from PUBLIC

**Recommended: private has public as upstream; merge public/main into private/main.**

- In the private repo, add public as a remote (e.g. `upstream`) if not already present.
- When you want to refresh private with the latest public code: merge (or rebase) `upstream/main` into private `main` and push. Private-only files (e.g. `.github/workflows/deploy.yml`, GCP secrets in GitHub, any private tooling) remain in private and are never pushed to public.

**Sync options (pick one):**

| Method | Pros | Cons |
|--------|------|------|
| **Merge upstream/main** (recommended) | Clear history; private-only commits stay; no force-push. | Manual or scripted; you choose when to sync. |
| Mirror public → private (replace private main with public main) | Private main identical to public; simple. | Overwrites private main; private-only changes must be reapplied or kept in a separate branch and re-merged. |
| Scheduled sync (e.g. nightly cron) | Always up to date. | Same overwrite caveat if mirror; merge-based cron needs conflict handling. |

**Recommended sync method: merge public main into private main**

- **One-time setup (in private clone):**  
  `git remote add upstream https://github.com/simonstaton/AgentManager.git`  
  (Use SSH or PAT if you need write access from private; for fetch-only, HTTPS is enough.)

- **When you want to bring public changes into private:**  
  1. In private repo: `git fetch upstream && git checkout main && git merge upstream/main`  
  2. Resolve any conflicts (only possible if private has local changes to the same files; keep private-only files and deploy workflow).  
  3. Push: `git push origin main`

- **Optional script outline:**  
  - Clone or `cd` to private repo.  
  - `git fetch upstream`, `git checkout main`, `git merge upstream/main`.  
  - On success: `git push origin main`.  
  - On conflict: exit non-zero and report; resolve manually.

---

## 3) Deploy to GCP: exact steps

Deployment always runs from the **private** repo so that the workflow can use GCP secrets (e.g. WIF, project ID, region).

1. **Ensure private `main` is up to date with public** (so you deploy what’s on public main):  
   In private repo: `git fetch upstream && git merge upstream/main` (and push if you merged).

2. **Trigger the deploy workflow** from the private repo on `main`:  
   `gh workflow run deploy.yml --repo simonstaton/AgentManager_PRIVATE --ref main`

3. **Optional: verify the ref**  
   Confirm the commit you want is at private `main`: e.g. `git log -1 origin/main` or check the Actions run.

4. **Monitor the run**  
   `gh run list --repo simonstaton/AgentManager_PRIVATE --workflow=deploy.yml --limit=1`  
   Open the run URL to watch build and Cloud Run deploy.

**Summary:** Work in public → sync public → private (merge upstream/main) → trigger deploy on private `main`.

---

## 4) Where agents clone and how changes get to public PRs

- **Default: agents clone the public repo.** All development and PRs happen in public. Agents create branches, push to public, open PRs to public `main`. No GCP or deploy secrets in that repo.
- **Optional “builds itself” / private tooling:** If an agent needs the private repo (e.g. to run or trigger deploy, or use private tooling), it can clone the private repo in addition. That clone is for operational use only; **code changes that should be in the product must be made in the public repo** (branch → PR → merge to public main), then private is updated via §2.
- **Getting agent work into public:** Agent works in a public clone: branch off `main`, commit, push branch to public, open PR to public `main`. After merge to public main, maintainer syncs private (§2) and deploys (§3) when ready.

---

## 5) Concise checklist

1. **Branch strategy:** Public `main` = canonical; private `main` = downstream for deploy and private-only files.
2. **Sync PUBLIC → PRIVATE:** Private has `upstream` = public; merge `upstream/main` into private `main` when you want to refresh; push. (Recommended: no mirror; merge keeps private-only commits.)
3. **Deploy to GCP:** (1) Sync private with public (§2). (2) Run `gh workflow run deploy.yml --repo simonstaton/AgentManager_PRIVATE --ref main`. (3) Monitor the Actions run.
4. **Agents:** Clone public for all code and PRs; optionally clone private for deploy/tooling only. All product changes go to public as branches/PRs; private is updated by merge from public.

---

## 6) Updating existing docs

After adopting this workflow:

- **commands/release-prod.md** should be updated to reflect the reversed flow: sync **private** from **public** (merge upstream/main into private main), then trigger deploy on private—and remove the step that force-pushes from private to public.
