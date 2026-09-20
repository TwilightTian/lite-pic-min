/**
 * 九宫格切图
 *
 * 关键点：按「源图整数像素边界」切分。
 * 源图边长往往不是 3 的整数倍，如果按 边长/3 这种小数去切，
 * 每个分块的源区域都带小数边界，缩放重采样后相邻块会出现半像素错位和虚边，
 * 拼回九宫格时就能看出缝。这里改为先取整求出「实际使用的正方形」和「单块整数边长」。
 *
 * 另外：画布只开「单块大小」，逐块把源区域画进去后整块导出，
 * 既不依赖 wx.canvasToTempFilePath 的裁切参数，也不会因为整图过大而爆内存。
 */
import {
  CanvasImage,
  CanvasNode,
  Ctx2D,
  MAX_TILE_SIDE,
  exportCanvas,
  setCanvasSize,
} from './canvas'

/** 允许的切分个数范围（每边等分数量） */
export const MIN_GRID_SIZE = 2
export const MAX_GRID_SIZE = 9
/** 单块最小边长（画布像素），再小就没意义了 */
export const MIN_CELL_SIDE = 60

export interface GridSizeCheck {
  ok: boolean
  /** 校验失败原因 */
  message: string
  /** 当前图片条件下建议的最大切分个数 */
  maxAllowed: number
}

/** 校验切分个数是否合理（个数范围 + 单块像素下限） */
export function validateGridSize(
  size: number,
  imgWidth: number,
  imgHeight: number
): GridSizeCheck {
  const shortSide = Math.max(1, Math.min(imgWidth, imgHeight))
  const maxByPixels = Math.floor(shortSide / MIN_CELL_SIDE)
  const maxAllowed = Math.max(MIN_GRID_SIZE, Math.min(MAX_GRID_SIZE, maxByPixels || MIN_GRID_SIZE))
  const n = Math.floor(Number(size))

  if (!Number.isFinite(n) || n < MIN_GRID_SIZE || n > MAX_GRID_SIZE) {
    return { ok: false, maxAllowed, message: '切分份数不对，重新选一张照片试试' }
  }
  if (maxByPixels < MIN_GRID_SIZE) {
    return { ok: false, maxAllowed, message: '这张照片太小了，切开后每张会很小，换一张大一点的照片吧' }
  }
  if (n > maxByPixels) {
    return {
      ok: false,
      maxAllowed,
      message: `这张照片最多只能切 ${maxByPixels} × ${maxByPixels}，换一张大一点的照片吧`,
    }
  }
  return { ok: true, maxAllowed, message: '' }
}

export interface GridLayout {
  /** 每边等分数量 */
  size: number
  /** 源图上实际使用的正方形边长（整数 = cellSource × size） */
  used: number
  /** 源图上的起点（居中、整数） */
  srcX: number
  srcY: number
  /** 源图上单块的边长（整数像素） */
  cellSource: number
  /** 单块导出像素 = min(cellSource, maxTileSide) */
  tileSide: number
}

/** 计算九宫格布局（预览与导出共用，保证所见即所得） */
export function computeGridLayout(
  imgWidth: number,
  imgHeight: number,
  size = 3,
  maxTileSide = MAX_TILE_SIDE
): GridLayout {
  const n = Math.min(MAX_GRID_SIZE, Math.max(MIN_GRID_SIZE, Math.floor(size) || MIN_GRID_SIZE))
  const shortSide = Math.max(1, Math.min(imgWidth, imgHeight))
  const cellSource = Math.max(1, Math.floor(shortSide / n))
  const used = cellSource * n
  return {
    size: n,
    used,
    srcX: Math.max(0, Math.floor((imgWidth - used) / 2)),
    srcY: Math.max(0, Math.floor((imgHeight - used) / 2)),
    cellSource,
    tileSide: Math.max(1, Math.min(cellSource, maxTileSide)),
  }
}

export interface SliceOptions {
  /** 每边等分数量，默认 3（九宫格） */
  size?: number
  /** 单块导出单边上限 */
  maxTileSide?: number
  /** 背景色（透明图导出用，不传保持透明） */
  background?: string
  /** 已算好的布局，避免重复计算 */
  layout?: GridLayout
}

export interface SliceResult extends GridLayout {
  /** 按从左到右、从上到下的顺序返回 */
  files: string[]
}

