# voice-packs

应用侧全站音色素材目录（seed pack：`SEED_MANIFEST.json` + `wavs/`）。

## 统一资产仓（GitHub private）

完整 seed（含 wav）在私有资产仓，**不**进开源 monorepo：

- **https://github.com/dengyie/AI-Novel-Forge-Assets** → `voice-library/`
  - `packs/05-yuanworld-seed-from-mimo` · 3 silent PCM pipeline seeds
  - `packs/06-external-expand-20260718` · 51 clips · ~21 speakers
  - `packs/07-zh-pilot-20260718` · 408 clips · 115 speakers

克隆后把 `voice-library/packs/*` 同步到本目录或部署机 `docs/voice-packs/`，再走 import API。

> 旧公开仓 `dengyie/ainovel-voice-library-assets` 已并入统一资产仓并**删除**（2026-07-20）。

## 本仓目录

| 目录 | 说明 |
|---|---|
| `00-manifest` | 包索引 |
| `05-yuanworld-seed-from-mimo` | Milestone A 静音 PCM 链路验证种子 |
| `06-external-expand-20260718` | 外部扩充（体积大时以资产仓为准） |
| `07-zh-pilot-20260718` | 中文 115 角色 pilot（同上） |

## 导入与升权

- 导入：`POST /api/novels/audiobook/voice-library/import-seed-pack`（**禁止** import 直批 approved）
- 试听：`POST .../media-access` → `GET .../audio` 写 `heardAt` / `heardSha256`
- 批准：`PATCH .../status` + `X-Voice-Library-Approve-Token`
- 机器标注（可选）：`server/scripts/voice-library-label-enrich.py`（labeled-v2，只改 tags）

## 许可

manifest 内默认 `internal-test-only; license-review-pending`。上游说明见资产仓 `voice-library/NOTICE`；商用前须法务复核。
