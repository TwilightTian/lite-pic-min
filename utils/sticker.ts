/**
 * 贴纸绘制与命中检测
 * 贴纸坐标使用相对比例存储（x/width、y/height），保证不同画布尺寸下位置一致。
 */
import { StickerItem } from '../types/index'
import { CanvasImage, Ctx2D, drawImageFit } from './canvas'
import { clamp, toRadian, uid } from './util'

/** 贴纸基础尺寸占画布短边的比例 */
export const BASE_STICKER_RATIO = 0.18

/** 内置贴纸库（emoji，无需额外资源） */
export const STICKER_LIBRARY: Array<{ group: string; items: string[] }> = [
  {
    group: '表情',
    items: ['😀', '😍', '🥳', '😎', '🤔', '😭', '😡', '🤩', '😴', '🫠', '🥰', '🤯'],
  },
  {
    group: '装饰',
    items: ['⭐', '❤️', '🔥', '✨', '🌈', '☁️', '🌸', '🍀', '🎈', '🎉', '💎', '👑'],
  },
  {
    group: '标记',
    items: ['✅', '❌', '❗', '❓', '💡', '📍', '🔔', '🏆', '💯', '🚀', '🎯', '📌'],
  },
]

/** 创建贴纸数据（默认放在画面中心） */
export function createSticker(type: StickerItem['type'], content: string, scale = 1): StickerItem {
  return {
    id: uid('sticker'),
    type,
    content,
    x: 0.5,
    y: 0.5,
    scale: BASE_STICKER_RATIO * scale,
    rotation: 0,
    opacity: 1,
  }
}

/** 贴纸绘制尺寸（画布像素） */
export function getStickerSize(item: StickerItem, cw: number, ch: number): number {
  return Math.min(cw, ch) * item.scale
}

/** 贴纸中心点（画布像素） */
export function getStickerCenter(
  item: StickerItem,
  cw: number,
  ch: number
): { x: number; y: number } {
  return { x: item.x * cw, y: item.y * ch }
}

/** 绘制单个贴纸 */
export function drawSticker(
  ctx: Ctx2D,
  item: StickerItem,
  cw: number,
  ch: number,
  imageResolver?: (src: string) => CanvasImage | undefined
): void {
  const size = getStickerSize(item, cw, ch)
  const center = getStickerCenter(item, cw, ch)

  ctx.save()
  ctx.globalAlpha = clamp(item.opacity, 0, 1)
  ctx.translate(center.x, center.y)
  ctx.rotate(toRadian(item.rotation))

  if (item.type === 'emoji') {
    ctx.font = `${size}px sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(item.content, 0, 0)
  } else {
    const img = imageResolver ? imageResolver(item.content) : undefined
    if (img) {
      const w = size
      const h = size * (img.height / Math.max(1, img.width))
      ctx.drawImage(img, -w / 2, -h / 2, w, h)
    }
  }
  ctx.restore()
}

/** 绘制选中态虚线框 */
export function drawSelection(
  ctx: Ctx2D,
  item: StickerItem,
  cw: number,
  ch: number,
  lineWidth: number
): void {
  const size = getStickerSize(item, cw, ch)
  const center = getStickerCenter(item, cw, ch)
  ctx.save()
  ctx.translate(center.x, center.y)
  ctx.rotate(toRadian(item.rotation))
  ctx.strokeStyle = '#07c160'
  ctx.lineWidth = lineWidth
  ctx.setLineDash([lineWidth * 3, lineWidth * 3])
  ctx.strokeRect(-size / 2, -size / 2, size, size)
  ctx.setLineDash([])
  ctx.restore()
}

/** 绘制贴纸场景（底图 + 全部贴纸） */
export function drawStickerScene(
  ctx: Ctx2D,
  img: CanvasImage,
  cw: number,
  ch: number,
  stickers: StickerItem[],
  options: { selectedId?: string; imageResolver?: (src: string) => CanvasImage | undefined } = {}
): void {
  ctx.clearRect(0, 0, cw, ch)
  drawImageFit(ctx, img, 0, 0, cw, ch, 'cover')
  stickers.forEach((item) => drawSticker(ctx, item, cw, ch, options.imageResolver))
  if (options.selectedId) {
    const selected = stickers.find((s) => s.id === options.selectedId)
    if (selected) drawSelection(ctx, selected, cw, ch, Math.max(1, cw / 500))
  }
}

/** 命中检测：返回最上层被点中的贴纸 id */
export function hitTestSticker(
  stickers: StickerItem[],
  point: { x: number; y: number },
  cw: number,
  ch: number
): string | null {
  for (let i = stickers.length - 1; i >= 0; i -= 1) {
    const item = stickers[i]
    const size = getStickerSize(item, cw, ch)
    const center = getStickerCenter(item, cw, ch)
    const dx = point.x - center.x
    const dy = point.y - center.y
    // 命中半径取外接圆，方便手指点选
    const radius = (size / 2) * 1.1
    if (dx * dx + dy * dy <= radius * radius) return item.id
  }
  return null
}


