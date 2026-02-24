# Plan: Reverse Deployment — Public Canonical, Private for Deploy & CI

**Goal:** Always work in the **public** repo; PRs visible there; contributors contribute there. Keep the **private** repo for your own GCP deployments and your own CI. Maintain both: public = source of truth, private = deploy/CI mirror updated from public. **PRIVATE remains pivotal** — you let agents build themselves inside that environment; this plan makes that coexist with “public first” for code and PRs.

---

## 1. Current vs desired state

| Aspect | Current | Desired |
|--------|---------|---------|
| **Canonical source** | Private repo (AgentManager_PRIVATE) | Public repo (AgentManager) |
| **Where work happens** | Private; public synced from private at release | Public; all PRs and branches there |
| **Release flow** | Sync public ← private (force-push), then deploy from private | Sync private ← public (merge/reset), then deploy from private |
| **Contributors** | Clone public (CONTRIBUTING); public is “mirror” | Clone public only; public is the only place to contribute |
| **Your deploy/CI** | Private has deploy.yml + GCP secrets; deploy from private | Unchanged: private keeps deploy.yml + secrets; deploy from private |
| **PRIVATE’s role** | Primary dev + deploy | Deploy/CI only + **pivotal for agent “builds itself”** (see §5) |

---

## 2. Why PRIVATE stays pivotal

You run agents inside the PRIVATE setup (same repo, GCP, tooling). That does **not** conflict with public canonical:

- **Product code and PRs** → live in the **public** repo. Agents (or you) can clone **public**, open branches, push, open PRs to public `main`. No secrets in public.
- **Where agents run** → can still be the **private** environment (same codebase, but the codebase is now sourced from public). When you sync private from public (§3), the private repo has the same code; agents “building themselves” there are still working on the same project; any **product** changes they make should land as branches/PRs to **public**, then you sync to private when you deploy.
- **Private-only use** → deploy workflow, GCP secrets, your CI, and any private tooling stay in private. Agents that need to trigger deploy or use private-only tooling use the private clone for that; **code changes** still go to public (branch → PR → public main → sync to private).

So: **PRIVATE is pivotal for your deployment and for the environment where agents build**; **public is pivotal for all shared code and visible PRs**. Both are maintained; sync direction is public → private.

---

## 3. How to maintain both

### 3.1 Branch strategy

- **Public `main`** = canonical. All feature work, PRs, and merges happen there.
- **Private `main`** = downstream copy for deploy (and any private-only files). Updated only from public.

### 3.2 How PRIVATE gets updates from PUBLIC

**Recommended: private has public as upstream; merge `upstream/main` into private `main`.**

- **One-time (in private clone):**  
  `git remote add upstream https://github.com/simonstaton/AgentManager.git`

- **When you want to refresh private with latest public:**  
  1. In private repo: `git fetch upstream && git checkout main && git merge upstream/main`  
  2. Resolve conflicts if any (keep private-only files, e.g. deploy workflow).  
  3. Push: `git push origin main`

- **Alternative (mirror):** Replace private `main` with public `main` (e.g. reset --hard upstream/main and force-push). Simpler but overwrites private main; any private-only commits must live on a branch and be re-applied.

### 3.3 Deploy to GCP (reversed flow)

1. **Sync private from public** so private `main` matches what you want to deploy:  
   In private: `git fetch upstream && git checkout main && git merge upstream/main` then `git push origin main`.

2. **Trigger deploy** (unchanged):  
   `gh workflow run deploy.yml --repo simonstaton/AgentManager_PRIVATE --ref main`

3. **Monitor:**  
   `gh run list --repo simonstaton/AgentManager_PRIVATE --workflow=deploy.yml --limit=1`

**Summary:** Work in public → sync public → private (merge upstream/main) → trigger deploy on private.

### 3.4 Agents: where they clone, how changes reach public

- **Default:** Clone **public**; all branches and PRs go to public. No GCP/deploy secrets there.
- **Optional (builds itself in private):** Agents can still clone/use **private** for deploy tooling or running in your environment. Product changes must still go to **public** (branch → PR → public main); private is then updated via §3.2.
- **Getting agent work into public:** Agent works in a public clone (or pushes a branch to public from private clone): open PR to public `main`. After merge, you sync private (§3.2) and deploy (§3.3) when ready.

---

## 4. Touchpoints — what to change

