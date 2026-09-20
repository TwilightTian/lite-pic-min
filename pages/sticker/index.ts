/** 贴纸：emoji 贴纸库 + 拖动 / 双指缩放旋转 */
import {
  CanvasHandles,
  CanvasImage,
  CanvasTouch,
  MAX_CANVAS_SIDE,
  computeCanvasSize,
  exportCanvas,
  getCanvasNode,
  loadImage,
  setCanvasSize,
} from '../../utils/canvas'
import { chooseImage, prepareImage, saveToAlbum } from '../../utils/image'
import {
  BASE_STICKER_RATIO,
  STICKER_LIBRARY,
  createSticker,
  drawStickerScene,
  hitTestSticker,
} from '../../utils/sticker'
import { StickerItem } from '../../types/index'
import {
  angleOf,
  clamp,
  distanceOf,
  hideLoading,
  normalizeRotation,
  showLoading,
  toast,
  toastError,
} from '../../utils/util'

/** 选图前的说明（尽量说人话） */
const ADVICE = '选一张照片，点下面的表情就能加到照片上。照片太大时会自动缩小，不影响保存效果。'

const MIN_MULTIPLIER = 0.3
const MAX_MULTIPLIER = 3
const MAX_SCALE = BASE_STICKER_RATIO * MAX_MULTIPLIER
const MIN_SCALE = BASE_STICKER_RATIO * MIN_MULTIPLIER

