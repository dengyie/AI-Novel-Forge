/**
 * 角色音色 ref / 库绑定更新决策（与客户端 buildCharacterTtsRefSaveFields 对齐）。
 * - 非空 assetId → 绑库（忽略同请求 base64）
 * - 否则有 base64 → 写盘并清 asset（含 ttsVoiceAssetId:null 同请求）
 * - 否则 assetId === null → 仅清 asset 绑定
 * - 否则不改 voice ref
 */
export type CharacterVoiceRefUpdateDecision =
  | { action: "bind"; voiceAssetId: string }
  | { action: "write_base64"; base64: string }
  | { action: "clear_asset" }
  | { action: "none" };

export function decideCharacterVoiceRefUpdate(input: {
  ttsVoiceAssetId?: string | null;
  ttsRefAudioBase64?: string | null;
}): CharacterVoiceRefUpdateDecision {
  const assetId = input.ttsVoiceAssetId;
  const base64 = (input.ttsRefAudioBase64 ?? "").trim();

  if (typeof assetId === "string" && assetId.trim()) {
    return { action: "bind", voiceAssetId: assetId.trim() };
  }
  if (base64) {
    return { action: "write_base64", base64 };
  }
  if (assetId === null) {
    return { action: "clear_asset" };
  }
  return { action: "none" };
}
