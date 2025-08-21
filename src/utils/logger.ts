// src/utils/logger.ts
export function logInfo(message: string) {
  console.log(`${new Date().toLocaleString()} [INFO] ${message}`);
}
export function logWarn(message: string) {
  console.warn(`${new Date().toLocaleString()} [WARN] ${message}`);
}
export function logError(message: string) {
  console.error(`${new Date().toLocaleString()} [ERROR] ${message}`);
}
