import test from "node:test";
import assert from "node:assert/strict";

import {
  isChapterContentConflictError,
  resolveChapterContentSync,
} from "./chapterEditorUtils.ts";

test("isChapterContentConflictError requires 409 + CHAPTER_CONTENT_CONFLICT code", () => {
  const conflict = Object.assign(new Error("conflict"), {
    status: 409,
    details: { details: { code: "CHAPTER_CONTENT_CONFLICT" } },
  });
  assert.equal(isChapterContentConflictError(conflict), true);

  const wrongCode = Object.assign(new Error("conflict"), {
    status: 409,
    details: { details: { code: "OTHER" } },
  });
  assert.equal(isChapterContentConflictError(wrongCode), false);

  const notConflict = Object.assign(new Error("server"), {
    status: 500,
    details: { details: { code: "CHAPTER_CONTENT_CONFLICT" } },
  });
  assert.equal(isChapterContentConflictError(notConflict), false);
  assert.equal(isChapterContentConflictError(new Error("plain")), false);
  assert.equal(isChapterContentConflictError(null), false);
});

test("resolveChapterContentSync full resets on chapter change", () => {
  const decision = resolveChapterContentSync({
    chapterChanged: true,
    nextServerContent: "server-new",
    currentDraft: "local-dirty",
    currentSaved: "local-old",
    preserveLocalDraft: true,
  });
  assert.deepEqual(decision, { action: "full_reset", content: "server-new" });
});

test("resolveChapterContentSync keeps local draft when dirty", () => {
  const decision = resolveChapterContentSync({
    chapterChanged: false,
    nextServerContent: "server-new",
    currentDraft: "local-dirty",
    currentSaved: "local-old",
    preserveLocalDraft: false,
  });
  assert.deepEqual(decision, {
    action: "keep_local_draft",
    serverContent: "server-new",
    reason: "dirty",
  });
});

test("resolveChapterContentSync keeps local draft when preserve flag set even if clean", () => {
  const decision = resolveChapterContentSync({
    chapterChanged: false,
    nextServerContent: "server-new",
    currentDraft: "same",
    currentSaved: "same",
    preserveLocalDraft: true,
  });
  assert.deepEqual(decision, {
    action: "keep_local_draft",
    serverContent: "server-new",
    reason: "conflict",
  });
});

test("resolveChapterContentSync follows server when clean and no preserve", () => {
  const decision = resolveChapterContentSync({
    chapterChanged: false,
    nextServerContent: "server-new",
    currentDraft: "same",
    currentSaved: "same",
    preserveLocalDraft: false,
  });
  assert.deepEqual(decision, { action: "full_reset", content: "server-new" });
});
