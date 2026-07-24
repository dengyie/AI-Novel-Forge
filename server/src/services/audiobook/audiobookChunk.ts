/**
 * @deprecated M4: 分块逻辑已搬至 `frontend/chunker.ts`。
 * 此处保留为薄 re-export，供旧 caller 与门禁 test（`from dist/services/audiobook/audiobookChunk.js`）
 * 零改动过渡；M5/M7 稳定后连同 re-export 一并删除，让 caller 直接 import 自 `frontend/chunker.ts`。
 *
 * 收编来源见 `frontend/chunker.ts`；契约与旧一致（chunk text + fingerprint byte-identical）。
 */
export {
  splitTextForTts,
  coalesceSegmentsBySpeaker,
  expandSegmentsToChunkJobs,
  type ChunkJob,
} from "./frontend/chunker";
