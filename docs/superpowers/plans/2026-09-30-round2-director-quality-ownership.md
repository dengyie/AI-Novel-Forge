# Director quality projection ownership repair

**Goal:** old chapter quality results cannot overwrite a newer chapter or stop the remaining range.
**Root cause:** pipeline assessment catch bypasses the rejected revision CAS through a plain update, then treats stale in-memory debt as current.
**Boundary:** keep ChapterQualityLoopService as sole assessment writer; retry that writer for transient SQLite faults. Treat explicit revision conflicts as superseded projections, reload current debt, and prevent old replan recommendations from stopping the pipeline.

- [x] Add real SQLite regression for report succeeded at R7, manual save R8, assessment conflict; verify R8 metadata/status and range debt survive.
- [x] Add quality-report conflict and transient primary-write retry cases; prove baseline failures.
- [x] Remove duplicate unsafe stub writes and their implementation-mirroring tests. Return a superseded quality projection and suppress the stale recommendation in PipelineJobExecutor.
- [x] Run focused quality/replan/pipeline tests and server build.
- [x] Update ownership wiki, release notes and README; inspect and commit the isolated phase.

Verification: real SQLite baseline 3/3 red (`/tmp/round2-quality-red.log`); server build and 73/73 focused tests pass (`/tmp/round2-quality-final.log`). Covered revision conflict after report write, report conflict, stale replan suppression, transient retry, and current-revision storage failure. No browser acceptance needed for this backend-only phase.
