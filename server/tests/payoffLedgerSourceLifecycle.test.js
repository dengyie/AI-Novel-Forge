const test = require("node:test");
const assert = require("node:assert/strict");
const {
  attachFixedBookContractRefIds,
  buildActiveBookContractRefIds,
  isSourceSupersededFailedItem,
  projectBookContractMajorPayoffsText,
  resolveSupersededBookContractLedgerKeys,
  SOURCE_SUPERSEDED_RISK_CODE,
} = require("../dist/services/payoff/payoffLedgerSourceLifecycle.js");

function major(refId, refLabel = "阶段回报") {
  return {
    kind: "major_payoff",
    refId,
    refLabel,
  };
}

test("buildActiveBookContractRefIds only includes non-empty stage fields", () => {
  assert.deepEqual(buildActiveBookContractRefIds(null), []);
  assert.deepEqual(buildActiveBookContractRefIds({
    chapter3Payoff: "  ",
    chapter10Payoff: "中段反转",
    chapter30Payoff: null,
  }), ["book_contract.chapter10Payoff"]);
  assert.deepEqual(buildActiveBookContractRefIds({
    chapter3Payoff: "开书抓手",
    chapter10Payoff: "第一阶段回报",
    chapter30Payoff: "中段大跃迁",
  }), [
    "book_contract.chapter3Payoff",
    "book_contract.chapter10Payoff",
    "book_contract.chapter30Payoff",
  ]);
});

test("projectBookContractMajorPayoffsText embeds fixed refIds", () => {
  const text = projectBookContractMajorPayoffsText({
    chapter3Payoff: "三章内兑现身份悬念",
    chapter10Payoff: "",
    chapter30Payoff: "三十章大兑现",
  });
  assert.match(text, /book_contract\.chapter3Payoff/);
  assert.match(text, /book_contract\.chapter30Payoff/);
  assert.doesNotMatch(text, /chapter10Payoff/);
  assert.equal(projectBookContractMajorPayoffsText(null), "");
});

test("resolveSupersededBookContractLedgerKeys no-ops without book_contract refIds", () => {
  const keys = resolveSupersededBookContractLedgerKeys({
    existingItems: [{
      ledgerKey: "loose-1",
      currentStatus: "pending_payoff",
      sourceRefs: [{ kind: "major_payoff", refLabel: "旧承诺" }],
    }],
    resolvedItems: [],
    activeBookContractRefIds: [],
  });
  assert.equal(keys.size, 0);
});

test("resolveSupersededBookContractLedgerKeys retires removed pure book_contract source", () => {
  const keys = resolveSupersededBookContractLedgerKeys({
    existingItems: [{
      ledgerKey: "old-ch3",
      currentStatus: "pending_payoff",
      sourceRefs: [major("book_contract.chapter3Payoff", "旧三章回报")],
    }],
    resolvedItems: [],
    activeBookContractRefIds: ["book_contract.chapter10Payoff"],
  });
  assert.deepEqual([...keys], ["old-ch3"]);
});

test("resolveSupersededBookContractLedgerKeys retires reassigned pure book_contract source", () => {
  const keys = resolveSupersededBookContractLedgerKeys({
    existingItems: [{
      ledgerKey: "old-owner",
      currentStatus: "hinted",
      sourceRefs: [major("book_contract.chapter10Payoff")],
    }],
    resolvedItems: [{
      ledgerKey: "new-owner",
      sourceRefs: [major("book_contract.chapter10Payoff")],
    }],
    activeBookContractRefIds: ["book_contract.chapter10Payoff"],
  });
  assert.deepEqual([...keys], ["old-owner"]);
});

test("resolveSupersededBookContractLedgerKeys keeps reused key, paid_off, mixed sources", () => {
  const keys = resolveSupersededBookContractLedgerKeys({
    existingItems: [
      {
        ledgerKey: "reused",
        currentStatus: "pending_payoff",
        sourceRefs: [major("book_contract.chapter3Payoff")],
      },
      {
        ledgerKey: "paid",
        currentStatus: "paid_off",
        sourceRefs: [major("book_contract.chapter10Payoff")],
      },
      {
        ledgerKey: "mixed",
        currentStatus: "pending_payoff",
        sourceRefs: [
          major("book_contract.chapter30Payoff"),
          { kind: "volume_open_payoff", refLabel: "卷义务" },
        ],
      },
    ],
    resolvedItems: [{
      ledgerKey: "reused",
      sourceRefs: [major("book_contract.chapter3Payoff")],
    }],
    activeBookContractRefIds: [],
  });
  assert.equal(keys.size, 0);
});

test("attachFixedBookContractRefIds fills missing refId by label/title match", () => {
  const contract = {
    chapter3Payoff: "三章身份悬念兑现",
    chapter10Payoff: "十章反压",
    chapter30Payoff: "",
  };
  const [item] = attachFixedBookContractRefIds([{
    title: "三章身份悬念兑现",
    summary: "开书抓手",
    sourceRefs: [{
      kind: "major_payoff",
      refLabel: "三章身份悬念兑现",
    }],
  }], contract);
  assert.equal(item.sourceRefs[0].refId, "book_contract.chapter3Payoff");
});

test("attachFixedBookContractRefIds does not invent refs without contract match", () => {
  const [item] = attachFixedBookContractRefIds([{
    title: "无关义务",
    summary: "别的东西",
    sourceRefs: [{
      kind: "major_payoff",
      refLabel: "无关义务",
    }],
  }], {
    chapter3Payoff: "三章身份悬念兑现",
  });
  assert.equal(item.sourceRefs[0].refId, undefined);
});

test("isSourceSupersededFailedItem only matches failed + source_superseded", () => {
  assert.equal(isSourceSupersededFailedItem({
    currentStatus: "failed",
    riskSignals: [{ code: SOURCE_SUPERSEDED_RISK_CODE }],
  }), true);
  assert.equal(isSourceSupersededFailedItem({
    currentStatus: "failed",
    riskSignals: [{ code: "other" }],
  }), false);
  assert.equal(isSourceSupersededFailedItem({
    currentStatus: "pending_payoff",
    riskSignals: [{ code: SOURCE_SUPERSEDED_RISK_CODE }],
  }), false);
  assert.equal(isSourceSupersededFailedItem({
    currentStatus: "failed",
    riskSignalsJson: JSON.stringify([{ code: "source_superseded" }]),
  }), true);
});
