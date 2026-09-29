import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAudiobookTaskPollInterval } from './taskPolling.ts';

test('completed WAV keeps polling until independent M4B reaches a terminal status', () => {
  assert.equal(resolveAudiobookTaskPollInterval([{ status: 'succeeded', m4bStatus: 'encoding' }]), 4000);
  for (const status of ['ready', 'failed', 'skipped']) {
    assert.equal(resolveAudiobookTaskPollInterval([{ status: 'succeeded', m4bStatus: status }]), false);
  }
});
test('legacy missing state and cancelled work do not poll forever', () => {
  for (const task of [{ status: 'succeeded' }, { status: 'succeeded', m4bStatus: null }, { status: 'cancelled', m4bStatus: 'encoding' }]) {
    assert.equal(resolveAudiobookTaskPollInterval([task]), false);
  }
  assert.equal(resolveAudiobookTaskPollInterval([]), false);
});
test('chapter generation still polls regardless of M4B status', () => {
  for (const status of ['queued', 'running']) assert.equal(resolveAudiobookTaskPollInterval([{ status }]), 4000);
});
