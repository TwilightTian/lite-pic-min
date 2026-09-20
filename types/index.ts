/**
 * 全局类型定义
 */

/** 编辑态图层（用于描述绘制顺序，实际绘制由各功能模块负责） */
export interface Layer {
  id: string
  type: 'image' | 'watermark' | 'sticker'
  visible: boolean
}

/* ------------------------- 水印 ------------------------- */

export type WatermarkType = 'text' | 'image'

/** 水印位置：九宫格方位；tile 开启时忽略 */
export type WatermarkPosition =
  | 'top-left'
  | 'top'
  | 'top-right'
  | 'left'
  | 'center'
  | 'right'
  | 'bottom-left'
  | 'bottom'
  | 'bottom-right'

export interface WatermarkConfig {
  type: WatermarkType
  /** 文字内容 */
  text: string
  /** 文字颜色 */
  color: string
  /** 是否加粗 */
  bold: boolean
  /** 字号占画布宽度的比例（0.02 ~ 0.2） */
  fontSize: number
  /** 透明度 0 ~ 1 */
  opacity: number
  /** 旋转角度，单位度 */
  rotation: number
  /** 预设位置（九宫格方位） */
  position: WatermarkPosition
  /** 是否使用自由位置（在画布上拖动过之后为 true） */
  useFree: boolean
  /** 自由位置：水印中心相对画布的坐标，0 ~ 1 */
  freeX: number
  freeY: number
  /** 是否平铺 */
  tile: boolean
  /** 平铺时相邻水印间距（相对字号的倍数） */
  tileGap: number
  /** 图片水印路径 */
  imageSrc: string
  /** 图片水印宽度占画布宽度的比例 */
  imageScale: number
  /** 边距占画布宽度的比例 */
  padding: number
}

/* ------------------------- 贴纸 ------------------------- */

export interface StickerItem {
  id: string
  type: 'emoji' | 'image'
  /** emoji 字符或图片路径 */
  content: string
  /** 中心点 x（相对画布宽度的比例 0~1） */
  x: number
  /** 中心点 y（相对画布高度的比例 0~1） */
  y: number
  /** 尺寸占画布短边的比例 */
  scale: number
  /** 旋转角度，单位度 */
  rotation: number
  /** 透明度 0 ~ 1 */
  opacity: number
}

/* ------------------------- 裁剪 ------------------------- */

export type CropRatio = 'free' | '1:1' | '4:3' | '16:9' | '3:4' | '9:16'

export interface CropConfig {
  ratio: CropRatio
  /** free 比例下裁剪框宽度占画布宽度的比例 0.2 ~ 1 */
  freeWidthPct: number
  /** free 比例下裁剪框高度占画布高度的比例 0.2 ~ 1 */
  freeHeightPct: number
  /** 底图偏移（相对底图尺寸的比例，中心为 0） */
  offsetX: number
  offsetY: number
  /** 底图缩放倍数，1 表示恰好铺满画布 */
  scale: number
}

/* ------------------------- 编辑状态 ------------------------- */

export interface EditState {
  src: string
  canvasWidth: number
  canvasHeight: number
  layers: Layer[]
  watermark: WatermarkConfig
  stickers: StickerItem[]
  crop: CropConfig
}

/* ------------------------- 默认值 ------------------------- */

export function createWatermarkConfig(): WatermarkConfig {
  return {
    type: 'text',
    text: '轻图九宫格',
    color: '#ffffff',
    bold: true,
    fontSize: 0.06,
    opacity: 0.8,
    rotation: -30,
    position: 'bottom-right',
    useFree: false,
    freeX: 0.5,
    freeY: 0.5,
    tile: false,
    tileGap: 2,
    imageSrc: '',
    imageScale: 0.2,
    padding: 0.04,
  }
}

export function createCropConfig(): CropConfig {
  return {
    ratio: '1:1',
    freeWidthPct: 0.8,
    freeHeightPct: 0.8,
    offsetX: 0,
    offsetY: 0,
    scale: 1,
  }
}
