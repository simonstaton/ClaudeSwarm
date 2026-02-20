# SWARM V3 Upgrade Plan
**Stability | Performance | Intelligence | Coordination**
*February 2026*

---

## Status: Substantially Complete

V3 implementation is complete across all five phases, with two larger features planned for future work. See the completion summary below and the dedicated plan documents for remaining items.

---

## Phase 1: Stability and Performance - COMPLETE

| Item | Status | PR |
|---|---|---|
| 1.1 AgentTerminal Output Virtualisation | Done | #158 |
| 1.2 Agent Process Isolation | Done | #158 |
| 1.3 npm Install Caching / Fast Starts | Done | #169 |
| 1.4 Agent Status Detection | Done | #158 |
| 1.5 Persistent Cost Tracking | Done | #158 |

## Phase 2: Agent Control and UX Polish - COMPLETE

| Item | Status | PR |
|---|---|---|
| 2.1 Pause and Resume | Done | #158 |
| 2.2 Agent Metadata Panel | Done | #167 |
| 2.3 Confidence Grading for Agent Fixes | Done | #170 |
| 2.4 UI / UX Cleanup (em-dashes, cursor, copy) | Done | #168 |

## Phase 3: Coordination Intelligence - COMPLETE

| Item | Status | PR |
|---|---|---|
| 3.1 Structured World Model (Task Graph) | Done | #158 |
| 3.2 Orchestrator with Plan-Execute-Observe | Done | #158 |
| 3.3 Capability-Aware Routing | Done | #158 |
| 3.4 Structured Inter-Agent Contracts | Done | #158 |
| 3.5 Failure Propagation and Recovery | Done | #158 |

## Phase 4: Observability and Memory - PARTIAL

| Item | Status | PR / Plan |
|---|---|---|
| 4.1 Task Graph UI View | Done | #171 |
| 4.2 Agent Memory Architecture | Planned | [plans/agent-memory-architecture.md](agent-memory-architecture.md) |
| 4.3 Scheduler and Wake-on-Alert | Done | #172 |

## Phase 5: Repo Health and Outreach Readiness - PARTIAL

| Item | Status | PR / Plan |
|---|---|---|
| 5.1 GitHub and CI Hardening | Done | #166 |
| 5.2 Security: 2FA on First Login | Planned | [plans/2fa-first-login.md](2fa-first-login.md) |
| 5.3 Repo Cleanup | Done | #168 |
| 5.4 Promotion and Outreach | Not started | - |

---

## Remaining Work

Two features have dedicated implementation plans:

1. **[Agent Memory Architecture](agent-memory-architecture.md)** (Phase 4.2) - Four-layer memory system: working memory, long-term knowledge, episodic logs, and artifact memory. SQLite-backed with API endpoints. Estimated 3-5 days.

2. **[Two-Factor Authentication](2fa-first-login.md)** (Phase 5.2) - TOTP on first login with challenge tokens, backup codes, encrypted storage, and updated UI login flow. Estimated 3-4 days.

3. **Promotion and Outreach** (Phase 5.4) - README polish, demo content, CONTRIBUTING.md improvements, and launch preparation. Scope TBD.

---

*Swarm V3 Upgrade Plan | February 2026*
