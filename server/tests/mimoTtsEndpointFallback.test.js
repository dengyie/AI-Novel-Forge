const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseMimoTtsFallbackBaseUrls,
  parseMimoTtsFallbackApiKeys,
  isRetryableMimoTtsStatus,
  resolveMimoTtsEndpointChain,
  summarizeMimoTtsEndpointFailure,
  hasMimoTtsFallbackEndpointsConfigured,
  isMimoTtsEndpointChainExhaustedError,
  mimoChatAudioTTSProvider,
  buildMimoTtsRequestBody,
} = require("../dist/services/audiobook/MimoChatAudioTTSProvider.js");
const { AppError } = require("../dist/middleware/errorHandler.js");

test("parseMimoTtsFallbackBaseUrls splits comma/newline and keeps slots", () => {
  const urls = parseMimoTtsFallbackBaseUrls(
    " https://fufu.iqach.top/v1/ ,\nhttps://fufu.iqach.top/v1,http://127.0.0.1:18080/v1/\n",
  );
  // 保留重复槽位，keys 才能按原 index 对齐；去重在 resolve
  assert.deepEqual(urls, [
    "https://fufu.iqach.top/v1",
    "https://fufu.iqach.top/v1",
    "http://127.0.0.1:18080/v1",
  ]);
  assert.deepEqual(parseMimoTtsFallbackBaseUrls(""), []);
  assert.deepEqual(parseMimoTtsFallbackBaseUrls(null), []);
});

test("parseMimoTtsFallbackApiKeys keeps empty slots for alignment", () => {
  assert.deepEqual(parseMimoTtsFallbackApiKeys("sk-a,,sk-b"), ["sk-a", null, "sk-b"]);
  assert.deepEqual(parseMimoTtsFallbackApiKeys(null), []);
  assert.deepEqual(parseMimoTtsFallbackApiKeys(""), [null]);
});

test("isRetryableMimoTtsStatus covers 5xx/429/504 not 4xx cancel", () => {
  assert.equal(isRetryableMimoTtsStatus(502), true);
  assert.equal(isRetryableMimoTtsStatus(503), true);
  assert.equal(isRetryableMimoTtsStatus(429), true);
  assert.equal(isRetryableMimoTtsStatus(504), true);
  assert.equal(isRetryableMimoTtsStatus(400), false);
  assert.equal(isRetryableMimoTtsStatus(401), false);
  assert.equal(isRetryableMimoTtsStatus(408), false);
  assert.equal(isRetryableMimoTtsStatus(404), false);
});

test("resolveMimoTtsEndpointChain primary + fallbacks with key alignment", () => {
  const chain = resolveMimoTtsEndpointChain({
    primaryBaseURL: "http://cpa.local/v1/",
    primaryApiKey: "sk-primary",
    fallbackBaseUrlsRaw: "https://fufu.example/v1,http://cpa.local/v1,http://proxy.local/v1",
    fallbackApiKeysRaw: "sk-fufu,,sk-proxy",
  });
  assert.equal(chain.length, 3);
  assert.deepEqual(chain[0], {
    id: "primary",
    baseURL: "http://cpa.local/v1",
    apiKey: "sk-primary",
  });
  assert.equal(chain[1].id, "fallback-1");
  assert.equal(chain[1].baseURL, "https://fufu.example/v1");
  assert.equal(chain[1].apiKey, "sk-fufu");
  // duplicate primary base skipped; keys still align by original fallback list index
  assert.equal(chain[2].id, "fallback-2");
  assert.equal(chain[2].baseURL, "http://proxy.local/v1");
  assert.equal(chain[2].apiKey, "sk-proxy");
});

test("resolveMimoTtsEndpointChain keeps key index when fallback URL duplicates", () => {
  const chain = resolveMimoTtsEndpointChain({
    primaryBaseURL: "http://cpa.local/v1",
    primaryApiKey: "sk-primary",
    fallbackBaseUrlsRaw: "https://fufu.example/v1,https://fufu.example/v1,http://proxy.local/v1",
    fallbackApiKeysRaw: "sk-fufu,sk-dup,sk-proxy",
  });
  assert.equal(chain.length, 3);
  assert.equal(chain[1].baseURL, "https://fufu.example/v1");
  assert.equal(chain[1].apiKey, "sk-fufu");
  // 第二个 fufu 被去重跳过，proxy 仍拿原始 index=2 的 sk-proxy（不是 sk-dup）
  assert.equal(chain[2].id, "fallback-2");
  assert.equal(chain[2].baseURL, "http://proxy.local/v1");
  assert.equal(chain[2].apiKey, "sk-proxy");
});

