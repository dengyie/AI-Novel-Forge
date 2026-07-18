# voice-packs

应用侧全站音色素材目录（seed pack：`SEED_MANIFEST.json` + `wavs/`）。

## 公共资产（GitHub public）

完整可再分发 seed（含 wav）在公开仓，**不**依赖本 monorepo 是否 private：

- **https://github.com/dengyie/ainovel-voice-library-assets**
  - `packs/06-external-expand-20260718` · 51 clips · ~21 speakers
  - `packs/07-zh-pilot-20260718` · 408 clips · 115 speakers

克隆后可把 `packs/*` 同步到本目录或部署机 `docs/voice-packs/`，再走 import API。

## 本仓目录

| 目录 | 说明 |
|---|---|
| `00-manifest` | 包索引 |
| `05-yuanworld-seed-from-mimo` | Milestone A 静音 PCM 链路验证种子 |
| `06-external-expand-20260718` | 外部扩充（可与公开仓同步；体积大时以公开仓为准） |
| `07-zh-pilot-20260718` | 中文 115 角色 pilot（同上） |

## 导入与升权

- 导入：`POST /api/novels/audiobook/voice-library/import-seed-pack`（**禁止** import 直批 approved）
- 试听：`POST .../media-access` → `GET .../audio` 写 `heardAt` / `heardSha256`
- 批准：`PATCH .../status` + `X-Voice-Library-Approve-Token`
- 机器标注（可选）：`server/scripts/voice-library-label-enrich.py`（labeled-v2，只改 tags）

## 许可

manifest 内默认 `internal-test-only; license-review-pending`。公开仓 [NOTICE](https://github.com/dengyie/ainovel-voice-library-assets/blob/main/NOTICE) 列上游；商用前须法务复核。