| File | Change for “public canonical, private deploy only” |
|------|---------------------------------------------------|
| **commands/release-prod.md** | **Rewrite:** Sync **private from public** (e.g. in private clone: add `upstream` = public, `fetch upstream`, `merge upstream/main`, push), then `gh workflow run deploy.yml --repo simonstaton/AgentManager_PRIVATE --ref main`. Remove “force-push public from private”. State that public is canonical. |
| **package.json** | Keep `repository` / `bugs` / `homepage` pointing at public AgentManager. |
| **README.md** | Keep badges and clone URL as public. |
| **CONTRIBUTING.md** | Keep links as public; add one line that the private repo is deploy-only and contributors use the public repo. |
| **.github/ISSUE_TEMPLATE/config.yml** | Keep URLs as public; use in public repo. |
| **.github/workflows/deploy.yml** | Keep in **private** only; optional comment that this repo is deploy-only and synced from public before deploy. |
| **.github/workflows/ci.yml** | Run CI on **public** repo when it becomes canonical (lint, typecheck, test). Private can keep same file for the synced branch. |
| **.github/workflows/image-scan.yml** | Run from public when canonical, or keep in both as needed. |
| **.github/workflows/terraform.yml** | If terraform is reviewed on public, add to public; private can keep for synced branch. |
| **docs/incident-runbook.md** | Keep Issues link to public. |
| **docs/npm-worktrees.md** | Keep or generalize worktree path examples; note which repo they refer to. |
| **terraform/** (tfvars.example, variables.tf) | Document that `github_repo` is the repo that runs deploy (e.g. private). No code change in variables.tf. |
| **src/templates/workspace-claude-md.ts** | Swap repo descriptions: AgentManager.git = canonical (“Public repo – canonical source. All PRs, issues, and contributions go here.”); AgentManager_PRIVATE.git = deploy-only (“Private repo – deploy-only. Synced from public main for releases.”). |
| **ui/src/components/LinearWorkflowDialog.tsx** | Default/placeholder repository to `AgentManager` (public). |
| **src/__tests__/api-key-switch.test.ts** | Point PR link to public when applicable or mark as historical private reference. |
| **plans/releases-and-milestones.md** | Update narrative: public = canonical; release = merge to public main → sync to private (per release-prod) → trigger deploy on private. |

---

## 5. Migration checklist

### Pre-migration

- [ ] Backup / note current `main` SHAs on both repos.
- [ ] Document branch protection on both repos.
- [ ] Confirm GCP/GitHub secrets exist only on private and will stay there.
- [ ] Inform anyone who pushes to private that canonical is switching to public.

### Ordered steps

1. **Update `commands/release-prod.md`** to “sync private FROM public, then deploy on private” and fix confirmation text.
2. **Update docs** that say “work in private” or “sync public from private” to “public canonical, private deploy-only”.
3. **Update `plans/releases-and-milestones.md`** (and any release docs) to the new flow.
4. **Workflows:** Keep deploy.yml (and secret-using workflows) only on private; add/ensure CI (and optionally image-scan, terraform) on public.
5. **Remotes:** Document that contributors use public only; release runners use sync-from-public procedure (or script).
6. **CONTRIBUTING / README:** State public is for contribution; private is for deploy/CI only.
7. **Optional:** One final sync in the **old** direction (private → public) so public has the latest from private before the switch.
8. **First sync in new direction:** Sync private from public, trigger deploy on private, verify production.

### Post-migration

- [ ] New commits and PRs only on public; private `main` only updated via sync.
- [ ] One test release: change on public → sync private → deploy; production matches public `main`.
- [ ] Contributors can work with only the public repo; secrets and deploy stay on private.

---

## 6. Ongoing sync

- **Who:** Maintainers (or release runner) only. Contributors do not touch private.
- **When:** When you want to deploy — not on every push. Sync private from public, then trigger deploy on private.
- **How:** Follow the updated `release-prod.md`. Optionally automate with a script or a private-repo workflow that pulls from public and pushes to private (using a token with write access to private only), then triggers deploy.

---

## 7. Related docs

- **plans/public-private-reversed-workflow.md** — Detailed workflow (branch strategy, sync options, deploy steps, agents).
- **plans/public-canonical-migration.md** — Pre/migration/post checklists and ongoing sync in more detail.

After adoption, run the new procedure once and confirm deploy works; then treat public as the single source of truth and private as the deploy/CI mirror plus the pivotal environment for agents building themselves.
