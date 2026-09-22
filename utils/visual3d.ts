/**
 * 视觉 3D：朋友圈那种「人像从九宫格里走出来」的效果
 *
 * 三层结构（和手工教程的做法一一对应）：
 *   ① 白底正方形画布
 *   ② 九宫格底图 —— 9 张图各自居中裁成正方形，四周留白缝；外圈再留一道白边
 *      · 白缝、外白边都是「格子内缩后白底露出来」，不是画线
 *        （画线会出现"线压在图片上"、格子之间没有真正空隙两种偏差）
 *      · 单图模式 = 一张照片铺满九宫格区域后按格切开，素材只要 1 张
 *      · 九图模式 = 9 张图各占一格，这是教程里的原始做法，也最像朋友圈
 *   ③ 人像图层 —— 透明背景的人像叠在最上层，跨格、可以拖出画框
 *      不透明像素挡住白缝，透明处让白缝透出来 → 立体穿插
 *
 * 为什么不做自动抠图：本地没有现成的分割模型可用 —— 上云调分割 API 意味着
 * 图片要上传（本项目坚持不上传），本地跑模型要打包 ONNX 走 wx.createInferenceSession
 * 且体积/性能风险大。所以剪影交给用户提供（手机相册自带抠图 / 任意抠图 App）。
 * 全流程不需要上传任何图片。
 *
 * 注：Canvas 2D（type="2d"）**是支持** `ctx.getImageData / putImageData` 的
 * （旧版 canvas-id 接口才不支持，官方迁移指南写明新版用 context.getImageData 替代），
 * 所以"本地拿不到像素"不是不做抠图的理由 —— 别再拿它当依据（曾写错过）。
 */
import { CanvasImage, Ctx2D, canvasFont, computeFitRect } from './canvas'
import { clamp } from './util'

/** 固定 3 × 3 */
export const GRID_SIZE = 3
/** 九宫格区域边长（正方形）。画布宽度 = 它，高度 = 它 + 顶部文字区 */
export const NINE_GRID_SIDE = 1440
/** 每张底图预处理后的最长边：单格约 420px，留足裁剪余量又不会吃内存 */
export const CELL_SOURCE_MAX = 600
/** 白缝宽度范围（相对画布边长） */
export const GAP_RATIO_RANGE = { min: 0, max: 0.06 }
/** 外白框宽度范围（相对画布边长） */
export const OUTER_RATIO_RANGE = { min: 0, max: 0.1 }
/** 格子圆角（相对单格边长），朋友圈缩略图是圆角的，加上更像 */
const CELL_RADIUS_RATIO = 0.06
/** 画布底色（和朋友圈白底一致，合成痕迹最自然） */
export const CANVAS_BACKGROUND = '#ffffff'
/** 绘画时最多放大到几倍 */
export const MAX_VIEW_SCALE = 6

/** 格子圆角样式 */
export type CornerStyle = 'round' | 'square'
/** 顶部文字对齐方式 */
export type TextAlign = 'left' | 'center'

/** 格子圆角可选值 */
export const CORNER_OPTIONS: Array<{ key: CornerStyle; label: string }> = [
  { key: 'round', label: '圆角' },
  { key: 'square', label: '直角' },
]
/** 顶部文字可选颜色 */
export const TEXT_COLOR_OPTIONS = ['#1f2328', '#ffffff', '#e34d59', '#1677ff', '#07c160']
/** 顶部文字字号范围（相对画布宽度） */
export const TEXT_SIZE_RANGE = { min: 0.02, max: 0.12 }
/** 顶部文字对齐可选值 */
export const TEXT_ALIGN_OPTIONS: Array<{ key: TextAlign; label: string }> = [
  { key: 'left', label: '居左' },
  { key: 'center', label: '居中' },
]

/* ------------------------- 档位（无 / 小 / 中 / 大） ------------------------- */
/*
 * 间距、字号这类数值给几档比给连续数字好选：滑块按下标走，右侧直接显示档位文字。
 * 相邻档位差距要一眼能看出来，所以不是等分。
 */
export interface PresetOption {
  key: string
  label: string
  ratio: number
}

