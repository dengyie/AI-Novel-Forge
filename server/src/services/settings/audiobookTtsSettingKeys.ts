/**
 * 有声书 MiMo TTS 运输层 AppSetting 键（非密钥）。
 * 密钥仍走 SecretStore/APIKey + env；fallback keys 一期仅 env。
 */

export const AUDIOBOOK_TTS_BOUND_PROVIDER_KEY = "audiobook.tts.boundProvider";
export const AUDIOBOOK_TTS_PRIMARY_BASE_URL_KEY = "audiobook.tts.primaryBaseURL";
export const AUDIOBOOK_TTS_FALLBACK_BASE_URLS_KEY = "audiobook.tts.fallbackBaseUrls";
export const AUDIOBOOK_TTS_TIMEOUT_MS_KEY = "audiobook.tts.timeoutMs";

export const AUDIOBOOK_TTS_TRANSPORT_SETTING_KEYS = [
  AUDIOBOOK_TTS_BOUND_PROVIDER_KEY,
  AUDIOBOOK_TTS_PRIMARY_BASE_URL_KEY,
  AUDIOBOOK_TTS_FALLBACK_BASE_URLS_KEY,
  AUDIOBOOK_TTS_TIMEOUT_MS_KEY,
] as const;

export type AudiobookTtsTransportSettingKey =
  (typeof AUDIOBOOK_TTS_TRANSPORT_SETTING_KEYS)[number];

/** 与 MimoChatAudioTTSProvider 历史默认一致 */
export const DEFAULT_AUDIOBOOK_TTS_BOUND_PROVIDER = "openai";

export const DEFAULT_AUDIOBOOK_TTS_TIMEOUT_MS = 120_000;
export const MIN_AUDIOBOOK_TTS_TIMEOUT_MS = 10_000;
export const MAX_AUDIOBOOK_TTS_TIMEOUT_MS = 600_000;

/** bootstrap / 无库时 env */
export const ENV_AUDIOBOOK_TTS_PROVIDER = "AUDIOBOOK_MIMO_TTS_PROVIDER";
export const ENV_AUDIOBOOK_TTS_FALLBACK_BASE_URLS = "AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS";
export const ENV_AUDIOBOOK_TTS_FALLBACK_API_KEYS = "AUDIOBOOK_MIMO_TTS_FALLBACK_API_KEYS";
export const ENV_AUDIOBOOK_TTS_TIMEOUT_MS = "AUDIOBOOK_MIMO_TTS_TIMEOUT_MS";
