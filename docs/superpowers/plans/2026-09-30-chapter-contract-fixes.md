# Chapter contracts and projection ownership Implementation Plan

**Goal:** prevent stale chapter artifact writes and refresh JIT contracts from changed facts.
**Architecture:** propagate the committed revision to all direct artifact writers and reuse the existing transactional projection fence. Keep one artifact implementation for CRUD and production. Add explicit fact-refresh identity to contract generation, persist it with the generated contract, and deduplicate concurrent JIT requests.
**Tech Stack:** TypeScript, Prisma/SQLite, node:test.

## Constraints
- Work only on codex/review-fix-chapter-contracts; no push, merge, deployment, or production data operations.
- Preserve AI planning; deterministic hashes identify already-consumed facts, never choose story actions.
- Keep every changed source below 700 lines; no UI changes.

## Task 1: Artifact revision ownership
- [x] Add regression tests to `server/tests/chapterDirectArtifactOwnership.test.js`: stale revision must reject before timeline/summary/fact mutation; current revision must write.
- [x] Run failing tests against the baseline.
- [x] Require `expectedContentRevision` on sync options; lock inside each transaction with `ChapterProjectionRevisionGuard`.
- [x] Propagate revision from draft, repair, finalization, pipeline and CRUD. Replace `novelChapterArtifacts` duplication with the owned service; preserve manual summary-stale signaling under the same fence.
- [x] Run tests and server typecheck; document contract, update release notes and commit.

## Task 2: JIT refresh
- [x] Add JIT-to-contract regression: complete contract plus changed facts must generate; identical facts must reuse; concurrent prefetch must join.
- [x] Run the baseline to prove failure.
- [x] Pass an explicit `factRefresh` fingerprint; bypass reuse only when identity changed. Persist identity in existing chapter metadata atomically with contract; verify input freshness before persistence.
- [x] Run targeted tests and server typecheck; document refresh ownership, update release notes and commit.

Verification: server build passed; direct artifact/CRUD/pipeline ownership suite 54/54, real SQLite race 2/2, JIT/contract/shape/boundary 31/31, volume integration 20/20. UI unchanged.

## Review follow-up
- [x] Reproduce joined prefetch A missing facts B; re-read after joining and perform at most three serial catch-up rounds. Reproduce continuously changing input and reject stale completion.
- [x] Reproduce character timeline rebuild overwriting a newer saved chapter against real SQLite; fence every source revision and limit deletion to snapshot chapter IDs.
- [x] Verify server build and 13 targeted JIT, SQLite race, contract and runtime-boundary tests.
