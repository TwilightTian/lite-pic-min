/**
 * 图片裁剪
 * 交互模型：裁剪框固定居中（比例可选），通过拖动 / 缩放底图来调整裁剪内容。
 * 导出时先擦掉遮罩按裁剪框范围导出，再恢复遮罩。
 */
import { CropConfig, CropRatio } from '../types/index'
import {
  CanvasImage,
  CanvasNode,
  Ctx2D,
  computeFitRect,
  exportCanvas,
  setCanvasSize,
} from './canvas'
import { clamp } from './util'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

const MIN_SCALE = 1
const MAX_SCALE = 6

/** 比例取值，free 返回 null */
export function getRatioValue(ratio: CropRatio): number | null {
  switch (ratio) {
    case '1:1':
      return 1
    case '4:3':
      return 4 / 3
    case '16:9':
      return 16 / 9
    case '3:4':
      return 3 / 4
    case '9:16':
      return 9 / 16
    default:
      return null
  }
}

/** 计算裁剪框（画布像素坐标），始终居中 */
export function computeCropBox(config: CropConfig, cw: number, ch: number): Rect {
  const ratio = getRatioValue(config.ratio)
  if (ratio === null) {
    const width = cw * clamp(config.freeWidthPct, 0.2, 1)
    const height = ch * clamp(config.freeHeightPct, 0.2, 1)
    return { x: (cw - width) / 2, y: (ch - height) / 2, width, height }
  }
  let width = cw
  let height = cw / ratio
  if (height > ch) {
    height = ch
    width = ch * ratio
  }
  return { x: (cw - width) / 2, y: (ch - height) / 2, width, height }
}

/** 计算底图绘制矩形（铺满画布 + 缩放 + 偏移） */
export function computeImageRect(
  img: CanvasImage,
  config: CropConfig,
  cw: number,
  ch: number
): Rect {
  const fit = computeFitRect(img.width, img.height, 0, 0, cw, ch, 'cover')
  const scale = clamp(config.scale, MIN_SCALE, MAX_SCALE)
  const width = fit.dw * scale
  const height = fit.dh * scale
  const x = (cw - width) / 2 + config.offsetX * cw
  const y = (ch - height) / 2 + config.offsetY * ch
  return { x, y, width, height }
}

/** 校正配置：限制缩放倍数与偏移范围，保证底图始终铺满画布 */
export function normalizeCropConfig(
  config: CropConfig,
  cw: number,
  ch: number,
  imgRatio: number
): CropConfig {
  const scale = clamp(config.scale, MIN_SCALE, MAX_SCALE)
  // 以 cover 适配后的基准尺寸计算可偏移范围
  const canvasRatio = cw / ch
  const fitW = imgRatio > canvasRatio ? cw * (imgRatio / canvasRatio) : cw
  const fitH = imgRatio > canvasRatio ? ch : ch * (canvasRatio / imgRatio)
  const limitX = Math.max(0, (fitW * scale - cw) / (2 * cw))
  const limitY = Math.max(0, (fitH * scale - ch) / (2 * ch))
  return {
    ...config,
    scale,
    offsetX: clamp(config.offsetX, -limitX, limitX),
    offsetY: clamp(config.offsetY, -limitY, limitY),
  }
}

/**
 * 绘制裁剪场景
 * @param overlay 是否绘制遮罩与辅助线（导出时必须传 false）
 */
export function drawCropScene(
  ctx: Ctx2D,
  img: CanvasImage,
  config: CropConfig,
  cw: number,
  ch: number,
  overlay = true
): void {
  drawCropContent(ctx, img, config, cw, ch)

  if (!overlay) return

  const box = computeCropBox(config, cw, ch)
  // 遮罩：用四块矩形围出裁剪框，避免依赖 evenodd 填充规则
  ctx.save()
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)'
  ctx.fillRect(0, 0, cw, box.y)
  ctx.fillRect(0, box.y + box.height, cw, ch - box.y - box.height)
  ctx.fillRect(0, box.y, box.x, box.height)
  ctx.fillRect(box.x + box.width, box.y, cw - box.x - box.width, box.height)

  // 边框
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)'
  ctx.lineWidth = Math.max(2, cw / 400)
  ctx.strokeRect(box.x, box.y, box.width, box.height)

  // 三分辅助线
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)'
  ctx.lineWidth = Math.max(1, cw / 900)
  for (let i = 1; i < 3; i += 1) {
    const x = box.x + (box.width / 3) * i
    const y = box.y + (box.height / 3) * i
    ctx.beginPath()
    ctx.moveTo(x, box.y)
    ctx.lineTo(x, box.y + box.height)
    ctx.moveTo(box.x, y)
    ctx.lineTo(box.x + box.width, y)
    ctx.stroke()
  }
  ctx.restore()
}

/** 只画底图内容（不含遮罩） */
function drawCropContent(
  ctx: Ctx2D,
  img: CanvasImage,
  config: CropConfig,
  cw: number,
  ch: number
): void {
  const rect = computeImageRect(img, config, cw, ch)
  ctx.clearRect(0, 0, cw, ch)
  ctx.drawImage(img, rect.x, rect.y, rect.width, rect.height)
}

/**
 * 导出裁剪结果
 * 做法：把画布缩到裁剪框尺寸，将框内区域重绘上去后整块导出。
 * 不使用 wx.canvasToTempFilePath 的裁切参数，兼容性更好。
 * 注意：会改变传入画布的尺寸，所以请传入屏幕外的工作画布，可视画布留给预览。
 */
export async function exportCrop(
  canvas: CanvasNode,
  ctx: Ctx2D,
  img: CanvasImage,
  config: CropConfig,
  cw: number,
  ch: number
): Promise<string> {
  const box = computeCropBox(config, cw, ch)
  const outW = Math.max(1, Math.round(box.width))
  const outH = Math.max(1, Math.round(box.height))
  const rect = computeImageRect(img, config, cw, ch)
  // 画布坐标 → 输出坐标
  const k = outW / Math.max(1, box.width)

  setCanvasSize(canvas, ctx, outW, outH)
  ctx.drawImage(
    img,
    (rect.x - box.x) * k,
    (rect.y - box.y) * k,
    rect.width * k,
    rect.height * k
  )

  return exportCanvas(canvas, {
    width: outW,
    height: outH,
    destWidth: outW,
    destHeight: outH,
  })
}