/** 格子间距档位（比例相对画布边长） */
export const GAP_OPTIONS: PresetOption[] = [
  { key: 'none', label: '无', ratio: 0 },
  { key: 'small', label: '小', ratio: 0.02 },
  { key: 'medium', label: '中', ratio: 0.04 },
  { key: 'large', label: '大', ratio: 0.06 },
]

/** 外白框档位（比例相对画布边长） */
export const OUTER_OPTIONS: PresetOption[] = [
  { key: 'none', label: '无', ratio: 0 },
  { key: 'small', label: '小', ratio: 0.02 },
  { key: 'medium', label: '中', ratio: 0.04 },
  { key: 'large', label: '大', ratio: 0.07 },
]

/** 顶部文字字号档位（比例相对画布宽度） */
export const TEXT_SIZE_OPTIONS: PresetOption[] = [
  { key: 'small', label: '小', ratio: 0.03 },
  { key: 'normal', label: '标准', ratio: 0.04 },
  { key: 'large', label: '大', ratio: 0.06 },
]

/* ------------------------- 布局 ------------------------- */

export interface NineGridLayout {
  /** 画布边长 */
  side: number
  /** 外白框宽度 */
  outer: number
  /** 白缝宽度 */
  gap: number
  /** 单格边长 */
  cell: number
}

/**
 * 计算九宫格布局。
 * 外白框和缝隙都是画布底色透出来的，所以单格边长由它们反推。
 */
export function computeNineGridLayout(
  side: number,
  gapRatio: number,
  outerRatio: number
): NineGridLayout {
  const outer = clamp(outerRatio, OUTER_RATIO_RANGE.min, OUTER_RATIO_RANGE.max) * side
  const gap = clamp(gapRatio, GAP_RATIO_RANGE.min, GAP_RATIO_RANGE.max) * side
  const inner = Math.max(1, side - outer * 2 - gap * (GRID_SIZE - 1))
  return { side, outer, gap, cell: inner / GRID_SIZE }
}

/** 第 index 格（0~8，从左到右、从上到下）的左上角与边长 */
export function cellRectAt(
  layout: NineGridLayout,
  index: number
): { x: number; y: number; size: number } {
  const col = index % GRID_SIZE
  const row = Math.floor(index / GRID_SIZE)
  const step = layout.cell + layout.gap
  return { x: layout.outer + col * step, y: layout.outer + row * step, size: layout.cell }
}

/** 九宫格区域（外白框以内） */
export function gridArea(layout: NineGridLayout): {
  x: number
  y: number
  width: number
  height: number
} {
  return {
    x: layout.outer,
    y: layout.outer,
    width: layout.side - layout.outer * 2,
    height: layout.side - layout.outer * 2,
  }
}

/** 圆角矩形路径（用二次贝塞尔，不依赖 arcTo） */
export function traceRoundRect(
  ctx: Ctx2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number
): void {
  const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2))
  if (r <= 0) {
    ctx.rect(x, y, w, h)
    return
  }
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

/* ------------------------- 顶部文字 ------------------------- */

/**
 * 顶部文字：画在九宫格上方的一块白底区域里，和图片一起导出成一张图。
 * 有文字时画布会变高（宽度不变），九宫格本身仍是正方形。
 */
export interface TextConfig {
  text: string
  color: string
  /** 字号（相对画布宽度） */
  sizeRatio: number
  bold: boolean
  align: TextAlign
  /** 上下留白（相对画布宽度） */
  paddingRatio: number
}

export function createTextConfig(): TextConfig {
  return {
    text: '',
    color: '#1f2328',
    sizeRatio: 0.04,
    bold: true,
    align: 'left',
    paddingRatio: 0.028,
  }
}

/** 行高倍数（相对字号）：画文字和量高度共用，改一处即可 */
export const TEXT_LINE_HEIGHT_RATIO = 1.4

/**
 * 把顶部文字按换行拆成多行。
 * 去掉首尾的空行（用户顺手多敲的回车不该变成空白），中间的空行保留 —— 那是用户想空一行。
 */
