const test = require('node:test');
const assert = require('node:assert/strict');
const settings = require('../dist/services/settings/AudiobookTtsTransportSettingsService.js');
const { MimoChatAudioTTSProvider, TtsUpstreamCircuitBreaker } = require('../dist/services/audiobook/MimoChatAudioTTSProvider.js');
const transport = { primaryBaseURL: 'http://primary.test/v1', primaryApiKey: 'test', timeoutMs: 10000 };
const input = { text: '测试正文', voice: '白桦', mode: 'preset' };
for (const cancelDuringSettings of [false, true]) {
  test(`cancelled synthesis never calls upstream (during settings: ${cancelDuringSettings})`, async (t) => {
    const controller = new AbortController();
    let calls = 0;
    t.mock.method(settings, 'resolveMimoTtsTransportForSynthesize', async () => {
      if (cancelDuringSettings) controller.abort();
      return transport;
    });
    t.mock.method(global, 'fetch', async () => {
      calls++;
      return new Response(JSON.stringify({ choices: [{ message: { audio: { data: 'YXVkaW8=' } } }] }));
    });
    if (!cancelDuringSettings) controller.abort();
    await assert.rejects(new MimoChatAudioTTSProvider().synthesize({ ...input, signal: controller.signal }), error => error.statusCode === 408);
    assert.equal(calls, 0);
  });
}
test('real HTTP 503 opens configured circuit and prevents next upstream call', async (t) => {
  t.mock.method(settings, 'resolveMimoTtsTransportForSynthesize', async () => transport);
  let calls = 0;
  t.mock.method(global, 'fetch', async () => { calls++; return new Response('busy', { status: 503 }); });
  const provider = new MimoChatAudioTTSProvider();
  provider.setUpstreamCircuit(new TtsUpstreamCircuitBreaker({ maxBurstFailures: 1, cooldownMs: 30000 }));
  await assert.rejects(provider.synthesize(input), error => error.statusCode === 503);
  await assert.rejects(provider.synthesize(input), error => error.statusCode === 503);
  assert.equal(calls, 1);
});

for (const phase of ['fetch', 'body']) {
  test(`cancellation during ${phase} aborts owned request without endpoint fallback`, async (t) => {
    const controller = new AbortController();
    t.mock.method(settings, 'resolveMimoTtsTransportForSynthesize', async () => ({ ...transport, fallbackBaseUrlsRaw: 'http://fallback.test/v1' }));
    let calls = 0;
    t.mock.method(global, 'fetch', async (_url, init) => {
      calls++;
      const abort = async () => {
        controller.abort();
        assert.equal(init.signal.aborted, true);
        throw new DOMException('aborted', 'AbortError');
      };
      if (phase === 'fetch') return abort();
      return { ok: true, text: abort };
    });
    await assert.rejects(new MimoChatAudioTTSProvider().synthesize({ ...input, signal: controller.signal }), error => error.statusCode === 408);
    assert.equal(calls, 1);
  });
}
