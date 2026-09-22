/**
 * Canvas 2D 封装（基础库 2.30.0+）
 * 约定：canvas.width / canvas.height 使用「图片像素」作为坐标系，
 * 显示尺寸由 WXSS 控制，触摸坐标统一用 toCanvasPoint 换算。
 */

/** Canvas 2D 节点 */
export type CanvasNode = WechatMiniprogram.Canvas
/** Canvas 2D 上下文 */
export type Ctx2D = WechatMiniprogram.CanvasRenderingContext.CanvasRenderingContext2D
/** Canvas 内可绘制对象（createImage 的返回） */
export type CanvasImage = WechatMiniprogram.Image

/** 画布后备存储单边上限（水印 / 贴纸 / 裁剪），避免大图导致内存溢出 */
export const MAX_CANVAS_SIDE = 2160
/** 九宫格单块导出单边上限 */
export const MAX_TILE_SIDE = 1080
/**
 * 九宫格源图单边上限。
 * 九宫格取居中正方形，用的是图片短边，所以这里限制的是「长边」，短边会被同比缩小。
 * 典型 4:3 手机照片（4032×3024）降采样后约 3600×2700，单块约 900px；
 * 想再清晰一点可以调大这个值（注意内存：3600×2700 ≈ 36MB 位图）。
 */
export const MAX_SOURCE_SIDE = 3600
/** 导出图默认单边上限（页面显式传 destWidth 时不生效） */
export const MAX_EXPORT_SIDE = 1080

/**
 * 画布四周要留出的空间（rpx，两侧合计）：页面 24 + 卡片 24 + `.canvas-wrap` 的 16。
 * 各页按窗口宽度算预览尺寸时必须扣掉它，否则画布会顶到工作区边框、被 overflow 裁掉一条边
 * （历史上九宫格预览就因为漏算卡片内边距，左右各被裁掉约 12px）。
 */
export const STAGE_RESERVED_RPX = (24 + 24 + 16) * 2

/**
 * 画布上的触摸点
 * canvas 的 touch 事件在运行时带有相对画布左上角的 x / y（类型定义里没写，这里显式声明）
 */
export interface CanvasTouch {
  x: number
  y: number
  identifier?: number
}

/** 支持在页面或组件内查询节点 */
export interface QueryScope {
  createSelectorQuery(): WechatMiniprogram.SelectorQuery
}

export interface CanvasHandles {
  canvas: CanvasNode
  ctx: Ctx2D
  /** 节点布局尺寸（px） */
  cssWidth: number
  cssHeight: number
}

/** 查询一次画布节点，未渲染完成时返回 null */
function queryCanvasOnce(selector: string, scope?: QueryScope): Promise<CanvasHandles | null> {
  return new Promise((resolve) => {
    const query = scope ? scope.createSelectorQuery() : wx.createSelectorQuery()
    const nodesRef = query.select(selector) as unknown as {
      fields(fields: Record<string, unknown>, cb: (res: unknown) => void): { exec(): void }
    }
    nodesRef
      .fields({ node: true, size: true }, (res: unknown) => {
        const node = res as { node?: CanvasNode; width?: number; height?: number } | null
        if (!node || !node.node) {
          resolve(null)
          return
        }
        resolve({
          canvas: node.node,
          ctx: node.node.getContext('2d'),
          cssWidth: node.width || 0,
          cssHeight: node.height || 0,
        })
      })
      .exec()
  })
}

/**
 * 获取 Canvas 2D 节点与上下文
 * canvas 用 wx:if 控制显示时，节点可能还没渲染完，这里重试几次
 */