export function splitTextLines(value: string): string[] {
  const rows = String(value || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
  while (rows.length && !rows[0].trim()) rows.shift()
  while (rows.length && !rows[rows.length - 1].trim()) rows.pop()
  return rows
}

/** 顶部文字区的高度（没有文字时为 0）；支持换行，按行数算 */
export function measureTextArea(width: number, text: TextConfig | null): number {
  if (!text || !text.text.trim()) return 0
  const fontSize = clamp(text.sizeRatio, TEXT_SIZE_RANGE.min, TEXT_SIZE_RANGE.max) * width
  const pad = clamp(text.paddingRatio, 0, 0.08) * width
  const lines = Math.max(1, splitTextLines(text.text).length)
  return Math.round(pad * 2 + fontSize * TEXT_LINE_HEIGHT_RATIO * lines)
}

/* ------------------------- 让白缝穿过人像 ------------------------- */

/**
 * 8 条白缝：2 条竖缝、2 条横缝，加上外框四边。
 * 立体感的关键不止"人像盖住白缝"，还得让白缝在某些地方跑到人像前面，
 * 一前一后才有穿插感（手工教程里是拿橡皮擦一点一点擦出白线）。
 */
export type GapStripId = 'v0' | 'v1' | 'h0' | 'h1' | 'top' | 'bottom' | 'left' | 'right'

export const GAP_STRIPS: GapStripId[] = ['v0', 'v1', 'h0', 'h1', 'top', 'bottom', 'left', 'right']

/** 缝的方向：vertical = 竖缝（沿 y 延伸），horizontal = 横缝（沿 x 延伸） */
export function stripAxis(id: GapStripId): 'vertical' | 'horizontal' {
  return id === 'v0' || id === 'v1' || id === 'left' || id === 'right' ? 'vertical' : 'horizontal'
}

/** 某条缝的整段矩形（画布像素） */
export function stripRect(
  layout: NineGridLayout,
  id: GapStripId
): { x: number; y: number; width: number; height: number } {
  const { side, outer, gap, cell } = layout
  const inner = Math.max(0, side - outer * 2)
  switch (id) {
    case 'v0':
      return { x: outer + cell, y: outer, width: gap, height: inner }
    case 'v1':
      return { x: outer + cell * 2 + gap, y: outer, width: gap, height: inner }
    case 'h0':
      return { x: outer, y: outer + cell, width: inner, height: gap }
    case 'h1':
      return { x: outer, y: outer + cell * 2 + gap, width: inner, height: gap }
    case 'top':
      return { x: 0, y: 0, width: side, height: outer }
    case 'bottom':
      return { x: 0, y: side - outer, width: side, height: outer }
    case 'left':
      return { x: 0, y: 0, width: outer, height: side }
    default:
      return { x: side - outer, y: 0, width: outer, height: side }
  }
}

/** 这条缝沿自身方向的完整范围 */
export function stripExtent(
  layout: NineGridLayout,
  id: GapStripId
): { from: number; to: number } {
  const rect = stripRect(layout, id)
  return stripAxis(id) === 'vertical'
    ? { from: rect.y, to: rect.y + rect.height }
    : { from: rect.x, to: rect.x + rect.width }
}

/** 用户拖出的一段「缝在人像前面」 */
export interface GapSegment {
  strip: GapStripId
  /** 沿缝方向的起止（画布像素，保证 from ≤ to） */
  from: number
  to: number
}

/** 段落对应的矩形，太短返回 null */
export function segmentRect(
  layout: NineGridLayout,
  segment: GapSegment
): { x: number; y: number; width: number; height: number } | null {
  const rect = stripRect(layout, segment.strip)
  const extent = stripExtent(layout, segment.strip)
  const from = clamp(Math.min(segment.from, segment.to), extent.from, extent.to)
  const to = clamp(Math.max(segment.from, segment.to), extent.from, extent.to)
  if (to - from < 0.5) return null
  return stripAxis(segment.strip) === 'vertical'
    ? { x: rect.x, y: from, width: rect.width, height: to - from }
    : { x: from, y: rect.y, width: to - from, height: rect.height }
}

export interface StripHit {
  id: GapStripId
  distance: number
  /** 落点投影到缝上的位置 */
  position: number
}

/** 找出离 point 最近的白缝；超出容差返回 null（容差给宽一点，手指才好点中） */
export function findNearestStrip(
  layout: NineGridLayout,
  point: { x: number; y: number },
  tolerance: number
): StripHit | null {
  let best: StripHit | null = null
  for (let i = 0; i < GAP_STRIPS.length; i += 1) {
    const id = GAP_STRIPS[i]
    const rect = stripRect(layout, id)
    const vertical = stripAxis(id) === 'vertical'
    // 垂直于缝的偏移
    const across = vertical
      ? Math.abs(point.x - (rect.x + rect.width / 2))
      : Math.abs(point.y - (rect.y + rect.height / 2))
    // 沿缝方向超出两端多远（靠近角落时相邻的缝也能选中）
    const along = vertical ? point.y : point.x
    const extent = stripExtent(layout, id)
    const overshoot = Math.max(0, extent.from - along, along - extent.to)
    const distance = Math.sqrt(across * across + overshoot * overshoot)
    if (distance <= tolerance && (!best || distance < best.distance)) {
      best = { id, distance, position: clamp(along, extent.from, extent.to) }
    }
  }
  return best
}

/** 把点投影到缝上，返回沿缝方向的位置（已夹到缝的范围内） */
export function projectOnStrip(
  layout: NineGridLayout,
  id: GapStripId,
  point: { x: number; y: number }
): number {
  const extent = stripExtent(layout, id)
  const along = stripAxis(id) === 'vertical' ? point.y : point.x
  return clamp(along, extent.from, extent.to)
}

/**
 * 橡皮擦：从已有段落里扣掉擦过的一段。
 * 擦在中间会把一段切成两段，擦掉整段则整段消失。
 */
export function subtractSegment(segments: GapSegment[], eraser: GapSegment): GapSegment[] {
  const from = Math.min(eraser.from, eraser.to)
  const to = Math.max(eraser.from, eraser.to)
  const result: GapSegment[] = []
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]
    if (segment.strip !== eraser.strip) {
      result.push(segment)
      continue
    }
    const start = Math.min(segment.from, segment.to)
    const end = Math.max(segment.from, segment.to)
    if (to <= start || from >= end) {
      result.push(segment) // 没擦到
      continue
    }
    // 左侧残段
    if (from > start) result.push({ strip: segment.strip, from: start, to: from })
    // 右侧残段
    if (to < end) result.push({ strip: segment.strip, from: to, to: end })
  }
  result.sort((a, b) =>
    a.strip === b.strip ? a.from - b.from : GAP_STRIPS.indexOf(a.strip) - GAP_STRIPS.indexOf(b.strip)
  )
  return result
}

