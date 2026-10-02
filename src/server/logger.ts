export interface ServerLogger {
  info(message: string, context?: Record<string, unknown>): void
  warn(message: string, context?: Record<string, unknown>): void
  error(message: string, context?: Record<string, unknown>): void
}

let activeLogger: ServerLogger = {
  info: (message, context) => {
    console.log(formatLog('INFO', message, context))
  },
  warn: (message, context) => {
    console.warn(formatLog('WARN', message, context))
  },
  error: (message, context) => {
    console.error(formatLog('ERROR', message, context))
  },
}

export const serverLogger: ServerLogger = {
  info(message, context) {
    activeLogger.info(message, context)
  },
  warn(message, context) {
    activeLogger.warn(message, context)
  },
  error(message, context) {
    activeLogger.error(message, context)
  },
}

export function setServerLogger(logger: ServerLogger): void {
  activeLogger = logger
}

export function resetServerLogger(): void {
  activeLogger = {
    info: (message, context) => {
      console.log(formatLog('INFO', message, context))
    },
    warn: (message, context) => {
      console.warn(formatLog('WARN', message, context))
    },
    error: (message, context) => {
      console.error(formatLog('ERROR', message, context))
    },
  }
}

export function errorContext(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message }
  }
  return { message: String(error) }
}

/**
 * 格式化一行服务端日志（`[server:LEVEL] message`）。导出供 serveCommand 的
 * jsonMode stderr 重定向复用同一格式——stdout 纯度契约下 info 行改走 stderr
 * 时保持字面一致，不另造第二份格式。
 */
export function formatLog(level: string, message: string, context?: Record<string, unknown>): string {
  if (!context || Object.keys(context).length === 0) return `[server:${level}] ${message}`
  return `[server:${level}] ${message} ${safeJson(context)}`
}

function safeJson(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value)
  } catch {
    return '{"error":"unserializable context"}'
  }
}
