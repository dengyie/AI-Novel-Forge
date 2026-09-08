export function createM4bAbortError(): Error {
  const error = new Error("m4b 封装已取消。");
  error.name = "AbortError";
  return error;
}