/** 两个区间在同一缝上的交集（没交集返回 null） */
export function overlapOf(a: GapSegment, b: GapSegment): GapSegment | null {
  if (a.strip !== b.strip) return null
  const from = Math.max(Math.min(a.from, a.to), Math.min(b.from, b.to))
  const to = Math.min(Math.max(a.from, a.to), Math.max(b.from, b.to))
  return to > from ? { strip: a.strip, from, to } : null
}

/** 橡皮擦预览用：target 会擦掉 segments 里的哪些部分 */
export function intersectSegments(segments: GapSegment[], target: GapSegment): GapSegment[] {
  const result: GapSegment[] = []
  for (let i = 0; i < segments.length; i += 1) {
    const hit = overlapOf(segments[i], target)
    if (hit) result.push(hit)
  }
  return result
}

/** 把一段併进已有列表：同一条缝上重叠或紧挨着的会合并 */
export function mergeSegment(segments: GapSegment[], segment: GapSegment): GapSegment[] {
  let merged: GapSegment = {
    strip: segment.strip,
    from: Math.min(segment.from, segment.to),
    to: Math.max(segment.from, segment.to),
  }
  const rest: GapSegment[] = []
  for (let i = 0; i < segments.length; i += 1) {
    const item = segments[i]
    const overlaps = item.strip === merged.strip && !(item.to < merged.from - 1 || item.from > merged.to + 1)
    if (overlaps) {
      merged = {
        strip: merged.strip,
        from: Math.min(merged.from, item.from),
        to: Math.max(merged.to, item.to),
      }
    } else {
      rest.push(item)
    }
  }
  rest.push(merged)
  // 按缝顺序排一下，结果稳定
  rest.sort((a, b) =>
    a.strip === b.strip ? a.from - b.from : GAP_STRIPS.indexOf(a.strip) - GAP_STRIPS.indexOf(b.strip)
  )
  return rest
}



