/**
 * 水印绘制与定位
 * 支持两种定位方式：
 *  1. 预设九宫格方位 + 边距（useFree = false）
 *  2. 在画布上拖动得到的自由位置（useFree = true，坐标为水印中心的相对比例）
 * 文字 / 图片水印都走同一套定位逻辑。
 */
import { WatermarkConfig, WatermarkPosition } from '../types/index'
import { CanvasImage, Ctx2D, drawImageFit } from './canvas'
import { clamp, toRadian } from './util'

/** 图片水印是否需要先加载水印图 */
export function needWatermarkImage(config: WatermarkConfig): boolean {
  return config.type === 'image' && !!config.imageSrc
}

/** 水印包围盒（画布像素坐标） */
export interface WatermarkBox {
  cx: number
  cy: number
  width: number
  height: number
}

/** 预设方位 → 左上角坐标 */
function anchorPosition(
  position: WatermarkPosition,
  itemW: number,
  itemH: number,
  canvasW: number,
  canvasH: number,
  padding: number
): { x: number; y: number } {
  const parts = String(position).split('-')
  let horizontal = 'center'
  let vertical = 'center'
  parts.forEach((part) => {
    if (part === 'left' || part === 'right') horizontal = part
    else if (part === 'top' || part === 'bottom') vertical = part
  })

  let x = padding
  let y = padding
  if (horizontal === 'center') x = (canvasW - itemW) / 2
  if (horizontal === 'right') x = canvasW - itemW - padding
  if (vertical === 'center') y = (canvasH - itemH) / 2
  if (vertical === 'bottom') y = canvasH - itemH - padding
  return { x, y }
}

/** 水印中心坐标 */
function resolveCenter(
  config: WatermarkConfig,
  width: number,
  height: number,
  cw: number,
  ch: number
): { x: number; y: number } {
  if (config.useFree) {
    return { x: clamp(config.freeX, 0, 1) * cw, y: clamp(config.freeY, 0, 1) * ch }
  }
  const pad = config.padding * cw
  const { x, y } = anchorPosition(config.position, width, height, cw, ch, pad)
  return { x: x + width / 2, y: y + height / 2 }
}

/** 文字水印的尺寸（画布像素） */
export function measureTextWatermark(
  ctx: Ctx2D,
  config: WatermarkConfig,
  cw: number
): { fontSize: number; width: number; height: number } {
  const fontSize = Math.max(10, config.fontSize * cw)
  const text = config.text || ''
  let width = fontSize
  if (text) {
    ctx.save()
    ctx.font = `${config.bold ? 'bold ' : ''}${fontSize}px sans-serif`
    width = ctx.measureText(text).width || fontSize
    ctx.restore()
  }
  return { fontSize, width, height: fontSize }
}

/** 图片水印的尺寸（画布像素） */
function measureImageWatermark(
  config: WatermarkConfig,
  wmImage: CanvasImage,
  cw: number
): { width: number; height: number } {
  const width = Math.max(12, config.imageScale * cw)
  return { width, height: width * (wmImage.height / Math.max(1, wmImage.width)) }
}

/** 计算水印包围盒，用于绘制定位与拖动命中检测 */
export function getWatermarkBox(
  ctx: Ctx2D,
  config: WatermarkConfig,
  wmImage: CanvasImage | null,
  cw: number,
  ch: number
): WatermarkBox | null {
  if (config.type === 'image') {
    if (!wmImage) return null
    const size = measureImageWatermark(config, wmImage, cw)
    const center = resolveCenter(config, size.width, size.height, cw, ch)
    return { cx: center.x, cy: center.y, width: size.width, height: size.height }
  }
  if (!config.text) return null
  const size = measureTextWatermark(ctx, config, cw)
  const center = resolveCenter(config, size.width, size.height, cw, ch)
  return { cx: center.x, cy: center.y, width: size.width, height: size.height }
}