export async function getCanvasNode(
  selector = '#editCanvas',
  scope?: QueryScope,
  retry = 3
): Promise<CanvasHandles> {
  for (let i = 0; i < retry; i += 1) {
    const handles = await queryCanvasOnce(selector, scope)
    if (handles) return handles
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('画布初始化失败，请返回重进')
}

/** 设置画布像素尺寸，并清空重绘 */
export function setCanvasSize(canvas: CanvasNode, ctx: Ctx2D, width: number, height: number): void {
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  clearCanvas(ctx, canvas.width, canvas.height)
}

/** 按图片比例计算画布尺寸（单边不超过 maxSide） */
export function computeCanvasSize(
  imgWidth: number,
  imgHeight: number,
  maxSide = MAX_CANVAS_SIDE
): { width: number; height: number; scale: number } {
  const w = Math.max(1, imgWidth)
  const h = Math.max(1, imgHeight)
  const longSide = Math.max(w, h)
  const scale = longSide > maxSide ? maxSide / longSide : 1
  return {
    width: Math.round(w * scale),
    height: Math.round(h * scale),
    scale,
  }
}

/**
 * 用 canvas.createImage() 加载图片（不要用 wx.createImage）
 * 注意：部分基础库 / 开发者工具下 onload 时 img.width / img.height 可能为 0，
 * 这里用 wx.getImageInfo 兜底，否则按尺寸计算会得到 1px 的画布（切图就废了）。
 */
export async function loadImage(canvas: CanvasNode, src: string): Promise<CanvasImage> {
  const img = await new Promise<CanvasImage>((resolve, reject) => {
    const image = canvas.createImage()
    image.onload = () => resolve(image)
    // 带上路径尾部，方便定位是哪条路径解不了（压缩产物 / 原图 / getImageInfo 路径）
    image.onerror = () => reject(new Error(`图片加载失败（${src.slice(-16)}）`))
    image.src = src
  })

  if (!img.width || !img.height) {
    const info = await new Promise<WechatMiniprogram.GetImageInfoSuccessCallbackResult | null>(
      (resolve) => {
        wx.getImageInfo({
          src,
          success: (res) => resolve(res),
          fail: () => resolve(null),
        })
      }
    )
    if (info) {
      img.width = info.width
      img.height = info.height
    }
  }

  if (!img.width || !img.height) {
    throw new Error('图片尺寸读取失败，请换一张图片')
  }
  return img
}

/** 清空画布 */
export function clearCanvas(ctx: Ctx2D, width: number, height: number): void {
  ctx.clearRect(0, 0, width, height)
}

/* ------------------------- 画布字体 ------------------------- */

/**
 * 画布文字用的字体栈：和 app.wxss 里页面的默认字体一字不差（微信默认字体）。
 * canvas 的 font 必须写字体名，写 sans-serif 在 iOS 上会落到 Helvetica，
 * 和页面文字（-apple-system → SF Pro / PingFang）观感不一致，所以把同一套字体栈搬过来。
 */
export const CANVAS_FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", Helvetica, sans-serif'

/** 拼 canvas 的 font 字符串（字号取整，避免小数导致部分机型回退到默认字号） */
export function canvasFont(size: number, bold = false): string {
  return `${bold ? 'bold ' : ''}${Math.round(size)}px ${CANVAS_FONT_FAMILY}`
}

export interface FitRect {
  sx: number
  sy: number
  sw: number
  sh: number
  dx: number
  dy: number
  dw: number
  dh: number
}

/**
 * 计算图片在目标区域内的适配矩形
 * cover：铺满目标区域（超出部分裁掉）
 * contain：完整显示在目标区域内（留白）
 */
export function computeFitRect(
  imgWidth: number,
  imgHeight: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  mode: 'cover' | 'contain' = 'cover'
): FitRect {
  const iw = Math.max(1, imgWidth)
  const ih = Math.max(1, imgHeight)

  // contain：整张图完整放进目标区域，居中留白
  if (mode === 'contain') {
    const scale = Math.min(dw / iw, dh / ih)
    const renderW = iw * scale
    const renderH = ih * scale
    return {
      sx: 0,
      sy: 0,
      sw: iw,
      sh: ih,
      dx: dx + (dw - renderW) / 2,
      dy: dy + (dh - renderH) / 2,
      dw: renderW,
      dh: renderH,
    }
  }

  // cover：把源图按「与目标区域同比例」居中裁一块，再铺满目标区域。
  // 注意源矩形与目标矩形必须是同一个缩放比，否则图片会被拉扁。
  const scale = Math.max(dw / iw, dh / ih)
  const sw = Math.min(iw, dw / scale)
  const sh = Math.min(ih, dh / scale)
  return {
    sx: (iw - sw) / 2,
    sy: (ih - sh) / 2,
    sw,
    sh,
    dx,
    dy,
    dw,
    dh,
  }
}

/** 按比例绘制图片（cover / contain） */
export function drawImageFit(
  ctx: Ctx2D,
  img: CanvasImage,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  mode: 'cover' | 'contain' = 'cover'
): FitRect {
  const r = computeFitRect(img.width, img.height, dx, dy, dw, dh, mode)
  ctx.drawImage(img, r.sx, r.sy, r.sw, r.sh, r.dx, r.dy, r.dw, r.dh)
  return r
}

/** 将触摸点（相对画布的 px）换算为画布像素坐标 */
export function toCanvasPoint(
  touch: { x: number; y: number },
  cssWidth: number,
  cssHeight: number,
  canvasWidth: number,
  canvasHeight: number
): { x: number; y: number } {
  const sx = cssWidth ? canvasWidth / cssWidth : 1
  const sy = cssHeight ? canvasHeight / cssHeight : 1
  return { x: touch.x * sx, y: touch.y * sy }
}

export interface ExportOptions {
  x?: number
  y?: number
  width?: number
  height?: number
  destWidth?: number
  destHeight?: number
  fileType?: 'png' | 'jpg'
  quality?: number
}

/** 导出画布为临时文件路径（必须传 canvas 对象，而不是 canvasId） */
export async function exportCanvas(
  canvas: CanvasNode,
  options: ExportOptions = {}
): Promise<string> {
  // 让出一个事件循环，确保绘制指令已提交（个别机型导出过快会拿到空白图）
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  return new Promise((resolve, reject) => {
    const width = options.width || canvas.width
    const height = options.height || canvas.height
    const scale = Math.min(1, MAX_EXPORT_SIDE / Math.max(width, height))
    wx.canvasToTempFilePath({
      canvas: canvas as unknown as WechatMiniprogram.Canvas,
      x: options.x || 0,
      y: options.y || 0,
      width,
      height,
      destWidth: options.destWidth || Math.round(width * scale),
      destHeight: options.destHeight || Math.round(height * scale),
      fileType: options.fileType || 'png',
      quality: options.quality === undefined ? 0.92 : options.quality,
      success: (res) => resolve(res.tempFilePath),
      fail: (err) => reject(new Error(err.errMsg || '导出图片失败')),
    })
  })
}

/** 绘制圆角矩形路径 */
export function roundRectPath(
  ctx: Ctx2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  const r = Math.min(radius, width / 2, height / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + width, y, x + width, y + height, r)
  ctx.arcTo(x + width, y + height, x, y + height, r)
  ctx.arcTo(x, y + height, x, y, r)
  ctx.arcTo(x, y, x + width, y, r)
  ctx.closePath()
}