/* ------------------------- 人像图层 ------------------------- */

/**
 * 人像图层：一张「透明背景」的人像图，直接叠在九宫格之上。
 * 这是做出效果的关键——人像的不透明像素天然盖住白缝，
 * 透明区域自动让白缝透出来，看起来就是从九宫格里走出来的。
 */
export interface PortraitConfig {
  /** 人像图路径（必须是带透明通道的 PNG） */
  src: string
  /** 中心位置（相对画布 0~1），允许略微超出画框 */
  cx: number
  cy: number
  /** 高度占画布边长的比例 */
  h: number
  /** 旋转角度（度） */
  rotation: number
}

/** 人像最小 / 最大高度比例（相对画布边长） */
export const PORTRAIT_MIN_H = 0.05
export const PORTRAIT_MAX_H = 3
/** 允许的中心点范围（略超出画框，教程里人物就是踩出画框的） */
const PORTRAIT_CENTER_RANGE = { min: -0.5, max: 1.5 }
/** 人像左上角最多能拖出画布多少（相对边长），避免整个拖丢 */
export function createPortrait(src: string): PortraitConfig {
  // 默认高度占满画布、水平居中，用户再拖到位
  return { src, cx: 0.5, cy: 0.5, h: 0.9, rotation: 0 }
}

/** 人像在画布上的显示尺寸（按图片比例，旋转不影响宽高） */
export function getPortraitSize(
  portrait: PortraitConfig,
  side: number,
  imgW: number,
  imgH: number
): { width: number; height: number } {
  const height = portrait.h * side
  const width = imgH > 0 ? (imgW / imgH) * height : height
  return { width, height }
}

/** 人像中心点（画布像素） */
export function getPortraitCenter(portrait: PortraitConfig, side: number): { x: number; y: number } {
  return { x: portrait.cx * side, y: portrait.cy * side }
}

/**
 * 命中检测：把点反向旋转到人像自身的坐标系里再按矩形判断，
 * 这样人像旋转过之后依然点得准（用外接矩形会明显偏）。
 */
export function hitTestPortrait(
  portrait: PortraitConfig,
  side: number,
  imgW: number,
  imgH: number,
  point: { x: number; y: number }
): boolean {
  const size = getPortraitSize(portrait, side, imgW, imgH)
  const center = getPortraitCenter(portrait, side)
  const rad = (-portrait.rotation * Math.PI) / 180
  const dx = point.x - center.x
  const dy = point.y - center.y
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const lx = dx * cos - dy * sin
  const ly = dx * sin + dy * cos
  return Math.abs(lx) <= size.width / 2 && Math.abs(ly) <= size.height / 2
}

/** 归一化人像配置（大小和位置都夹到合理范围） */
export function normalizePortrait(portrait: PortraitConfig, side: number): PortraitConfig {
  if (side <= 0) return portrait
  return {
    ...portrait,
    h: clamp(portrait.h, PORTRAIT_MIN_H, PORTRAIT_MAX_H),
    cx: clamp(portrait.cx, PORTRAIT_CENTER_RANGE.min, PORTRAIT_CENTER_RANGE.max),
    cy: clamp(portrait.cy, PORTRAIT_CENTER_RANGE.min, PORTRAIT_CENTER_RANGE.max),
  }
}

/* ------------------------- 配置 ------------------------- */

/** 底图方式：single = 一张照片切成 9 格；nine = 9 张图各占一格 */
export type GridMode = 'single' | 'nine'

export interface Visual3dConfig {
  gridMode: GridMode
  /** 白缝宽度（相对画布边长） */
  gapRatio: number
  /** 外白框宽度（相对画布边长） */
  outerRatio: number
  /** 格子圆角 / 直角 */
  corner: CornerStyle
  /** 人像图层，没有则 null */
  portrait: PortraitConfig | null
  /** 让白缝穿过人像的段落（这些缝会画在人像之上） */
  segments: GapSegment[]
  /** 顶部文字，没有则 null */
  text: TextConfig | null
}

export function createVisual3dConfig(): Visual3dConfig {
  // 默认白缝 = 外白框，视觉上均匀（和朋友圈截图接近）
  return {
    gridMode: 'single',
    gapRatio: 0.02,
    outerRatio: 0.02,
    // 默认直角：和截图里的真九宫格一致，圆角留给想要更柔和的人自己切
    corner: 'square',
    portrait: null,
    segments: [],
    text: null,
  }
}