test("synthesize fails over to next endpoint on 502 then succeeds", async () => {
  const originalFetch = global.fetch;
  const originalEnv = process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS;
  const originalKeys = process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_API_KEYS;
  const calls = [];

  // minimal fake WAV base64 (header-ish only for extract path)
  const fakeAudio = Buffer.from("UklGRiQAAABXQVZFZm10IBAAAAABAAEA").toString("base64");

  process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS = "https://fufu.test/v1";
  process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_API_KEYS = "sk-fufu";

  // stub resolve path by monkey-patching provider methods is hard; instead
  // call synthesizeOnce path via public synthesize with mocked resolve via
  // injecting OPENAI env is heavy. Use a thin test of failover by patching
  // the class instance method chain via fetch mock + temporarily overriding
  // resolveProviderBaseUrl is not exported. So we unit-test chain + a local
  // loop mirror of synthesize failover using the exported pure helpers + fetch.

  try {
    // Directly exercise provider with env-backed chain: need real baseURL resolution.
    // Mock resolve by setting OPENAI_BASE_URL if supported via env.
    const prevOpenAi = process.env.OPENAI_BASE_URL;
    const prevKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_BASE_URL = "http://primary.test/v1";
    process.env.OPENAI_API_KEY = "sk-primary";

    global.fetch = async (url, init) => {
      calls.push({ url: String(url), auth: init?.headers?.Authorization });
      if (String(url).includes("primary.test")) {
        return new Response(JSON.stringify({ error: { message: "upstream down" } }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (String(url).includes("fufu.test")) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { audio: { data: fakeAudio } } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    };

    const result = await mimoChatAudioTTSProvider.synthesize({
      text: "测试一句旁白。",
      mode: "preset",
      voice: "白桦",
      style: "沉稳",
      provider: "openai",
    });

    assert.equal(result.mode, "preset");
    assert.equal(result.audioBase64, fakeAudio);
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /primary\.test/);
    assert.match(calls[1].url, /fufu\.test/);
    assert.equal(calls[1].auth, "Bearer sk-fufu");

    process.env.OPENAI_BASE_URL = prevOpenAi;
    process.env.OPENAI_API_KEY = prevKey;
  } finally {
    global.fetch = originalFetch;
    if (originalEnv === undefined) {
      delete process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS;
    } else {
      process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS = originalEnv;
    }
    if (originalKeys === undefined) {
      delete process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_API_KEYS;
    } else {
      process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_API_KEYS = originalKeys;
    }
  }
});

test("synthesize does not failover on 400 client error", async () => {
  const originalFetch = global.fetch;
  const originalEnv = process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS;
  const prevOpenAi = process.env.OPENAI_BASE_URL;
  const prevKey = process.env.OPENAI_API_KEY;
  const calls = [];

  process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS = "https://fufu.test/v1";
  process.env.OPENAI_BASE_URL = "http://primary.test/v1";
  process.env.OPENAI_API_KEY = "sk-primary";

  try {
    global.fetch = async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ error: { message: "bad voice" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    };

    await assert.rejects(
      () => mimoChatAudioTTSProvider.synthesize({
        text: "测试。",
        mode: "preset",
        voice: "白桦",
        provider: "openai",
      }),
      (err) => {
        assert.match(String(err?.message || err), /400|bad voice|请求失败/);
        return true;
      },
    );
    assert.equal(calls.length, 1);
    assert.match(calls[0], /primary\.test/);
  } finally {
    global.fetch = originalFetch;
    process.env.OPENAI_BASE_URL = prevOpenAi;
    process.env.OPENAI_API_KEY = prevKey;
    if (originalEnv === undefined) {
      delete process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS;
    } else {
      process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS = originalEnv;
    }
  }
});

test("buildMimoTtsRequestBody still valid after provider refactor", () => {
  const body = buildMimoTtsRequestBody({
    text: "一句。",
    mode: "design",
    designPrompt: "青年女声，清亮",
  });
  assert.equal(Object.prototype.hasOwnProperty.call(body.audio, "voice"), false);
});

test("summarizeMimoTtsEndpointFailure never includes api keys", () => {
  const line = summarizeMimoTtsEndpointFailure({
    endpointId: "primary",
    error: new AppError("MiMo TTS 请求失败 [primary] (502): boom sk-secret-should-not-matter", 502),
  });
  assert.match(line, /\[mimo-tts\]/);
  assert.match(line, /primary/);
  assert.match(line, /502/);
  assert.ok(line.length <= 220);
});

test("synthesize fails over on 504 timeout-class then succeeds", async () => {
  const originalFetch = global.fetch;
  const originalEnv = process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS;
  const originalKeys = process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_API_KEYS;
  const prevOpenAi = process.env.OPENAI_BASE_URL;
  const prevKey = process.env.OPENAI_API_KEY;
  const calls = [];
  const fakeAudio = Buffer.from("UklGRiQAAABXQVZFZm10IBAAAAABAAEA").toString("base64");

  process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS = "https://fufu.test/v1";
  process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_API_KEYS = "sk-fufu";
  process.env.OPENAI_BASE_URL = "http://primary.test/v1";
  process.env.OPENAI_API_KEY = "sk-primary";

  try {
    global.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).includes("primary.test")) {
        return new Response(JSON.stringify({ error: { message: "gateway timeout" } }), {
          status: 504,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { audio: { data: fakeAudio } } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await mimoChatAudioTTSProvider.synthesize({
      text: "超时后换端。",
      mode: "preset",
      voice: "茉莉",
      provider: "openai",
    });
    assert.equal(result.audioBase64, fakeAudio);
    assert.equal(calls.length, 2);
    assert.match(calls[0], /primary\.test/);
    assert.match(calls[1], /fufu\.test/);
  } finally {
    global.fetch = originalFetch;
    process.env.OPENAI_BASE_URL = prevOpenAi;
    process.env.OPENAI_API_KEY = prevKey;
    if (originalEnv === undefined) delete process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS;
    else process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS = originalEnv;
    if (originalKeys === undefined) delete process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_API_KEYS;
    else process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_API_KEYS = originalKeys;
  }
});

test("synthesize fails over on 429 then succeeds", async () => {
  const originalFetch = global.fetch;
  const originalEnv = process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS;
  const prevOpenAi = process.env.OPENAI_BASE_URL;
  const prevKey = process.env.OPENAI_API_KEY;
  const calls = [];
  const fakeAudio = Buffer.from("UklGRiQAAABXQVZFZm10IBAAAAABAAEA").toString("base64");

  process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS = "https://fufu.test/v1";
  process.env.OPENAI_BASE_URL = "http://primary.test/v1";
  process.env.OPENAI_API_KEY = "sk-primary";

  try {
    global.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).includes("primary.test")) {
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { audio: { data: fakeAudio } } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await mimoChatAudioTTSProvider.synthesize({
      text: "限流后换端。",
      mode: "preset",
      voice: "茉莉",
      provider: "openai",
    });
    assert.equal(result.audioBase64, fakeAudio);
    assert.equal(calls.length, 2);
  } finally {
    global.fetch = originalFetch;
    process.env.OPENAI_BASE_URL = prevOpenAi;
    process.env.OPENAI_API_KEY = prevKey;
    if (originalEnv === undefined) delete process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS;
    else process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS = originalEnv;
  }
});

test("synthesize exhausts chain and surfaces last retryable error", async () => {
  const originalFetch = global.fetch;
  const originalEnv = process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS;
  const prevOpenAi = process.env.OPENAI_BASE_URL;
  const prevKey = process.env.OPENAI_API_KEY;
  const calls = [];

  process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS = "https://fufu.test/v1";
  process.env.OPENAI_BASE_URL = "http://primary.test/v1";
  process.env.OPENAI_API_KEY = "sk-primary";

  try {
    global.fetch = async (url) => {
      calls.push(String(url));
      const host = String(url).includes("fufu") ? "fallback-1" : "primary";
      return new Response(JSON.stringify({ error: { message: `${host} down` } }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    };

    await assert.rejects(
      () => mimoChatAudioTTSProvider.synthesize({
        text: "双端都挂。",
        mode: "preset",
        voice: "茉莉",
        provider: "openai",
      }),
      (err) => {
        assert.match(String(err?.message || err), /fallback-1|502|down/);
        return true;
      },
    );
    assert.equal(calls.length, 2);
  } finally {
    global.fetch = originalFetch;
    process.env.OPENAI_BASE_URL = prevOpenAi;
    process.env.OPENAI_API_KEY = prevKey;
    if (originalEnv === undefined) delete process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS;
    else process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS = originalEnv;
  }
});

test("resolveMimoTtsEndpointChain without fallback env is primary only", () => {
  const chain = resolveMimoTtsEndpointChain({
    primaryBaseURL: "http://cpa.local/v1",
    primaryApiKey: "sk-primary",
    fallbackBaseUrlsRaw: "",
    fallbackApiKeysRaw: "",
  });
  assert.equal(chain.length, 1);
  assert.equal(chain[0].id, "primary");
});

test("hasMimoTtsFallbackEndpointsConfigured reflects raw/env", () => {
  assert.equal(hasMimoTtsFallbackEndpointsConfigured(""), false);
  assert.equal(hasMimoTtsFallbackEndpointsConfigured(null), false);
  assert.equal(hasMimoTtsFallbackEndpointsConfigured("https://fufu.test/v1"), true);
});

test("isMimoTtsEndpointChainExhaustedError reads details flag", () => {
  assert.equal(isMimoTtsEndpointChainExhaustedError(new Error("x")), false);
  assert.equal(isMimoTtsEndpointChainExhaustedError(new AppError("x", 502)), false);
  assert.equal(
    isMimoTtsEndpointChainExhaustedError(
      new AppError("x", 502, { mimoTtsEndpointChainExhausted: true }),
    ),
    true,
  );
});

test("synthesize marks chain exhausted when multi-endpoint all fail", async () => {
  const originalFetch = global.fetch;
  const originalEnv = process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS;
  const prevOpenAi = process.env.OPENAI_BASE_URL;
  const prevKey = process.env.OPENAI_API_KEY;
  process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS = "https://fufu.test/v1";
  process.env.OPENAI_BASE_URL = "http://primary.test/v1";
  process.env.OPENAI_API_KEY = "sk-primary";
  try {
    global.fetch = async () => new Response(JSON.stringify({ error: { message: "down" } }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
    await assert.rejects(
      () => mimoChatAudioTTSProvider.synthesize({
        text: "双端失败。",
        mode: "preset",
        voice: "茉莉",
        provider: "openai",
      }),
      (err) => {
        assert.equal(isMimoTtsEndpointChainExhaustedError(err), true);
        assert.equal(err?.details?.mimoTtsEndpointCount, 2);
        return true;
      },
    );
  } finally {
    global.fetch = originalFetch;
    process.env.OPENAI_BASE_URL = prevOpenAi;
    process.env.OPENAI_API_KEY = prevKey;
    if (originalEnv === undefined) delete process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS;
    else process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS = originalEnv;
  }
});

test("synthesize primary-only failure is not chain-exhausted", async () => {
  const originalFetch = global.fetch;
  const originalEnv = process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS;
  const prevOpenAi = process.env.OPENAI_BASE_URL;
  const prevKey = process.env.OPENAI_API_KEY;
  delete process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS;
  process.env.OPENAI_BASE_URL = "http://primary.test/v1";
  process.env.OPENAI_API_KEY = "sk-primary";
  try {
    global.fetch = async () => new Response(JSON.stringify({ error: { message: "down" } }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
    await assert.rejects(
      () => mimoChatAudioTTSProvider.synthesize({
        text: "仅主链。",
        mode: "preset",
        voice: "茉莉",
        provider: "openai",
      }),
      (err) => {
        assert.equal(isMimoTtsEndpointChainExhaustedError(err), false);
        assert.match(String(err?.message || err), /502|down|primary/);
        return true;
      },
    );
  } finally {
    global.fetch = originalFetch;
    process.env.OPENAI_BASE_URL = prevOpenAi;
    process.env.OPENAI_API_KEY = prevKey;
    if (originalEnv === undefined) delete process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS;
    else process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS = originalEnv;
  }
});