/** 命中检测：手指是否按在水印上（外接圆近似，便于单手操作） */
export function hitTestWatermark(
  ctx: Ctx2D,
  config: WatermarkConfig,
  wmImage: CanvasImage | null,
  cw: number,
  ch: number,
  point: { x: number; y: number }
): boolean {
  const box = getWatermarkBox(ctx, config, wmImage, cw, ch)
  if (!box) return false
  const radius = Math.max(box.width, box.height) / 2 + Math.min(cw, ch) * 0.04
  const dx = point.x - box.cx
  const dy = point.y - box.cy
  return dx * dx + dy * dy <= radius * radius
}

/** 以水印中心为原点绘制（含旋转与透明度） */
function paintWithTransform(
  ctx: Ctx2D,
  centerX: number,
  centerY: number,
  rotation: number,
  opacity: number,
  paint: () => void
): void {
  ctx.save()
  ctx.globalAlpha = clamp(opacity, 0, 1)
  ctx.translate(centerX, centerY)
  ctx.rotate(toRadian(rotation))
  paint()
  ctx.restore()
}

/** 绘制文字水印 */
function drawTextWatermark(ctx: Ctx2D, config: WatermarkConfig, cw: number, ch: number): void {
  const text = config.text
  if (!text) return
  const { fontSize, width: textW, height: textH } = measureTextWatermark(ctx, config, cw)

  if (config.tile) {
    // 平铺：在旋转后的坐标系里按网格铺满整个画布（覆盖对角线范围）
    const diagonal = Math.sqrt(cw * cw + ch * ch)
    const stepX = Math.max(textW + fontSize, textW * (1 + config.tileGap * 0.6))
    const stepY = textH * (1 + config.tileGap)
    const half = diagonal / 2
    paintWithTransform(ctx, cw / 2, ch / 2, config.rotation, config.opacity, () => {
      ctx.fillStyle = config.color
      ctx.font = `${config.bold ? 'bold ' : ''}${fontSize}px sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      for (let y = -half; y <= half; y += stepY) {
        for (let x = -half - stepX; x <= half + stepX; x += stepX) {
          ctx.fillText(text, x, y)
        }
      }
    })
    return
  }

  const center = resolveCenter(config, textW, textH, cw, ch)
  paintWithTransform(ctx, center.x, center.y, config.rotation, config.opacity, () => {
    ctx.fillStyle = config.color
    ctx.font = `${config.bold ? 'bold ' : ''}${fontSize}px sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, 0, 0)
  })
}

/** 绘制图片水印 */
function drawImageWatermark(
  ctx: Ctx2D,
  config: WatermarkConfig,
  wmImage: CanvasImage,
  cw: number,
  ch: number
): void {
  const { width, height } = measureImageWatermark(config, wmImage, cw)

  if (config.tile) {
    const diagonal = Math.sqrt(cw * cw + ch * ch)
    const stepX = width * (1 + config.tileGap)
    const stepY = height * (1 + config.tileGap)
    const half = diagonal / 2
    paintWithTransform(ctx, cw / 2, ch / 2, config.rotation, config.opacity, () => {
      for (let y = -half; y <= half; y += stepY) {
        for (let x = -half - stepX; x <= half + stepX; x += stepX) {
          ctx.drawImage(wmImage, x, y, width, height)
        }
      }
    })
    return
  }

  const center = resolveCenter(config, width, height, cw, ch)
  paintWithTransform(ctx, center.x, center.y, config.rotation, config.opacity, () => {
    ctx.drawImage(wmImage, -width / 2, -height / 2, width, height)
  })
}

/**
 * 绘制完整的水印场景：底图 + 水印
 * @param wmImage 图片水印时需要，用于文字水印可传 null
 */
export function drawWatermarkScene(
  ctx: Ctx2D,
  img: CanvasImage,
  cw: number,
  ch: number,
  config: WatermarkConfig,
  wmImage: CanvasImage | null = null
): void {
  ctx.clearRect(0, 0, cw, ch)
  drawImageFit(ctx, img, 0, 0, cw, ch, 'cover')

  if (config.type === 'image') {
    if (wmImage) drawImageWatermark(ctx, config, wmImage, cw, ch)
  } else {
    drawTextWatermark(ctx, config, cw, ch)
  }
}
