const winston = require('winston')
const DailyRotateFile = require('winston-daily-rotate-file')
const path = require('path')

// 自动提取模块文件夹名
function getModuleName(dir) { return path.basename(dir) }

// 日志格式
const baseFormat = winston.format.combine( 
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

// 工厂函数：每个模块独立传入路径、自动绑定模块名
module.exports = function createLogger(dir) {
  const moduleName = getModuleName(dir)

  const logger = winston.createLogger({
    defaultMeta: { module: moduleName },
    format: fileFormat,
    transports: [rotateTransport]
  })

  // 开发环境控制台输出
  if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
      format: consoleFormat
    }))
  }

  return logger
}