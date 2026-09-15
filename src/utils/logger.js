const winston = require('winston')
const DailyRotateFile = require('winston-daily-rotate-file')
const path = require('path')
const util = require('util');

function getModuleName(module) { return module }

// 增加标记避免重复解析splat
const splatMergeFormat = winston.format((info) => {
  if (info.__splatProcessed) return info;
  const splatSymbol = Symbol.for('splat');
  const args = [info.message, ...(info[splatSymbol] || [])];
  info.message = util.format(...args);
  info.__splatProcessed = true; // 标记已经处理过
  delete info[splatSymbol]; // 清理splat，防止后续再读取
  return info;
})

const baseFormat = winston.format.combine(
  winston.format.splat(),
  splatMergeFormat(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' })
)

// 文件输出格式（不带颜色）
const fileFormat = winston.format.combine(
  baseFormat,
  winston.format.printf(({ timestamp, level, message, module }) => {
    return `[${timestamp}] [${level}] [${module}] ${message}`
  })
)

// 控制台输出格式（带颜色）
const consoleFormat = winston.format.combine(
  baseFormat,
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, module }) => {
    return `[${timestamp}] [${level}] [${module}] ${message}`
  })
)

// 按天轮转日志
const rotateTransport = new DailyRotateFile({
  dirname: path.resolve(__dirname, '../../logs'),
  filename: 'service-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxDays: 7,
  zippedArchive: false,
  level: 'info'
})

module.exports = function createLogger(dir) {
  const moduleName = getModuleName(dir)
  const logger = winston.createLogger({
    defaultMeta: { module: moduleName },
    format: fileFormat,
    transports: [rotateTransport]
  })
  if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
      format: consoleFormat,
      level: 'info'
    }))
  }
  return logger
}
