const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveBoundProviderId,
  resolveBoundProviderIdForProbe,
  resolveFallbackBaseUrlsRaw,
  resolveTimeoutMs,
  resolvePrimaryBaseURLForProbe,
  resolveEffectiveMimoTtsApiKey,
  __resetAudiobookTtsTransportCacheForTests,
  getCachedAudiobookTtsPrimaryBaseURL,
  getCachedAudiobookTtsBoundProvider,
  invalidateAudiobookTtsTransportCache,
} = require("../dist/services/settings/AudiobookTtsTransportSettingsService.js");
const {
  hasEffectiveMimoTtsMultiEndpointChain,
  parseMimoTtsFallbackBaseUrls,
} = require("../dist/services/audiobook/MimoChatAudioTTSProvider.js");
const {
  DEFAULT_AUDIOBOOK_TTS_BOUND_PROVIDER,
  DEFAULT_AUDIOBOOK_TTS_TIMEOUT_MS,
} = require("../dist/services/settings/audiobookTtsSettingKeys.js");

test("resolveBoundProviderId: override > setting > env > default openai", () => {
  const prev = process.env.AUDIOBOOK_MIMO_TTS_PROVIDER;
  try {
    delete process.env.AUDIOBOOK_MIMO_TTS_PROVIDER;
    assert.deepEqual(resolveBoundProviderId({}), {
      provider: DEFAULT_AUDIOBOOK_TTS_BOUND_PROVIDER,
      source: "default",
    });

    process.env.AUDIOBOOK_MIMO_TTS_PROVIDER = "deepseek";
    assert.deepEqual(resolveBoundProviderId({}), {
      provider: "deepseek",
      source: "env",
    });

    assert.deepEqual(
      resolveBoundProviderId({ storedBoundProvider: "siliconflow" }),
      { provider: "siliconflow", source: "setting" },
    );

    assert.deepEqual(
      resolveBoundProviderId({
        overrideProvider: "custom-cpa",
        storedBoundProvider: "siliconflow",
      }),
      { provider: "custom-cpa", source: "override" },
    );
  } finally {
    if (prev === undefined) delete process.env.AUDIOBOOK_MIMO_TTS_PROVIDER;
    else process.env.AUDIOBOOK_MIMO_TTS_PROVIDER = prev;
  }
});

test("resolveFallbackBaseUrlsRaw: setting before env", () => {
  const prev = process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS;
  try {
    process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS = "https://env.example/v1";
    assert.deepEqual(resolveFallbackBaseUrlsRaw({}), {
      raw: "https://env.example/v1",
      source: "env",
    });
    assert.deepEqual(
      resolveFallbackBaseUrlsRaw({
        storedFallbackBaseUrlsRaw: "https://setting.example/v1,https://b.example/v1",
      }),
      {
        raw: "https://setting.example/v1,https://b.example/v1",
        source: "setting",
      },
    );
    assert.equal(
      parseMimoTtsFallbackBaseUrls("https://setting.example/v1,https://b.example/v1").length,
      2,
    );
  } finally {
    if (prev === undefined) delete process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS;
    else process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS = prev;
  }
});

test("resolveTimeoutMs: setting > env > default", () => {
  const prev = process.env.AUDIOBOOK_MIMO_TTS_TIMEOUT_MS;
  try {
    delete process.env.AUDIOBOOK_MIMO_TTS_TIMEOUT_MS;
    assert.deepEqual(resolveTimeoutMs({}), {
      timeoutMs: DEFAULT_AUDIOBOOK_TTS_TIMEOUT_MS,
      source: "default",
    });

    process.env.AUDIOBOOK_MIMO_TTS_TIMEOUT_MS = "90000";
    assert.deepEqual(resolveTimeoutMs({}), {
      timeoutMs: 90_000,
      source: "env",
    });

    assert.deepEqual(resolveTimeoutMs({ storedTimeoutMs: 180_000 }), {
      timeoutMs: 180_000,
      source: "setting",
    });
  } finally {
    if (prev === undefined) delete process.env.AUDIOBOOK_MIMO_TTS_TIMEOUT_MS;
    else process.env.AUDIOBOOK_MIMO_TTS_TIMEOUT_MS = prev;
  }
});