export function normalizeVisual3dConfig(config: Visual3dConfig, side: number): Visual3dConfig {
  return {
    ...config,
    gapRatio: clamp(config.gapRatio, GAP_RATIO_RANGE.min, GAP_RATIO_RANGE.max),
    outerRatio: clamp(config.outerRatio, OUTER_RATIO_RANGE.min, OUTER_RATIO_RANGE.max),
    portrait: config.portrait ? normalizePortrait(config.portrait, side) : null,
    text: config.text
      ? {
          ...config.text,
          sizeRatio: clamp(config.text.sizeRatio, TEXT_SIZE_RANGE.min, TEXT_SIZE_RANGE.max),
          paddingRatio: clamp(config.text.paddingRatio, 0, 0.08),
        }
      : null,
  }
}

/** 画布整体布局：宽度固定，有顶部文字时高度增加 */
export interface CanvasLayout {
  /** 画布总宽 */
  width: number
  /** 画布总高 */
  height: number
  /** 顶部文字区高度 */
  textHeight: number
  /** 九宫格区域（正方形，边长 = width） */
  grid: NineGridLayout
}

export function computeCanvasLayout(
  config: Visual3dConfig,
  width = NINE_GRID_SIDE
): CanvasLayout {
  const grid = computeNineGridLayout(width, config.gapRatio, config.outerRatio)
  const textHeight = measureTextArea(width, config.text)
  return { width: grid.side, height: grid.side + textHeight, textHeight, grid }
}

/* ------------------------- 绘制 ------------------------- */

/** 视口变换：canvasPoint × scale + t = 画布像素（绘画放大用） */
export interface ViewTransform {
  scale: number
  tx: number
  ty: number
}

export interface Visual3dDrawOptions {
  /**
   * 底图：单图模式传 1 张，九图模式传最多 9 张。
   * 九图模式下不足 9 张会循环填满（由调用方给出提示）。
   */
  cellImages?: CanvasImage[]
  /** 已加载的人像图：config.portrait 里只有路径，画布需要图片对象 */
  portraitImage?: CanvasImage | null
  /** 是否绘制编辑辅助（人像框、白缝导引线）；导出时传 false */
  overlay?: boolean
  /** 是否在编辑人像（决定要不要显示人像框） */
  portraitActive?: boolean
  /** 正在画「穿过人像的白缝」：显示导引线 */
  penMode?: boolean
  /** 正在拖的那一段（还没提交，只用于预览） */
  previewSegment?: GapSegment | null
  /**
   * 当前用的是哪个工具（决定预览怎么画）：
   * brush = 把白缝画出来（变白）；eraser = 红色标出将被擦掉的部位，绝不画白线
   */
  penTool?: 'brush' | 'eraser'
  /** 视口变换（绘画放大用）；导出不要传 */
  view?: ViewTransform
}

