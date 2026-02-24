# Migration: Public Repo = Canonical, Private Repo = Deploy/CI Only

**Goal:** Make the public repo (AgentManager) the single place for PRs and collaboration. The private repo (AgentManager_PRIVATE) receives updates only from public (sync or merge) and retains `deploy.yml` and GCP secrets. The current flow in `release-prod.md` (sync public FROM private, then trigger deploy on private) is reversed: sync private FROM public, then trigger deploy on private.

---

## 1. Pre-migration checklist

1. **Backup and safety**
   - Ensure both repos have recent full backups or are recoverable (e.g. re-clone from GitHub).
   - Note the current `main` commit SHAs on both public and private so you can compare post-migration.
   - If using branch protection on either repo, document current rules (required reviews, status checks, who can push).

2. **State of both repos**
   - Confirm public repo’s `main` is in the desired state (or will be after any final PRs).
   - Confirm private repo’s `main` matches what is currently in production (or document any intentional drift).
   - List any long-lived branches or release branches that need to exist on public after the switch.

3. **Branch protection**
   - On the **public** repo: ensure `main` (and any release branches) have appropriate protection (e.g. require PR, require status checks) so it is safe as the canonical source.
   - On the **private** repo: decide whether to relax protection on `main` for sync-only updates (e.g. allow force-push from a dedicated sync process or allow maintainer-only pushes from sync), or keep protection and use merge-from-public instead of force-push.

4. **Secrets and CI**
   - Confirm GCP secrets and GitHub Actions secrets used by `deploy.yml` (and any other private-only workflows) exist only on the private repo and will remain there.
   - Confirm no workflow on the public repo expects private-only secrets (public CI should use only public-safe checks).

5. **Stakeholders**
   - Inform anyone who currently pushes to the private repo that the canonical source will switch to public; after migration they should work only in the public repo (fork/PR or direct push per your policy).

---

## 2. Migration steps (ordered)

1. **Update `commands/release-prod.md`**
   - Change the described flow from “sync public FROM private, then trigger deploy on private” to “sync private FROM public, then trigger deploy on private.”
   - Replace the sync instructions: clone or use the private repo, add public as remote (or vice versa as needed), fetch public `main`, reset private `main` to public `main` (or merge), then push to private. Keep the step that triggers the deploy workflow on the private repo.
   - Update the confirmation text so it accurately describes that the public repo is the source of truth and the private repo will be updated from it before deploy.

2. **Update any docs that say “work in private” or describe private as canonical**
   - Search the repo for phrases that imply the private repo is where development happens or is the source of truth (e.g. “sync public from private”, “private is canonical”).
   - Update those docs to state that the public repo is canonical and that contributors open PRs and collaborate there; the private repo is for deploy/CI only and is updated from public.

3. **Update `plans/releases-and-milestones.md` (and any other release docs)**
   - Replace references to the old flow (“sync public repo” meaning “overwrite public from private”) with the new flow (“sync private from public, then deploy from private”).
   - Ensure release procedure steps and diagrams (if any) reflect public as the place where releases are cut (e.g. tags, version bumps, CHANGELOG) and private as the deploy target.

4. **Workflows**
   - Ensure `deploy.yml` (and any GCP/secret-dependent workflows) remain only on the private repo and are triggered from private (e.g. after sync or on `workflow_dispatch`).
   - If the public repo has or will have a “sync status” or “release” workflow that only checks or notifies, ensure it does not depend on private secrets.
   - Add or adjust any workflow on the private repo that might automate “sync from public” if you want automation (optional; can be manual as in the updated `release-prod.md` for now).

5. **Remotes and local clones**
   - Document for maintainers: when working from a clone of the **public** repo, they need no private remote for day-to-day work.
   - Document for release runners: they need a way to sync private from public (e.g. clone private, add public as remote, fetch and reset/merge, push to private) as in the updated `release-prod.md`; or use a single clone with both remotes and a small script.
   - Remove or update any docs/scripts that tell people to add the private repo as `origin` or as the primary remote for development.

6. **CONTRIBUTING and README**
   - In CONTRIBUTING (and README if it mentions where to contribute): state clearly that the project is developed in the **public** repo; contributors fork and open PRs there; they do not need access to the private repo.
   - Optionally add one sentence that the private repo is used only for deployment and is kept in sync from public by maintainers.

7. **Final sync direction check**
   - Do one last sync in the **old** direction if needed so that public has the very latest from private (e.g. any unmerged private-only commits you want to preserve). After that, no further development on private `main`; all new work happens on public.

8. **Perform the first sync in the new direction**
   - Run the new procedure once: sync private FROM public (so private `main` matches public `main`), then trigger deploy on private. Verify production deploys correctly from that commit.

---

## 3. Post-migration checks

1. **Public is canonical**
   - New commits exist only on the public repo’s `main` (or feature branches that merge there). Private `main` has no unique commits except those produced by sync (e.g. no direct development on private).
   - Branch protection on public `main` is active; PRs and reviews happen there.
   - README and CONTRIBUTING point contributors to the public repo only.

2. **Private deploys from public**
   - After a test change merged to public `main`, run the updated release procedure: sync private from public, trigger deploy on private. Production matches the commit that is on public `main`.
   - `deploy.yml` (and any deploy-related workflows) run only on the private repo and use the post-sync state of private `main`.

3. **Contributors only need public**
   - A new contributor can clone the public repo, open a PR, and get merged without ever needing access to the private repo.
   - Any “how to release” or “how to deploy” documentation is clearly aimed at maintainers and describes syncing private from public and triggering deploy on private, not pushing to private for development.

4. **Secrets and CI**
   - Public CI (e.g. lint, test) runs without private secrets. Private repo still has GCP and other secrets; deploy workflow runs there only.

---

## 4. Keeping both repos in sync (ongoing)

**Who syncs:** Only maintainers (or a dedicated release runner) need to sync. Contributors do not touch the private repo.

**When:** Sync happens when you want to deploy. Each time you run the release procedure: update the private repo’s `main` from the public repo’s `main` (via the steps in `release-prod.md`), then trigger the deploy workflow on the private repo. There is no need to sync on every push to public; sync only when cutting a production release.

**How:** Follow the updated `release-prod.md`: clone or use the private repo, fetch from public, set private `main` to match public `main` (reset or merge, as chosen), push to private, then run the deploy workflow on the private repo. Optionally automate this with a small script or a scheduled/manual workflow on the private repo that pulls from public and pushes to private (using a deploy key or token with write access to the private repo only), then triggers deploy; if you automate, protect the token and run the job in a way that does not expose private secrets to the public repo.

**Summary:** Public is the single source of truth for code and collaboration. Private is a downstream copy used only for running deploy and CI that depends on secrets; it is updated from public only at release time (or on a schedule if you choose), and contributors never need access to it.
