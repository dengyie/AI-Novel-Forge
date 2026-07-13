const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  novelThemeWorldGenerationSchema,
} = require("../dist/prompting/prompts/world/world.promptSchemas.js");

test("theme world schema accepts sparse LLM payload without repair", () => {
  const parsed = novelThemeWorldGenerationSchema.parse({
    title: "源世界",
    structuredData: {
      profile: { summary: "当代隐秘异能秩序" },
      rules: {
        axioms: [
          { name: "夺取需同意", summary: "成功则原主死" },
        ],
      },
      factions: [{ name: "秩序侧" }, { name: "黑市侧" }],
      forces: [{ name: "协衡署" }],
      locations: [{ name: "澄湾市" }],
    },
  });
  assert.equal(parsed.title, "源世界");
  assert.equal(parsed.coverSummary.length > 0, true);
  assert.equal(parsed.worldType.length > 0, true);
  assert.equal(parsed.structuredData.factions.length, 2);
  assert.equal(parsed.structuredData.relations.forceRelations.length, 0);
});

test("theme world schema fills missing top-level strings", () => {
  const parsed = novelThemeWorldGenerationSchema.parse({
    structuredData: {},
  });
  assert.ok(parsed.title);
  assert.ok(parsed.coverSummary);
  assert.ok(parsed.worldType);
});