test("hasEffectiveMimoTtsMultiEndpointChain still env-compatible without cache", () => {
  __resetAudiobookTtsTransportCacheForTests();
  const prevFallback = process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS;
  const prevOpenAi = process.env.OPENAI_BASE_URL;
  const prevBound = process.env.AUDIOBOOK_MIMO_TTS_PROVIDER;
  try {
    delete process.env.AUDIOBOOK_MIMO_TTS_PROVIDER;
    process.env.OPENAI_BASE_URL = "http://primary.test/v1";
    process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS = "https://fufu.test/v1";
    assert.equal(hasEffectiveMimoTtsMultiEndpointChain(), true);

    process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS = "http://primary.test/v1/";
    assert.equal(hasEffectiveMimoTtsMultiEndpointChain(), false);

    delete process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS;
    assert.equal(hasEffectiveMimoTtsMultiEndpointChain(), false);
  } finally {
    process.env.OPENAI_BASE_URL = prevOpenAi;
    if (prevFallback === undefined) delete process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS;
    else process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS = prevFallback;
    if (prevBound === undefined) delete process.env.AUDIOBOOK_MIMO_TTS_PROVIDER;
    else process.env.AUDIOBOOK_MIMO_TTS_PROVIDER = prevBound;
    __resetAudiobookTtsTransportCacheForTests();
  }
});

test("resolvePrimaryBaseURLForProbe uses bound provider env not hardcoded openai", () => {
  __resetAudiobookTtsTransportCacheForTests();
  const prevBound = process.env.AUDIOBOOK_MIMO_TTS_PROVIDER;
  const prevOpenAi = process.env.OPENAI_BASE_URL;
  const prevDeepseek = process.env.DEEPSEEK_BASE_URL;
  const prevFallback = process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS;
  try {
    process.env.AUDIOBOOK_MIMO_TTS_PROVIDER = "deepseek";
    process.env.OPENAI_BASE_URL = "http://openai-primary.test/v1";
    process.env.DEEPSEEK_BASE_URL = "http://deepseek-primary.test/v1";
    process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS = "http://openai-primary.test/v1";

    assert.equal(resolveBoundProviderIdForProbe().provider, "deepseek");
    assert.equal(
      resolvePrimaryBaseURLForProbe(),
      "http://deepseek-primary.test/v1",
    );
    // fallback 与 deepseek primary 不同 → 有效多端
    assert.equal(hasEffectiveMimoTtsMultiEndpointChain(), true);

    // fallback 与 deepseek 同址 → 单端（若仍 hardcode openai 会误判 multi）
    process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS = "http://deepseek-primary.test/v1/";
    assert.equal(hasEffectiveMimoTtsMultiEndpointChain(), false);
  } finally {
    if (prevBound === undefined) delete process.env.AUDIOBOOK_MIMO_TTS_PROVIDER;
    else process.env.AUDIOBOOK_MIMO_TTS_PROVIDER = prevBound;
    process.env.OPENAI_BASE_URL = prevOpenAi;
    if (prevDeepseek === undefined) delete process.env.DEEPSEEK_BASE_URL;
    else process.env.DEEPSEEK_BASE_URL = prevDeepseek;
    if (prevFallback === undefined) delete process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS;
    else process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS = prevFallback;
    __resetAudiobookTtsTransportCacheForTests();
  }
});

test("resolvePrimaryBaseURLForProbe prefers explicit input then cache", () => {
  __resetAudiobookTtsTransportCacheForTests();
  assert.equal(
    resolvePrimaryBaseURLForProbe("http://explicit.test/v1/"),
    "http://explicit.test/v1",
  );
  assert.equal(getCachedAudiobookTtsPrimaryBaseURL(), undefined);
  assert.equal(getCachedAudiobookTtsBoundProvider(), undefined);
  invalidateAudiobookTtsTransportCache();
});

test("resolveEffectiveMimoTtsApiKey does not cross-borrow for non-CPA providers", async () => {
  // 无 DB secret 时：siliconflow 自身无 env key → none，不借 openai
  const prevOpenAiKey = process.env.OPENAI_API_KEY;
  try {
    process.env.OPENAI_API_KEY = "sk-openai-only";
    const silicon = await resolveEffectiveMimoTtsApiKey("siliconflow");
    assert.equal(silicon.apiKey, undefined);
    assert.equal(silicon.effectiveSource, "none");
    assert.equal(silicon.fromProvider, null);

    // openai 可借 deepseek；此处 openai env 有 key
    const openai = await resolveEffectiveMimoTtsApiKey("openai");
    assert.equal(openai.apiKey, "sk-openai-only");
    assert.equal(openai.effectiveSource, "env");
    assert.equal(openai.fromProvider, "openai");
  } finally {
    if (prevOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOpenAiKey;
  }
});
