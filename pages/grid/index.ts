/**
 * 九宫格切图
 *
 * 画布分工（关键）：
 * - #previewCanvas：用户看得见的画布，只负责「预览」和「切图结果」两种画面；
 * - #workCanvas：屏幕外的工作画布，切图导出的绘制全在这里做。
 * 这样切图过程中用户可见的画布完全不动，不会出现画面闪烁。
 */
import {
  CanvasHandles,
  CanvasImage,
  CanvasTouch,
  MAX_CANVAS_SIDE,
  MAX_SOURCE_SIDE,
  MAX_TILE_SIDE,
  exportCanvas,
  getCanvasNode,
  loadImage,
  setCanvasSize,
} from '../../utils/canvas'
import { PreparedImage, chooseImage, prepareImage, saveAllToAlbum, saveToAlbum } from '../../utils/image'
import {
  GridLayout,
  computeGridLayout,
  drawFakeGrid,
  drawGridPreview,
  drawGridResult,
  hitResultCell,
  sliceGrid,
  validateGridSize,
} from '../../utils/grid'
import { hideLoading, showLoading, toast, toastError } from '../../utils/util'

/** 固定 3 × 3 九宫格切分 */
const GRID_SIZE = 3
/** 预览画布后备尺寸（固定值，保证手机上显示清晰，与导出尺寸解耦） */
const PREVIEW_SIDE = 1080
/** 选图前的说明（尽量说人话） */
const ADVICE = `选一张照片，自动切成 ${GRID_SIZE * GRID_SIZE} 张一样大的图，发朋友圈九宫格正好。照片太大时会自动缩小，不影响使用。`