/** 绘制整幅画面（宽 = side，高 = side + 顶部文字区高度） */
export function drawVisual3dScene(
  ctx: Ctx2D,
  side: number,
  config: Visual3dConfig,
  options: Visual3dDrawOptions = {}
): void {
  const layout = computeNineGridLayout(side, config.gapRatio, config.outerRatio)
  const textHeight = measureTextArea(side, config.text)
  const totalHeight = side + textHeight
  const images = options.cellImages || []
  const view = options.view

  // 视口变换：绘画放大时整幅画面按它缩放平移（导出不传，就是原尺寸）
  ctx.save()
  if (view && (view.scale !== 1 || view.tx !== 0 || view.ty !== 0)) {
    ctx.translate(view.tx, view.ty)
    ctx.scale(view.scale, view.scale)
  }

  // ① 白底：白缝与外白框都是它露出来的部分
  ctx.clearRect(0, 0, side, totalHeight)
  ctx.fillStyle = CANVAS_BACKGROUND
  ctx.fillRect(0, 0, side, totalHeight)

  // ② 顶部文字：画在九宫格上方，和图片一起导成一张图
  if (textHeight > 0 && config.text) {
    drawTopText(ctx, side, textHeight, config.text)
  }

  // ③ 以下整块（九宫格 / 人像 / 穿透 / 编辑辅助）整体下移文字区高度
  ctx.save()
  ctx.translate(0, textHeight)

  // 九宫格底图
  if (images.length) {
    // 单图模式：整张图先按 cover 铺满「九宫格区域」，再按格切开（9 格共用一次映射）
    const area = gridArea(layout)
    const single =
      config.gridMode === 'single'
        ? computeFitRect(images[0].width, images[0].height, area.x, area.y, area.width, area.height, 'cover')
        : null
    const kx = single ? single.sw / Math.max(1e-6, single.dw) : 1
    const ky = single ? single.sh / Math.max(1e-6, single.dh) : 1
    // 圆角 / 直角切换
    const radius = config.corner === 'round' ? layout.cell * CELL_RADIUS_RATIO : 0

    for (let i = 0; i < GRID_SIZE * GRID_SIZE; i += 1) {
      const rect = cellRectAt(layout, i)
      const img = single ? images[0] : images[i % images.length]
      if (!img || rect.size < 1) continue

      ctx.save()
      ctx.beginPath()
      traceRoundRect(ctx, rect.x, rect.y, rect.size, rect.size, radius)
      ctx.clip()

      if (single) {
        // 取「整图映射」中该格对应的那一小块
        ctx.drawImage(
          img,
          single.sx + (rect.x - single.dx) * kx,
          single.sy + (rect.y - single.dy) * ky,
          rect.size * kx,
          rect.size * ky,
          rect.x,
          rect.y,
          rect.size,
          rect.size
        )
      } else {
        // 每张图各自居中裁成正方形
        const fit = computeFitRect(
          img.width,
          img.height,
          rect.x,
          rect.y,
          rect.size,
          rect.size,
          'cover'
        )
        ctx.drawImage(img, fit.sx, fit.sy, fit.sw, fit.sh, fit.dx, fit.dy, fit.dw, fit.dh)
      }
      ctx.restore()
    }
  }

  // ③ 人像图层：画在最上层，不透明像素盖住白缝 —— 这就是"从九宫格里走出来"
  const portrait = config.portrait
  const portraitImg = options.portraitImage
  const portraitReady = !!(portrait && portraitImg && portraitImg.width > 0 && portraitImg.height > 0)
  if (portrait && portraitReady && portraitImg) {
    const size = getPortraitSize(portrait, side, portraitImg.width, portraitImg.height)
    const center = getPortraitCenter(portrait, side)
    ctx.save()
    ctx.translate(center.x, center.y)
    if (portrait.rotation) ctx.rotate((portrait.rotation * Math.PI) / 180)
    ctx.drawImage(portraitImg, -size.width / 2, -size.height / 2, size.width, size.height)
    ctx.restore()
  }

  // ④ 让白缝穿过人像：把拖到的白缝段重画到人像之上。
  // 一挡一穿，人像和网格才有前后穿插的立体感（只盖住不穿过去会像贴了张纸）
  // 预览只在编辑时出现：导出绝不能带上画笔 / 橡皮擦的痕迹
  const preview = options.overlay ? options.previewSegment : null
  const erasing = options.penTool === 'eraser'
  const drawn = config.segments.slice()
  if (preview && !erasing) drawn.push(preview)
  if (drawn.length) {
    ctx.save()
    ctx.fillStyle = CANVAS_BACKGROUND
    for (let i = 0; i < drawn.length; i += 1) {
      const rect = segmentRect(layout, drawn[i])
      if (rect) ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
    }
    ctx.restore()
  }

  // 橡皮擦的预览：绝对不画白线（画了会让人以为在"加白线"），
  // 而是用红色标出「会被擦掉的部分」，一眼就能分清两个工具
  if (erasing && preview) {
    ctx.save()
    // 整段拖过的范围：淡红示意橡皮擦的足迹
    const rangeRect = segmentRect(layout, preview)
    if (rangeRect) {
      ctx.globalAlpha = 0.22
      ctx.fillStyle = '#e34d59'
      ctx.fillRect(rangeRect.x, rangeRect.y, rangeRect.width, rangeRect.height)
      ctx.globalAlpha = 1
    }
    // 真会被擦掉的部分：实红
    const targets = intersectSegments(config.segments, preview)
    ctx.fillStyle = '#e34d59'
    for (let i = 0; i < targets.length; i += 1) {
      const rect = segmentRect(layout, targets[i])
      if (rect) ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
    }
    ctx.restore()
  }

  // ④ 编辑辅助：只在预览里画，导出不画
  if (options.overlay) {
    // 画穿透时给白缝描一道细绿线，提示可以往哪儿拖
    if (options.penMode) {
      ctx.save()
      ctx.strokeStyle = 'rgba(7, 193, 96, 0.55)'
      ctx.lineWidth = Math.max(1.5, side / 700)
      for (let i = 0; i < GAP_STRIPS.length; i += 1) {
        const id = GAP_STRIPS[i]
        const rect = stripRect(layout, id)
        ctx.beginPath()
        if (stripAxis(id) === 'vertical') {
          const cx = rect.x + rect.width / 2
          ctx.moveTo(cx, rect.y)
          ctx.lineTo(cx, rect.y + rect.height)
        } else {
          const cy = rect.y + rect.height / 2
          ctx.moveTo(rect.x, cy)
          ctx.lineTo(rect.x + rect.width, cy)
        }
        ctx.stroke()
      }
      ctx.restore()
    }

    // 人像选框（跟着旋转一起转）
    if (portraitReady && portrait && portraitImg) {
      const size = getPortraitSize(portrait, side, portraitImg.width, portraitImg.height)
      const center = getPortraitCenter(portrait, side)
      const outline = Math.max(2, side / 500)
      ctx.save()
      ctx.translate(center.x, center.y)
      if (portrait.rotation) ctx.rotate((portrait.rotation * Math.PI) / 180)
      ctx.beginPath()
      ctx.rect(-size.width / 2, -size.height / 2, size.width, size.height)
      ctx.lineWidth = outline + Math.max(2, outline)
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)'
      ctx.stroke()
      ctx.beginPath()
      ctx.rect(-size.width / 2, -size.height / 2, size.width, size.height)
      ctx.lineWidth = outline
      ctx.strokeStyle = options.portraitActive ? '#07c160' : 'rgba(255, 255, 255, 0.9)'
      ctx.stroke()
      ctx.restore()
    }
  }

  ctx.restore() // 九宫格下移
  ctx.restore() // 视口变换
}

