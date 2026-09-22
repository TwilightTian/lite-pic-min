/** 水印添加：文字 / 图片水印，支持图上直接拖动定位、实时预览 */
import {
  CanvasHandles,
  CanvasImage,
  CanvasTouch,
  MAX_CANVAS_SIDE,
  STAGE_RESERVED_RPX,
  computeCanvasSize,
  exportCanvas,
  getCanvasNode,
} from '../../utils/canvas'
import {
  chooseImage,
  describeImageSize,
  loadPrepared,
  prepareImage,
  saveToAlbum,
} from '../../utils/image'
import { drawWatermarkScene, getWatermarkBox, hitTestWatermark } from '../../utils/watermark'
import { createWatermarkConfig, WatermarkConfig, WatermarkPosition } from '../../types/index'
import {
  angleOf,
  clamp,
  distanceOf,
  hideLoading,
  nearestOptionIndex,
  normalizeRotation,
  optionRatioAt,
  showLoading,
  toast,
  toastError,
} from '../../utils/util'

const COLORS = ['#ffffff', '#000000', '#f5222d', '#fa8c16', '#fadb14', '#52c41a', '#1677ff', '#722ed1']

/** 水印图最大边长（水印本身画得很小，没必要加载超大图） */
const WATERMARK_IMAGE_MAX_SIDE = 1080

/** 字号 / 缩放的手势缩放范围 */
const FONT_SIZE_RANGE = { min: 0.02, max: 0.2 }
const IMAGE_SCALE_RANGE = { min: 0.05, max: 0.8 }

const ADVICE = '选一张照片，把想加的文字或图片加到照片上。照片太大时会自动缩小，不影响保存效果。'

const POSITIONS: Array<{ key: WatermarkPosition }> = [
  { key: 'top-left' },
  { key: 'top' },
  { key: 'top-right' },
  { key: 'left' },
  { key: 'center' },
  { key: 'right' },
  { key: 'bottom-left' },
  { key: 'bottom' },
  { key: 'bottom-right' },
]

/** 字号档位：让用户选小 / 标准 / 大，比拖滑块猜大小直观（比例相对画布宽度） */
const FONT_SIZE_OPTIONS = [
  { key: 'small', label: '小', ratio: 0.04 },
  { key: 'normal', label: '标准', ratio: 0.06 },
  { key: 'large', label: '大', ratio: 0.1 },
]

/** 相对比例字段 → 百分比显示值（透明度、水印大小、边距走滑块） */
function toPct(wm: WatermarkConfig) {
  return {
    opacity: Math.round(wm.opacity * 100),
    padding: Math.round(wm.padding * 100),
    imageScale: Math.round(wm.imageScale * 100),
  }
}

/**
 * 相对比例字段 → 实际像素（显示用）。
 * 画布宽度就是保存出来那张图的宽度，所以这些数值就是成品里的真实大小；
 * 还没选照片时按最大处理宽度估一个，选完照片会按真实宽度重算。
 */
function toPx(wm: WatermarkConfig, canvasWidth: number) {
  const cw = canvasWidth > 0 ? canvasWidth : MAX_CANVAS_SIDE
  return {
    imageScale: Math.round(wm.imageScale * cw),
    padding: Math.round(wm.padding * cw),
  }
}

