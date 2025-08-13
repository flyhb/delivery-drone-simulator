// src/utils/logger.ts
export function logInfo(message: string) {
  console.log(`${new Date().toISOString()} [INFO] ${message}`);
}
export function logWarn(message: string) {
  console.warn(`${new Date().toISOString()} [WARN] ${message}`);
}
export function logError(message: string) {
  console.error(`${new Date().toISOString()} [ERROR] ${message}`);
}
