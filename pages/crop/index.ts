/** 图片裁剪：裁剪框居中固定比例，拖动/缩放底图调整内容 */
import {
  CanvasHandles,
  CanvasImage,
  CanvasTouch,
  MAX_CANVAS_SIDE,
  STAGE_RESERVED_RPX,
  computeCanvasSize,
  getCanvasNode,
} from '../../utils/canvas'
import {
  chooseImage,
  describeImageSize,
  loadPrepared,
  prepareImage,
  saveToAlbum,
} from '../../utils/image'
import { drawCropScene, exportCrop, normalizeCropConfig } from '../../utils/crop'
import { createCropConfig, CropConfig, CropRatio } from '../../types/index'
import { clamp, hideLoading, showLoading, toast, toastError } from '../../utils/util'

const RATIOS: Array<{ key: CropRatio; label: string }> = [
  { key: 'free', label: '自由' },
  { key: '1:1', label: '1:1' },
  { key: '4:3', label: '4:3' },
  { key: '16:9', label: '16:9' },
  { key: '3:4', label: '3:4' },
  { key: '9:16', label: '9:16' },
]

/** 选图前的说明（尽量说人话） */
const ADVICE = '选一张照片，拖动或放大缩小，把想要的部分框住就行。照片太大时会自动缩小，不影响保存效果。'

function toPct(crop: CropConfig) {
  return {
    freeWidth: Math.round(crop.freeWidthPct * 100),
    freeHeight: Math.round(crop.freeHeightPct * 100),
  }
}

/**
 * 裁剪框比例 → 实际像素（显示用）。
 * 与 utils/crop.computeCropBox 一致：宽按画布宽度、高按画布高度算，
 * 也就是保存出来那张图的尺寸。没选照片时按最大处理尺寸估一个。
 */
function toPx(crop: CropConfig, cw: number, ch: number) {
  const width = cw > 0 ? cw : MAX_CANVAS_SIDE
  const height = ch > 0 ? ch : MAX_CANVAS_SIDE
  return {
    freeWidth: Math.round(clamp(crop.freeWidthPct, 0.2, 1) * width),
    freeHeight: Math.round(clamp(crop.freeHeightPct, 0.2, 1) * height),
  }
}