Page({
  data: {
    src: '',
    hasImage: false,
    /** 画布显示边长（px） */
    displaySide: 300,
    /** 单张导出像素边长 */
    tileSide: 0,
    /** 选图后的实际尺寸说明 */
    imageTip: '',
    /** 切分结果说明 */
    sizeTip: '',
    advice: ADVICE,
    /** slice = 真的切成 9 张；fake = 假九宫，只加框线不切 */
    mode: 'slice' as 'slice' | 'fake',
    sliced: false,
    /** 显示切图结果还是原图预览 */
    showResult: false,
    /** 切图中 */
    slicing: false,
    /** 切图结果 */
    files: [] as string[],
    saving: false,
    working: false,
  },

  previewHandles: null as CanvasHandles | null,
  workHandles: null as CanvasHandles | null,
  image: null as CanvasImage | null,
  /** 当前切分布局 */
  layout: null as GridLayout | null,
  /** 原图预处理结果 */
  prepared: null as PreparedImage | null,

  onLoad() {
    const win = wx.getWindowInfo()
    const side = Math.floor(Math.min(win.windowWidth - win.windowWidth * 0.064, 420))
    this.setData({ displaySide: side })
  },

  /* -------------------- 画布 -------------------- */

  async ensurePreviewCanvas(): Promise<CanvasHandles> {
    if (!this.previewHandles) {
      this.previewHandles = await getCanvasNode('#previewCanvas')
    }
    return this.previewHandles
  },

  /** 屏幕外的工作画布；万一取不到就退回可视画布，功能不至于不可用 */
  async ensureWorkCanvas(): Promise<CanvasHandles> {
    if (!this.workHandles) {
      try {
        this.workHandles = await getCanvasNode('#workCanvas')
      } catch (err) {
        console.warn('[lite-pic] 工作画布不可用，改用可视画布', err)
        return this.ensurePreviewCanvas()
      }
    }
    return this.workHandles
  },

  /* -------------------- 选择图片 -------------------- */

  /** 点展示区：还没选照片就直接去选 */
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
      this.setData({ working: true, sliced: false, files: [], showResult: false })

      // 原图可能非常大（4000px 以上），先压到合适尺寸再交给 canvas
      const prepared = await prepareImage(path, MAX_SOURCE_SIDE)
      this.prepared = prepared

      // 画布由 wx:if 控制，重新选图时节点会重建，清掉缓存再查询；布局也要按新图重算
      this.previewHandles = null
      this.workHandles = null
      this.layout = null
      await new Promise<void>((resolve) =>
        this.setData({ src: prepared.src, hasImage: true }, resolve)
      )

      // 用工作画布创建图片对象，不受预览画布显示状态影响
      const work = await this.ensureWorkCanvas()
      const img = await loadImage(work.canvas, prepared.src)
      this.image = img
      await this.renderView()
      this.updateImageTip()
      hideLoading()
    } catch (err) {
      hideLoading()
      toastError(err, '照片打不开，换一张试试')
      this.previewHandles = null
      this.workHandles = null
      this.layout = null
      this.image = null
      this.prepared = null
      this.setData({ hasImage: false, src: '', imageTip: '', sizeTip: '' })
    } finally {
      this.setData({ working: false })
    }
  },

  /** 选图后的说明 */
  updateImageTip() {
    const prepared = this.prepared
    if (!prepared) return
    const imageTip = prepared.scaled
      ? `照片有点大，已自动缩小到 ${prepared.width}×${prepared.height} 再处理`
      : `照片 ${prepared.width}×${prepared.height}，可以直接处理`
    this.setData({ imageTip })
  },

  /* -------------------- 视图绘制 -------------------- */

  /** 把当前该显示的画面画到可视画布上：原图预览 / 切图结果 */
  async renderView(): Promise<void> {
    const img = this.image
    if (!img) return
    // 可视画布节点按需获取：图片加载走的是工作画布，两者互不影响
    const handles = await this.ensurePreviewCanvas()

    const layout =
      this.layout || computeGridLayout(img.width, img.height, GRID_SIZE, MAX_TILE_SIDE)
    this.layout = layout
    setCanvasSize(handles.canvas, handles.ctx, PREVIEW_SIDE, PREVIEW_SIDE)

    if (this.data.mode === 'fake') {
      // 假九宫：预览就带着框线（所见即所得）
      drawFakeGrid(handles.ctx, img, PREVIEW_SIDE, layout)
    } else if (this.data.showResult && this.data.sliced) {
      drawGridResult(handles.ctx, img, PREVIEW_SIDE, layout)
    } else {
      drawGridPreview(handles.ctx, img, PREVIEW_SIDE, layout)
    }

    const check = validateGridSize(GRID_SIZE, img.width, img.height)
    let sizeTip = check.message
    if (check.ok) {
      sizeTip =
        this.data.mode === 'fake'
          ? `保存 1 张带框线的照片，边长 ${Math.min(layout.used, MAX_CANVAS_SIDE)} 像素`
          : `会切成 ${GRID_SIZE * GRID_SIZE} 张，每张 ${layout.tileSide} × ${layout.tileSide} 像素`
    }
    if (this.data.tileSide !== layout.tileSide || this.data.sizeTip !== sizeTip) {
      this.setData({ tileSide: layout.tileSide, sizeTip })
    }
  },

  onShowPreview() {
    if (!this.data.showResult) return
    this.setData({ showResult: false })
    this.renderView()
  },

  onShowResult() {
    if (!this.data.sliced) {
      toast('先点下面按钮切图哦')
      return
    }
    if (this.data.showResult) return
    this.setData({ showResult: true })
    this.renderView()
  },

  /* -------------------- 模式 -------------------- */

  /** 切换「切成 9 张 / 假九宫」 */
  onSwitchMode(e: WechatMiniprogram.TouchEvent) {
    const mode = e.currentTarget.dataset.mode as 'slice' | 'fake'
    if (!mode || mode === this.data.mode) return
    this.setData({ mode, showResult: false })
    this.renderView()
  },

  /** 主按钮：切成 9 张 或 保存假九宫 */
  onPrimary() {
    if (this.data.mode === 'fake') {
      this.saveFakeGrid()
      return
    }
    this.onSlice()
  },

  /* -------------------- 切图 -------------------- */

  async onSlice() {
    if (this.data.working || this.data.slicing) return
    if (!this.image) {
      toast('请先选择照片')
      return
    }
    const check = validateGridSize(GRID_SIZE, this.image.width, this.image.height)
    if (!check.ok) {
      toast(check.message)
      return
    }
    try {
      this.setData({ slicing: true })
      showLoading('正在切图')
      // 让 loading 先显示出来再开始干活
      await new Promise<void>((resolve) => setTimeout(resolve, 50))

      const work = await this.ensureWorkCanvas()
      const layout =
        this.layout || computeGridLayout(this.image.width, this.image.height, GRID_SIZE, MAX_TILE_SIDE)
      // 全程在屏幕外的工作画布上切，可视画布不受影响，所以不会闪
      const result = await sliceGrid(work.canvas, work.ctx, this.image, { layout })

      hideLoading()
      this.setData({
        files: result.files,
        sliced: true,
        showResult: true,
        tileSide: result.tileSide,
        slicing: false,
      })
      this.renderView()
    } catch (err) {
      hideLoading()
      this.setData({ slicing: false })
      toastError(err, '切图失败，重试一下')
    }
  },

  /* -------------------- 假九宫 -------------------- */

  /** 假九宫：把框线画在照片上，导出成一整张图保存 */
  async saveFakeGrid() {
    if (this.data.working || this.data.saving) return
    const img = this.image
    if (!img) {
      toast('请先选择照片')
      return
    }
    const check = validateGridSize(GRID_SIZE, img.width, img.height)
    if (!check.ok) {
      toast(check.message)
      return
    }
    try {
      this.setData({ saving: true })
      showLoading('正在保存')
      const layout = computeGridLayout(img.width, img.height, GRID_SIZE, MAX_TILE_SIDE)
      const side = Math.min(layout.used, MAX_CANVAS_SIDE)
      const work = await this.ensureWorkCanvas()
      setCanvasSize(work.canvas, work.ctx, side, side)
      drawFakeGrid(work.ctx, img, side, layout)
      const file = await exportCanvas(work.canvas, {
        width: side,
        height: side,
        destWidth: side,
        destHeight: side,
      })
      await saveToAlbum(file)
      hideLoading()
      toast('已保存到相册', 'success')
    } catch (err) {
      hideLoading()
      toastError(err, '保存失败，重试一下')
    } finally {
      this.setData({ saving: false })
    }
  },

  /* -------------------- 结果交互 -------------------- */

  /** 长按某一格：只保存这一张（点击不做任何跳转，避免出现切图动画） */
  async onCanvasLongPress(e: WechatMiniprogram.TouchEvent) {
    const touches = e.touches as unknown as CanvasTouch[]
    const point = touches && touches[0]
    if (!point) return
    const index = this.resultCellIndexAt(point)
    if (index < 0) return
    const file = this.data.files[index]
    if (!file) return
    try {
      showLoading('正在保存')
      await saveToAlbum(file)
      hideLoading()
      toast('这一张已保存到相册', 'success')
    } catch (err) {
      hideLoading()
      toastError(err, '保存失败，重试一下')
    }
  },

  /** 结果视图里点位对应的第几格（显示坐标 → 结果下标），不在格子上返回 -1 */
  resultCellIndexAt(point: { x: number; y: number }): number {
    const layout = this.layout
    const side = this.data.displaySide
    if (!layout || !side || !this.data.sliced || !this.data.showResult) return -1
    const canvasPoint = {
      x: (point.x * PREVIEW_SIDE) / side,
      y: (point.y * PREVIEW_SIDE) / side,
    }
    return hitResultCell(PREVIEW_SIDE, layout, canvasPoint)
  },

  async onSaveAll() {
    if (this.data.saving) return
    if (!this.data.files.length) {
      toast('先点上面按钮切图哦')
      return
    }
    try {
      this.setData({ saving: true })
      showLoading(`正在保存 ${this.data.files.length} 张`)
      await saveAllToAlbum(this.data.files)
      hideLoading()
      toast('全部保存好了', 'success')
    } catch (err) {
      hideLoading()
      toastError(err, '保存失败，重试一下')
    } finally {
      this.setData({ saving: false })
    }
  },

  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent {
    return { title: '九宫格切图 - 一张图变九张', path: '/pages/index/index' }
  },
})