Page({
  data: {
    src: '',
    hasImage: false,
    displayW: 300,
    displayH: 300,
    stickerGroups: STICKER_LIBRARY,
    groupIndex: 0,
    stickers: [] as StickerItem[],
    selectedId: '',
    stickerScale: 1,
    stickerRotation: 0,
    stickerOpacity: 100,
    imageTip: '',
    advice: ADVICE,
    exporting: false,
    working: false,
  },

  handles: null as CanvasHandles | null,
  /** 屏幕外的工作画布：导出在这里做，可视画布保持不动 */
  workHandles: null as CanvasHandles | null,
  image: null as CanvasImage | null,
  /** 权威贴纸数据（拖动过程中不写回 data） */
  stickers: [] as StickerItem[],
  canvasSize: { width: 0, height: 0 },
  maxDisplay: { width: 300, height: 360 },

  gesture: {
    mode: 'none' as 'none' | 'drag' | 'pinch',
    startX: 0,
    startY: 0,
    itemX: 0,
    itemY: 0,
    startDistance: 0,
    startAngle: 0,
    itemScale: 0,
    itemRotation: 0,
  },

  onLoad() {
    const win = wx.getWindowInfo()
    this.maxDisplay = {
      width: Math.min(win.windowWidth - win.windowWidth * 0.11, 420),
      height: Math.max(240, win.windowHeight * 0.48),
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
    drawStickerScene(handles.ctx, this.image, width, height, this.stickers, {
      selectedId: this.data.selectedId || undefined,
    })
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
      const img = await loadImage(work.canvas, prepared.src)
      this.image = img

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

      // 保留已加的贴纸，换照片后继续用
      this.setData({
        displayW: Math.round(w),
        displayH: Math.round(h),
        imageTip: prepared.scaled
          ? `照片有点大，已自动缩小到 ${prepared.width}×${prepared.height} 再处理`
          : `照片 ${prepared.width}×${prepared.height}，可以直接处理`,
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

  /* -------------------- 贴纸库 -------------------- */

  onSwitchGroup(e: WechatMiniprogram.TouchEvent) {
    this.setData({ groupIndex: Number(e.currentTarget.dataset.index || 0) })
  },

  onAddSticker(e: WechatMiniprogram.TouchEvent) {
    const emoji = e.currentTarget.dataset.emoji as string
    if (!emoji) return
    const item = createSticker('emoji', emoji)
    this.stickers.push(item)
    this.setData({ stickers: this.stickers.slice(), selectedId: item.id })
    this.syncSliderFromItem(item)
    this.draw()
    // 还没选照片时先记下来，选完照片就能看到
    if (!this.image) toast('选好照片就能看到贴纸')
  },

  /* -------------------- 选中与调整 -------------------- */

  findItem(id: string): StickerItem | undefined {
    return this.stickers.find((s) => s.id === id)
  },

  select(id: string) {
    if (id === this.data.selectedId && id !== '') return
    this.setData({ selectedId: id })
    const item = id ? this.findItem(id) : undefined
    if (item) this.syncSliderFromItem(item)
    this.draw()
  },

  syncSliderFromItem(item: StickerItem) {
    this.setData({
      stickerScale: Math.round((item.scale / BASE_STICKER_RATIO) * 10) / 10,
      stickerRotation: Math.round(item.rotation),
      stickerOpacity: Math.round(item.opacity * 100),
    })
  },

  onSliderChanging(e: WechatMiniprogram.CustomEvent) {
    this.applySlider(e.currentTarget.dataset.field as string, e.detail.value)
  },

  onSliderChange(e: WechatMiniprogram.CustomEvent) {
    this.applySlider(e.currentTarget.dataset.field as string, e.detail.value)
  },

  applySlider(field: string, value: number) {
    const item = this.findItem(this.data.selectedId)
    if (!item) return
    if (field === 'scale') {
      item.scale = clamp(BASE_STICKER_RATIO * value, MIN_SCALE, MAX_SCALE)
      this.setData({ stickerScale: value })
    } else if (field === 'rotation') {
      item.rotation = Math.round(value)
      this.setData({ stickerRotation: Math.round(value) })
    } else if (field === 'opacity') {
      item.opacity = clamp(value / 100, 0.1, 1)
      this.setData({ stickerOpacity: Math.round(value) })
    }
    this.draw()
  },

  onReorder(e: WechatMiniprogram.TouchEvent) {
    const action = e.currentTarget.dataset.action as 'top' | 'bottom' | 'delete'
    const id = this.data.selectedId
    const index = this.stickers.findIndex((s) => s.id === id)
    if (index < 0) return

    if (action === 'delete') {
      this.stickers.splice(index, 1)
      this.setData({ stickers: this.stickers.slice(), selectedId: '' })
      this.draw()
      return
    }

    const removed = this.stickers.splice(index, 1)
    const item = removed[0]
    if (!item) return
    if (action === 'top') this.stickers.push(item)
    else this.stickers.unshift(item)
    this.setData({ stickers: this.stickers.slice() })
    this.draw()
  },

  onClear() {
    if (!this.stickers.length) return
    this.stickers = []
    this.setData({ stickers: [], selectedId: '' })
    this.draw()
    toast('已清空贴纸')
  },

  /* -------------------- 手势 -------------------- */

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
    if (!this.image) return
    const touches = e.touches as unknown as CanvasTouch[]
    const g = this.gesture
    const selected = this.findItem(this.data.selectedId)

    if (touches.length >= 2 && selected) {
      g.mode = 'pinch'
      g.startDistance = distanceOf(touches[0], touches[1])
      g.startAngle = angleOf(touches[0], touches[1])
      g.itemScale = selected.scale
      g.itemRotation = selected.rotation
      return
    }

    // 单指：命中检测 + 选中
    const point = this.toCanvasPoint(touches[0])
    const hitId = hitTestSticker(this.stickers, point, this.canvasSize.width, this.canvasSize.height)
    this.select(hitId || '')

    const item = hitId ? this.findItem(hitId) : undefined
    if (item) {
      g.mode = 'drag'
      g.startX = touches[0].x
      g.startY = touches[0].y
      g.itemX = item.x
      g.itemY = item.y
    } else {
      g.mode = 'none'
    }
  },

  onTouchMove(e: WechatMiniprogram.TouchEvent) {
    if (!this.image) return
    const g = this.gesture
    const item = this.findItem(this.data.selectedId)
    if (!item) return
    const touches = e.touches as unknown as CanvasTouch[]
    const { displayW, displayH } = this.data

    if (g.mode === 'pinch' && touches.length >= 2) {
      const dist = distanceOf(touches[0], touches[1])
      const angle = angleOf(touches[0], touches[1])
      if (dist > 0 && g.startDistance > 0) {
        item.scale = clamp((g.itemScale * dist) / g.startDistance, MIN_SCALE, MAX_SCALE)
      }
      item.rotation = normalizeRotation(g.itemRotation + (angle - g.startAngle))
      this.draw()
      return
    }

    if (g.mode === 'drag' && touches.length === 1) {
      item.x = clamp(g.itemX + (touches[0].x - g.startX) / Math.max(1, displayW), 0, 1)
      item.y = clamp(g.itemY + (touches[0].y - g.startY) / Math.max(1, displayH), 0, 1)
      this.draw()
    }
  },

  onTouchEnd() {
    if (this.gesture.mode === 'none') return
    this.gesture.mode = 'none'
    // 手势结束，把最终数据同步回视图层
    const item = this.findItem(this.data.selectedId)
    if (item) this.syncSliderFromItem(item)
    this.setData({ stickers: this.stickers.slice() })
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
      // 用屏幕外的工作画布导出（不画选中框），可视画布保持不动，所以画面不会闪
      const work = await this.ensureWorkCanvas()
      const { width, height } = this.canvasSize
      setCanvasSize(work.canvas, work.ctx, width, height)
      drawStickerScene(work.ctx, this.image, width, height, this.stickers)
      const file = await exportCanvas(work.canvas, {
        width,
        height,
        destWidth: width,
        destHeight: height,
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
    return { title: '贴纸 - 给图片加点表情', path: '/pages/index/index' }
  },
})


