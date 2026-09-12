// m4b 队列测试共享全局 M4bEncodingJob 表与 pending 队列，并发测试文件会互相
// 领走对方 job。所有向队列创建 job 的测试必须用此 O_EXCL 文件锁把「入队→领取→
// 断言」整段串行化。锁文件 3 分钟无 mtime 更新视为崩溃残留可强占。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LOCK_PATH = path.join(os.tmpdir(), "m4b-queue-test.lock");

async function withQueueLock(fn) {
  let fd = null;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try {
      fd = fs.openSync(LOCK_PATH, "wx");
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const stat = fs.statSync(LOCK_PATH);
        if (Date.now() - stat.mtimeMs > 180000) {
          fs.unlinkSync(LOCK_PATH);
          continue;
        }
      } catch {
        // 锁文件刚好被释放，继续重试
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  if (fd === null) throw new Error("m4b queue test lock timeout");
  try {
    fs.utimesSync(LOCK_PATH, new Date(), new Date());
    return await fn();
  } finally {
    fs.closeSync(fd);
    try {
      fs.unlinkSync(LOCK_PATH);
    } catch {
      // 已被强占方删除
    }
  }
}

module.exports = { withQueueLock };