Page({
  data: {
    src: '',
    hasImage: false,
    displayW: 300,
    displayH: 300,
    crop: createCropConfig(),
    pct: toPct(createCropConfig()),
    /** 裁剪框的实际像素（显示用） */
    px: toPx(createCropConfig(), 0, 0),
    scaleDisplay: 1,
    ratios: RATIOS,
    imageTip: '',
    advice: ADVICE,
    /** 是否展开「更多设置」 */
    moreOpen: false,
    exporting: false,
    working: false,
  },

  handles: null as CanvasHandles | null,
  /** 屏幕外的工作画布：导出在这里做，可视画布保持不动 */
  workHandles: null as CanvasHandles | null,
  image: null as CanvasImage | null,
  /** 权威配置（拖动过程中不写回 data，避免高频 setData） */
  crop: createCropConfig(),
  canvasSize: { width: 0, height: 0 },
  imgRatio: 1,
  maxDisplay: { width: 300, height: 360 },

  /** 手势起始状态 */
  gesture: {
    active: false,
    startX: 0,
    startY: 0,
    startOffsetX: 0,
    startOffsetY: 0,
    startDistance: 0,
    startScale: 1,
  },

  onLoad() {
    const win = wx.getWindowInfo()
    // 扣掉页面 + 卡片 + 画布外框的留白，画布才不会被工作区边框裁掉
    const available = win.windowWidth - STAGE_RESERVED_RPX * (win.windowWidth / 750)
    this.maxDisplay = {
      width: Math.floor(Math.min(available, 420)),
      height: Math.max(240, win.windowHeight * 0.52),
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

  /** 屏幕外的工作画布；万一取不到就退回可视画布，功能不至于不可用 */
  async ensureWorkCanvas(): Promise<CanvasHandles> {
    if (!this.workHandles) {
      try {
        this.workHandles = await getCanvasNode('#workCanvas')
      } catch (err) {
        console.warn('[lite-pic] 工作画布不可用，改用可视画布', err)
        return this.ensureCanvas()
      }
    }
    return this.workHandles
  },

  draw() {
    const handles = this.handles
    if (!this.image || !handles) return
    const { width, height } = this.canvasSize
    drawCropScene(handles.ctx, this.image, this.crop, width, height, true)
  },

  /* -------------------- 选择图片 -------------------- */

  /** 点击预览区域：未选图时直接进入选择 */
  onTapStage() {
    if (!this.data.hasImage) this.pickImage()
  },

  onRepick() {
    this.pickImage()
  },

  async pickImage() {
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
      this.workHandles = null
      await new Promise<void>((resolve) =>
        this.setData({ src: prepared.src, hasImage: true }, resolve)
      )

      const work = await this.ensureWorkCanvas()
      const { canvas } = await this.ensureCanvas()
      const { image: img } = await loadPrepared(work.canvas, prepared)
      this.image = img
      this.imgRatio = img.width / Math.max(1, img.height)

      const size = computeCanvasSize(img.width, img.height)
      canvas.width = size.width
      canvas.height = size.height
      this.canvasSize = { width: size.width, height: size.height }

      const ratio = img.height / Math.max(1, img.width)
      let w = this.maxDisplay.width
      let h = w * ratio
      if (h > this.maxDisplay.height) {
        h = this.maxDisplay.height
        w = h / ratio
      }
      this.setData({
        displayW: Math.round(w),
        displayH: Math.round(h),
        imageTip: describeImageSize(prepared),
      })

      // 保留之前选好的比例和框大小，只把画面位置复位
      const prev = this.crop
      this.crop = normalizeCropConfig(
        {
          ...createCropConfig(),
          ratio: prev.ratio,
          freeWidthPct: prev.freeWidthPct,
          freeHeightPct: prev.freeHeightPct,
        },
        size.width,
        size.height,
        this.imgRatio
      )
      this.setData({
        crop: this.crop,
        pct: toPct(this.crop),
        px: toPx(this.crop, size.width, size.height),
        scaleDisplay: this.crop.scale,
      })
      this.draw()
      hideLoading()
    } catch (err) {
      hideLoading()
      toastError(err, '照片打不开，换一张试试')
      this.handles = null
      this.image = null
      this.setData({ hasImage: false, src: '', imageTip: '' })
    } finally {
      this.setData({ working: false })
    }
  },

  /* -------------------- 配置变更 -------------------- */

  /** @param syncData 是否同步到视图层（拖动中传 false） */
  applyCrop(patch: Partial<CropConfig>, syncData = true) {
    const merged = { ...this.crop, ...patch }
    const { width, height } = this.canvasSize
    // 还没选照片时没有画布尺寸，这时不做归一化，否则会算出 NaN
    const next =
      width > 0 && height > 0 ? normalizeCropConfig(merged, width, height, this.imgRatio) : merged
    this.crop = next
    if (syncData) {
      this.setData({
        crop: next,
        pct: toPct(next),
        px: toPx(next, width, height),
        scaleDisplay: Math.round(next.scale * 100) / 100,
      })
    }
    this.draw()
  },

  /** 展开 / 收起更多设置 */
  onToggleMore() {
    this.setData({ moreOpen: !this.data.moreOpen })
  },

  onPickRatio(e: WechatMiniprogram.TouchEvent) {
    const ratio = e.currentTarget.dataset.key as CropRatio
    if (ratio === this.crop.ratio) return
    this.applyCrop({ ratio, offsetX: 0, offsetY: 0 })
  },

  patchFromSlider(field: string, value: number): Partial<CropConfig> {
    switch (field) {
      case 'scale':
        return { scale: value }
      case 'freeWidth':
        return { freeWidthPct: value / 100 }
      case 'freeHeight':
        return { freeHeightPct: value / 100 }
      default:
        return {}
    }
  },

  onSliderChanging(e: WechatMiniprogram.CustomEvent) {
    const field = e.currentTarget.dataset.field as string
    this.applyCrop(this.patchFromSlider(field, e.detail.value))
  },

  onSliderChange(e: WechatMiniprogram.CustomEvent) {
    const field = e.currentTarget.dataset.field as string
    this.applyCrop(this.patchFromSlider(field, e.detail.value))
  },

  onReset() {
    this.applyCrop({ offsetX: 0, offsetY: 0, scale: 1 })
  },

  /* -------------------- 手势 -------------------- */

  onTouchStart(e: WechatMiniprogram.TouchEvent) {
    if (!this.image) return
    const touches = e.touches as unknown as CanvasTouch[]
    const g = this.gesture
    g.active = true
    g.startOffsetX = this.crop.offsetX
    g.startOffsetY = this.crop.offsetY
    g.startScale = this.crop.scale
    if (touches.length >= 2) {
      g.startDistance = distanceOf(touches[0], touches[1])
    } else {
      g.startX = touches[0].x
      g.startY = touches[0].y
      g.startDistance = 0
    }
  },

  onTouchMove(e: WechatMiniprogram.TouchEvent) {
    if (!this.image || !this.gesture.active) return
    const touches = e.touches as unknown as CanvasTouch[]
    const { displayW, displayH } = this.data
    const g = this.gesture

    if (touches.length >= 2) {
      // 双指缩放
      const dist = distanceOf(touches[0], touches[1])
      if (g.startDistance > 0 && dist > 0) {
        const scale = clamp((g.startScale * dist) / g.startDistance, 1, 6)
        this.applyCrop({ scale }, false)
      }
      return
    }

    // 单指拖动：位移换算为相对画布的比例
    const dx = (touches[0].x - g.startX) / Math.max(1, displayW)
    const dy = (touches[0].y - g.startY) / Math.max(1, displayH)
    this.applyCrop(
      { offsetX: g.startOffsetX + dx, offsetY: g.startOffsetY + dy },
      false
    )
  },

  onTouchEnd() {
    if (!this.gesture.active) return
    this.gesture.active = false
    // 手势结束后把最终值同步给视图层
    this.setData({
      crop: this.crop,
      pct: toPct(this.crop),
      px: toPx(this.crop, this.canvasSize.width, this.canvasSize.height),
      scaleDisplay: Math.round(this.crop.scale * 100) / 100,
    })
  },

  /* -------------------- 导出 -------------------- */

  async onExport() {
    if (this.data.exporting) return
    if (!this.image || !this.handles) {
      toast('请先选择照片')
      return
    }
    try {
      this.setData({ exporting: true })
      showLoading('正在保存')
      // 用屏幕外的画布导出，可视画布保持不动，所以画面不会闪
      const work = await this.ensureWorkCanvas()
      const { width, height } = this.canvasSize
      const file = await exportCrop(work.canvas, work.ctx, this.image, this.crop, width, height)
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
    return { title: '图片裁剪 - 常用比例一键裁', path: '/pages/index/index' }
  },
})

/** 两指间距 */
function distanceOf(a: CanvasTouch, b: CanvasTouch): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}
