const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveVolumeOrderRange,
} = require("../dist/services/novel/volume/volumeOrderRange.js");

test("fallback_20 when no volume workspace", async () => {
  const range = await resolveVolumeOrderRange({
    novelId: "n1",
    volumeOrder: 2,
    maxChapterOrder: 50,
    volumeService: {
      async getVolumes() {
        return { volumes: [] };
      },
    },
  });
  assert.equal(range.source, "fallback_20");
  assert.equal(range.fromOrder, 21);
  assert.equal(range.toOrder, 40);
});

test("volume_workspace uses chapterOrder min/max", async () => {
  const range = await resolveVolumeOrderRange({
    novelId: "n1",
    volumeOrder: 1,
    maxChapterOrder: 100,
    volumeService: {
      async getVolumes() {
        return {
          volumes: [
            {
              id: "v1",
              title: "卷一",
              sortOrder: 0,
              chapters: [
                { chapterOrder: 3 },
                { chapterOrder: 1 },
                { chapterOrder: 7 },
              ],
            },
            {
              id: "v2",
              title: "卷二",
              sortOrder: 1,
              chapters: [
                { chapterOrder: 8 },
                { chapterOrder: 20 },
              ],
            },
          ],
        };
      },
    },
  });
  assert.equal(range.source, "volume_workspace");
  assert.equal(range.fromOrder, 1);
  assert.equal(range.toOrder, 7);
  assert.equal(range.volumeTitle, "卷一");
});

test("volumeOrder 2 picks second volume by sortOrder", async () => {
  const range = await resolveVolumeOrderRange({
    novelId: "n1",
    volumeOrder: 2,
    maxChapterOrder: 100,
    volumeService: {
      async getVolumes() {
        return {
          volumes: [
            {
              id: "v1",
              sortOrder: 0,
              chapters: [{ chapterOrder: 1 }, { chapterOrder: 10 }],
            },
            {
              id: "v2",
              sortOrder: 1,
              chapters: [{ chapterOrder: 11 }, { chapterOrder: 25 }],
            },
          ],
        };
      },
    },
  });
  assert.equal(range.fromOrder, 11);
  assert.equal(range.toOrder, 25);
  assert.equal(range.source, "volume_workspace");
});

test("clamps to maxChapterOrder", async () => {
  const range = await resolveVolumeOrderRange({
    novelId: "n1",
    volumeOrder: 1,
    maxChapterOrder: 5,
    volumeService: {
      async getVolumes() {
        return {
          volumes: [{
            id: "v1",
            sortOrder: 0,
            chapters: [{ chapterOrder: 1 }, { chapterOrder: 20 }],
          }],
        };
      },
    },
  });
  assert.equal(range.fromOrder, 1);
  assert.equal(range.toOrder, 5);
});