/** 顶部文字：支持换行；太长时按最宽的一行整体缩小字号，保证装在文字区里 */
function drawTopText(ctx: Ctx2D, width: number, areaHeight: number, text: TextConfig): void {
  const lines = splitTextLines(text.text)
  if (!lines.length) return
  const pad = clamp(text.paddingRatio, 0, 0.08) * width
  let fontSize = clamp(text.sizeRatio, TEXT_SIZE_RANGE.min, TEXT_SIZE_RANGE.max) * width
  const fontOf = (size: number): string => canvasFont(size, text.bold)

  ctx.save()
  ctx.font = fontOf(fontSize)
  // 超宽自动缩小：按最宽的一行算，整块一起缩，各行字号才一致
  // （measureText 不可用时跳过，不影响主流程）
  if (typeof ctx.measureText === 'function') {
    const available = Math.max(1, width - pad * 2)
    let widest = 0
    try {
      for (let i = 0; i < lines.length; i += 1) {
        const lineWidth = ctx.measureText(lines[i]).width || 0
        if (lineWidth > widest) widest = lineWidth
      }
    } catch (err) {
      widest = 0
    }
    if (widest > available) {
      fontSize = Math.max(10, fontSize * (available / widest))
      ctx.font = fontOf(fontSize)
    }
  }

  ctx.fillStyle = text.color
  ctx.textAlign = text.align === 'center' ? 'center' : 'left'
  ctx.textBaseline = 'middle'
  const lineHeight = fontSize * TEXT_LINE_HEIGHT_RATIO
  const x = text.align === 'center' ? width / 2 : pad
  // 整块文字在文字区里垂直居中（单行时和以前完全一致）
  const firstY = (areaHeight - lineHeight * lines.length) / 2 + lineHeight / 2
  for (let i = 0; i < lines.length; i += 1) {
    ctx.fillText(lines[i], x, firstY + i * lineHeight)
  }
  ctx.restore()
}