Page({
  data: {
    src: '',
    hasImage: false,
    displayW: 300,
    displayH: 300,
    wm: createWatermarkConfig(),
    /** 滑块用的百分比数值（透明度 / 水印大小 / 边距） */
    pct: toPct(createWatermarkConfig()),
    /** 水印大小 / 边距的实际像素（显示用） */
    px: toPx(createWatermarkConfig(), 0),
    /** 字号档位：滑块按下标走，右侧显示档位文字（小 / 标准 / 大） */
    fontIndex: 1,
    fontLabel: '标准',
    fontOptions: FONT_SIZE_OPTIONS,
    colors: COLORS,
    positions: POSITIONS,
    /** 是否使用自由位置（拖动过） */
    freeMode: false,
    /** 是否展开「更多设置」 */
    moreOpen: false,
    imageTip: '',
    advice: ADVICE,
    exporting: false,
    working: false,
  },

  handles: null as CanvasHandles | null,
  image: null as CanvasImage | null,
  wmImage: null as CanvasImage | null,
  canvasSize: { width: 0, height: 0 },
  maxDisplay: { width: 300, height: 360 },
  drawPending: false,
  /** 权威配置：手势过程中直接改它并重绘，避免高频 setData */
  wmState: createWatermarkConfig(),
  /** 已加载的水印图路径 */
  wmLoadedSrc: '',
  wmLoading: false,

  gesture: {
    mode: 'none' as 'none' | 'drag' | 'pinch',
    grabDX: 0,
    grabDY: 0,
    startDistance: 0,
    startAngle: 0,
    baseFontSize: 0,
    baseImageScale: 0,
    baseRotation: 0,
  },

  onLoad() {
    const win = wx.getWindowInfo()
    // 扣掉页面 + 卡片 + 画布外框的留白，画布才不会被工作区边框裁掉
    const available = win.windowWidth - STAGE_RESERVED_RPX * (win.windowWidth / 750)
    this.maxDisplay = {
      width: Math.floor(Math.min(available, 420)),
      height: Math.max(240, win.windowHeight * 0.5),
    }
    this.setData({ displayW: this.maxDisplay.width, displayH: this.maxDisplay.width })
  },

  /* -------------------- 画布 -------------------- */

  async ensureCanvas(): Promise<CanvasHandles> {
    if (!this.handles) {
      this.handles = await getCanvasNode('#editCanvas')
    }
    return this.handles
  },

  /** 合并绘制，避免高频 setData 造成重复绘制 */
  scheduleDraw() {
    if (this.drawPending) return
    this.drawPending = true
    wx.nextTick(() => {
      this.drawPending = false
      this.draw()
    })
  },

  draw() {
    const handles = this.handles
    if (!this.image || !handles) return
    const { width, height } = this.canvasSize
    drawWatermarkScene(handles.ctx, this.image, width, height, this.wmState, this.wmImage)
  },

  /** 需要同步到视图层的字段（配置 / 滑块百分比 / 像素值 / 字号档位） */
  viewFields(wm: WatermarkConfig) {
    const fontIndex = nearestOptionIndex(FONT_SIZE_OPTIONS, wm.fontSize)
    return {
      wm: { ...wm },
      pct: toPct(wm),
      px: toPx(wm, this.canvasSize.width),
      fontIndex,
      fontLabel: FONT_SIZE_OPTIONS[fontIndex].label,
      freeMode: wm.useFree,
    }
  },

  /** 手势中改完配置后重绘；syncView 为 true 时同步到视图层 */
  commitWm(syncView: boolean) {
    if (syncView) {
      this.setData(this.viewFields(this.wmState))
    }
    this.draw()
  },

  /* -------------------- 选择图片 -------------------- */

  /** 点击预览区域：未选图时直接进入选择 */
  onTapStage() {
    if (!this.data.hasImage) this.pickBaseImage()
  },

  onRepick() {
    this.pickBaseImage()
  },

  async pickBaseImage() {
    if (this.data.working) return
    try {
      const paths = await chooseImage(1)
      const path = paths[0]
      if (!path) return
      // 大图要压缩、解码，需要点时间，先给用户一个明确的反馈
      showLoading('正在处理照片')
      this.setData({ working: true })

      // 原图可能非常大，先降到可控尺寸再交给 canvas
      const prepared = await prepareImage(path, MAX_CANVAS_SIDE)

      // 画布由 wx:if 控制，重新选图时节点会重建，清掉缓存再查询
      this.handles = null
      await new Promise<void>((resolve) =>
        this.setData({ src: prepared.src, hasImage: true }, resolve)
      )

      const { canvas, ctx } = await this.ensureCanvas()
      const { image: img } = await loadPrepared(canvas, prepared)
      this.image = img

      const size = computeCanvasSize(img.width, img.height)
      canvas.width = size.width
      canvas.height = size.height
      this.canvasSize = { width: size.width, height: size.height }

      // 显示尺寸按图片比例适配
      const ratio = img.height / Math.max(1, img.width)
      let w = this.maxDisplay.width
      let h = w * ratio
      if (h > this.maxDisplay.height) {
        h = this.maxDisplay.height
        w = h / ratio
      }

      this.wmImage = null
      this.wmState = createWatermarkConfig()
      this.setData({
        displayW: Math.round(w),
        displayH: Math.round(h),
        // 画布宽度定了，里面的像素值按这张照片重算
        ...this.viewFields(this.wmState),
        freeMode: false,
        imageTip: describeImageSize(prepared),
      })

      ctx && this.draw()
      // 如果先选好了水印图，这时才真正有画布可加载
      this.ensureWmImage()
      hideLoading()
    } catch (err) {
      hideLoading()
      toastError(err, '照片打不开，换一张试试')
      this.handles = null
      this.image = null
      this.setData({ hasImage: false, src: '' })
    } finally {
      this.setData({ working: false })
    }
  },

  /** 选择图片水印（此时可能还没选底图，先记下路径，有画布了再加载） */
  async onChooseWatermark() {
    try {
      // 水印图常是透明 PNG（logo），必须拿原图，压缩会丢透明通道
      const paths = await chooseImage(1, ['image'], { needAlpha: true })
      const path = paths[0]
      if (!path) return
      this.updateWatermark({ type: 'image', imageSrc: path })
      await this.ensureWmImage()
    } catch (err) {
      toastError(err, '水印图打不开，换一张试试')
    }
  },

  /** 加载水印图；没有画布（还没选底图）时先跳过 */
  async ensureWmImage(): Promise<void> {
    const wm = this.wmState
    if (wm.type !== 'image' || !wm.imageSrc) return
    if (this.wmImage && this.wmLoadedSrc === wm.imageSrc) return
    const handles = this.handles
    if (!handles || this.wmLoading) return

    this.wmLoading = true
    try {
      const prepared = await prepareImage(wm.imageSrc, WATERMARK_IMAGE_MAX_SIDE)
      this.wmImage = (await loadPrepared(handles.canvas, prepared)).image
      this.wmLoadedSrc = wm.imageSrc
      this.draw()
    } catch (err) {
      toastError(err, '水印图打不开，换一张试试')
    } finally {
      this.wmLoading = false
    }
  },

  /* -------------------- 配置变更 -------------------- */

  updateWatermark(patch: Partial<WatermarkConfig>) {
    this.wmState = { ...this.wmState, ...patch }
    this.setData(this.viewFields(this.wmState))
    this.scheduleDraw()
  },

  /** 字号滑块：小 / 标准 / 大（滑块值是档位下标） */
  onFontSizeChanging(e: WechatMiniprogram.CustomEvent) {
    this.updateWatermark({ fontSize: optionRatioAt(FONT_SIZE_OPTIONS, e.detail.value) })
  },

  onFontSizeChange(e: WechatMiniprogram.CustomEvent) {
    this.updateWatermark({ fontSize: optionRatioAt(FONT_SIZE_OPTIONS, e.detail.value) })
  },

  /** 展开 / 收起更多设置 */
  onToggleMore() {
    this.setData({ moreOpen: !this.data.moreOpen })
  },

  onSwitchType(e: WechatMiniprogram.TouchEvent) {
    const type = e.currentTarget.dataset.type as WatermarkConfig['type']
    this.updateWatermark({ type })
    this.ensureWmImage()
  },

  onTextInput(e: WechatMiniprogram.Input) {
    this.updateWatermark({ text: e.detail.value })
  },

  onPickColor(e: WechatMiniprogram.TouchEvent) {
    this.updateWatermark({ color: e.currentTarget.dataset.color as string })
  },

  /** 选择预设位置（会退出自由位置模式） */
  onPickPosition(e: WechatMiniprogram.TouchEvent) {
    this.updateWatermark({
      position: e.currentTarget.dataset.key as WatermarkPosition,
      useFree: false,
    })
  },

  /** 回到预设位置（退出自由位置） */
  onResetFree() {
    this.updateWatermark({ useFree: false })
  },

  onBoldChange(e: WechatMiniprogram.CustomEvent) {
    this.updateWatermark({ bold: !!e.detail.value })
  },

  onTileChange(e: WechatMiniprogram.CustomEvent) {
    this.updateWatermark({ tile: !!e.detail.value })
  },

  /** 滑块数值 → 配置项 */
  patchFromSlider(field: string, value: number): Partial<WatermarkConfig> {
    switch (field) {
      case 'opacity':
        return { opacity: value / 100 }
      case 'padding':
        return { padding: value / 100 }
      case 'imageScale':
        return { imageScale: value / 100 }
      case 'rotation':
        return { rotation: Math.round(value) }
      case 'tileGap':
        return { tileGap: Math.round(value * 10) / 10 }
      default:
        return {}
    }
  },

  onSliderChanging(e: WechatMiniprogram.CustomEvent) {
    const field = e.currentTarget.dataset.field as string
    this.updateWatermark(this.patchFromSlider(field, e.detail.value))
  },

  onSliderChange(e: WechatMiniprogram.CustomEvent) {
    const field = e.currentTarget.dataset.field as string
    this.updateWatermark(this.patchFromSlider(field, e.detail.value))
  },

  /* -------------------- 图上拖拽 -------------------- */

  /** touch（显示坐标）→ 画布像素坐标 */
  toCanvasPoint(touch: CanvasTouch): { x: number; y: number } {
    const { displayW, displayH } = this.data
    const { width, height } = this.canvasSize
    return {
      x: touch.x * (width / Math.max(1, displayW)),
      y: touch.y * (height / Math.max(1, displayH)),
    }
  },

  onTouchStart(e: WechatMiniprogram.TouchEvent) {
    const handles = this.handles
    const wm = this.wmState
    if (!this.image || !handles) return
    const touches = e.touches as unknown as CanvasTouch[]
    const g = this.gesture
    const { width, height } = this.canvasSize

    if (touches.length >= 2) {
      // 双指缩放 / 旋转（平铺模式同样可以调整参数）
      g.mode = 'pinch'
      g.startDistance = distanceOf(touches[0], touches[1])
      g.startAngle = angleOf(touches[0], touches[1])
      g.baseFontSize = wm.fontSize
      g.baseImageScale = wm.imageScale
      g.baseRotation = wm.rotation
      return
    }

    // 平铺模式没有单一水印可按，交给滑块调整
    if (wm.tile) {
      g.mode = 'none'
      return
    }

    const point = this.toCanvasPoint(touches[0])
    const box = getWatermarkBox(handles.ctx, wm, this.wmImage, width, height)
    if (!box || !hitTestWatermark(handles.ctx, wm, this.wmImage, width, height, point)) {
      g.mode = 'none'
      return
    }
    // 记录手指与水印中心的偏移，拖动时不会跳变
    g.mode = 'drag'
    g.grabDX = point.x - box.cx
    g.grabDY = point.y - box.cy
  },

  onTouchMove(e: WechatMiniprogram.TouchEvent) {
    const g = this.gesture
    if (!this.image || g.mode === 'none') return
    const touches = e.touches as unknown as CanvasTouch[]
    const wm = this.wmState
    const { width, height } = this.canvasSize

    if (g.mode === 'pinch' && touches.length >= 2) {
      const dist = distanceOf(touches[0], touches[1])
      if (dist > 0 && g.startDistance > 0) {
        const ratio = dist / g.startDistance
        if (wm.type === 'image') {
          wm.imageScale = clamp(
            g.baseImageScale * ratio,
            IMAGE_SCALE_RANGE.min,
            IMAGE_SCALE_RANGE.max
          )
        } else {
          wm.fontSize = clamp(g.baseFontSize * ratio, FONT_SIZE_RANGE.min, FONT_SIZE_RANGE.max)
        }
      }
      wm.rotation = normalizeRotation(
        g.baseRotation + (angleOf(touches[0], touches[1]) - g.startAngle)
      )
      this.commitWm(false)
      return
    }

    if (g.mode === 'drag' && touches.length === 1) {
      const point = this.toCanvasPoint(touches[0])
      wm.useFree = true
      wm.freeX = clamp((point.x - g.grabDX) / Math.max(1, width), 0, 1)
      wm.freeY = clamp((point.y - g.grabDY) / Math.max(1, height), 0, 1)
      this.commitWm(false)
    }
  },

  onTouchEnd() {
    if (this.gesture.mode === 'none') return
    this.gesture.mode = 'none'
    // 手势结束，把最终值同步到视图层（滑块、位置状态）
    this.commitWm(true)
  },

  /* -------------------- 导出 -------------------- */

  async onExport() {
    const handles = this.handles
    const wm = this.wmState
    if (this.data.exporting) return
    if (!this.image || !handles) {
      toast('请先选择照片')
      return
    }
    if (wm.type === 'image' && !wm.imageSrc) {
      toast('请先选一张水印图')
      return
    }
    try {
      this.setData({ exporting: true })
      showLoading('正在保存')

      // 水印图可能还没加载（先选的水印图、后选的底图），这里补一次
      if (wm.type === 'image' && !this.wmImage) {
        await this.ensureWmImage()
        if (!this.wmImage) throw new Error('水印图没加载成功，重新选一次')
      }

      const { canvas } = handles
      this.draw()
      const file = await exportCanvas(canvas, {
        width: this.canvasSize.width,
        height: this.canvasSize.height,
        destWidth: this.canvasSize.width,
        destHeight: this.canvasSize.height,
      })
      await saveToAlbum(file)
      hideLoading()
      toast('已保存到相册', 'success')
    } catch (err) {
      hideLoading()
      toastError(err, '保存失败，重试一下')
    } finally {
      this.setData({ exporting: false })
    }
  },

  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent {
    return { title: '水印添加 - 文字/图片水印自由搭配', path: '/pages/index/index' }
  },
})