/** 居中裁剪为正方形并等分导出 */
export async function sliceGrid(
  canvas: CanvasNode,
  ctx: Ctx2D,
  img: CanvasImage,
  options: SliceOptions = {}
): Promise<SliceResult> {
  const layout =
    options.layout ||
    computeGridLayout(img.width, img.height, options.size || 3, options.maxTileSide)
  const { size, srcX, srcY, cellSource, tileSide } = layout

  setCanvasSize(canvas, ctx, tileSide, tileSide)

  const files: string[] = []
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      ctx.clearRect(0, 0, tileSide, tileSide)
      if (options.background) {
        ctx.fillStyle = options.background
        ctx.fillRect(0, 0, tileSide, tileSide)
      }
      // 源区域为整数像素，相邻两块严格相接，拼接无缝隙
      ctx.drawImage(
        img,
        srcX + col * cellSource,
        srcY + row * cellSource,
        cellSource,
        cellSource,
        0,
        0,
        tileSide,
        tileSide
      )
      const file = await exportCanvas(canvas, {
        width: tileSide,
        height: tileSide,
        destWidth: tileSide,
        destHeight: tileSide,
      })
      files.push(file)
    }
  }

  return { ...layout, files }
}

/**
 * 绘制「原图预览」：只显示将要参与切分的那块正方形（居中裁剪后的画面），
 * 不画切割线，保持原图干净；切割结果看「切图结果」那一栏。
 */
export function drawGridPreview(
  ctx: Ctx2D,
  img: CanvasImage,
  previewSide: number,
  layout: GridLayout
): void {
  ctx.clearRect(0, 0, previewSide, previewSide)
  ctx.drawImage(img, layout.srcX, layout.srcY, layout.used, layout.used, 0, 0, previewSide, previewSide)
}

/** 结果视图中格子之间的间隙（画布像素）：留宽一点，一眼能看出是分开的 9 张 */
export function resultCellGap(side: number): number {
  return Math.max(4, side / 90)
}

/** 结果视图中单格的边长（画布像素） */
export function resultCellSide(side: number, layout: GridLayout): number {
  const gap = resultCellGap(side)
  return (side - gap * (layout.size - 1)) / layout.size
}

/** 结果视图中第 index 格的左上角与尺寸（画布像素） */
export function resultCellRect(
  side: number,
  layout: GridLayout,
  index: number
): { x: number; y: number; size: number } {
  const gap = resultCellGap(side)
  const cell = resultCellSide(side, layout)
  const col = index % layout.size
  const row = Math.floor(index / layout.size)
  return { x: col * (cell + gap), y: row * (cell + gap), size: cell }
}

/**
 * 结果视图中某点落在第几格（画布像素坐标），不在任何格子上返回 -1。
 * 与 resultCellRect 共用同一套尺寸计算，保证「画」和「点」永远一致。
 */
export function hitResultCell(
  side: number,
  layout: GridLayout,
  point: { x: number; y: number }
): number {
  const gap = resultCellGap(side)
  const cell = resultCellSide(side, layout)
  const col = Math.floor(point.x / (cell + gap))
  const row = Math.floor(point.y / (cell + gap))
  if (col < 0 || col >= layout.size || row < 0 || row >= layout.size) return -1
  return row * layout.size + col
}

/**
 * 绘制「切图结果」视图：把每块之间留出间隙，直观看到会切成 9 张分开的图。
 * 不带序号角标（用户要求画面干净）。
 */
export function drawGridResult(
  ctx: Ctx2D,
  img: CanvasImage,
  side: number,
  layout: GridLayout
): void {
  const { size, srcX, srcY, cellSource } = layout

  ctx.clearRect(0, 0, side, side)
  ctx.fillStyle = '#f4f5f7'
  ctx.fillRect(0, 0, side, side)

  for (let index = 0; index < size * size; index += 1) {
    const col = index % size
    const row = Math.floor(index / size)
    const rect = resultCellRect(side, layout, index)
    ctx.drawImage(
      img,
      srcX + col * cellSource,
      srcY + row * cellSource,
      cellSource,
      cellSource,
      rect.x,
      rect.y,
      rect.size,
      rect.size
    )
  }
}

/**
 * 绘制「假九宫」：照片不切开，只在三等分位置画上框线。
 * 发到朋友圈在九宫格布局里看起来像 9 张，点开仍是一整张完整照片。
 */
export function drawFakeGrid(
  ctx: Ctx2D,
  img: CanvasImage,
  side: number,
  layout: GridLayout,
  options: { lineColor?: string; lineWidth?: number } = {}
): void {
  ctx.clearRect(0, 0, side, side)
  ctx.drawImage(img, layout.srcX, layout.srcY, layout.used, layout.used, 0, 0, side, side)

  // 线宽按画布尺寸放大，否则在屏幕上会细到看不见
  const lineWidth = options.lineWidth || Math.max(2, side / 140)
  ctx.save()
  ctx.strokeStyle = options.lineColor || '#ffffff'
  ctx.lineWidth = lineWidth
  for (let i = 1; i < layout.size; i += 1) {
    const p = (side / layout.size) * i
    ctx.beginPath()
    ctx.moveTo(p, 0)
    ctx.lineTo(p, side)
    ctx.moveTo(0, p)
    ctx.lineTo(side, p)
    ctx.stroke()
  }
  ctx.restore()
}
