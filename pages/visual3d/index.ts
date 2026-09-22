/**
 * 视觉 3D：白底正方形 + 九宫格底图 + 人像图层
 * 对应手工教程的「朋友圈排九宫格 → 截图 → 抠人像 → 叠上去」，这里是 3 步：选底图 → 选人像 → 存相册
 */
import {
  CanvasHandles,
  CanvasImage,
  CanvasTouch,
  MAX_CANVAS_SIDE,
  STAGE_RESERVED_RPX,
  exportCanvas,
  getCanvasNode,
  setCanvasSize,
} from '../../utils/canvas'
import { chooseImage, loadPrepared, prepareImage, saveToAlbum } from '../../utils/image'
import {
  CELL_SOURCE_MAX,
  CORNER_OPTIONS,
  CanvasLayout,
  CornerStyle,
  GAP_OPTIONS,
  GRID_SIZE,
  GapSegment,
  GapStripId,
  GridMode,
  MAX_VIEW_SCALE,
  NINE_GRID_SIDE,
  NineGridLayout,
  OUTER_OPTIONS,
  PORTRAIT_MAX_H,
  PORTRAIT_MIN_H,
  TEXT_ALIGN_OPTIONS,
  TEXT_COLOR_OPTIONS,
  TEXT_SIZE_OPTIONS,
  TEXT_SIZE_RANGE,
  TextAlign,
  TextConfig,
  Visual3dConfig,
  computeCanvasLayout,
  computeNineGridLayout,
  createPortrait,
  createTextConfig,
  createVisual3dConfig,
  drawVisual3dScene,
  findNearestStrip,
  hitTestPortrait,
  measureTextArea,
  mergeSegment,
  normalizePortrait,
  normalizeVisual3dConfig,
  projectOnStrip,
  subtractSegment,
} from '../../utils/visual3d'
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

/** 九宫格格子数 */
const CELL_TOTAL = GRID_SIZE * GRID_SIZE

/** 选图前的说明（尽量说人话） */
const ADVICE =
  '先选底图（一张照片或 9 张图都行），再叠一张抠好的人像上去。人像会挡住白缝，看起来就像从九宫格里走出来的。'

Page({
  data: {
    /** 是否已选底图 */
    hasBg: false,
    /** 底图方式：single = 一张照片切成 9 格；nine = 9 张图各占一格 */
    gridMode: 'single' as GridMode,
    /** 画布显示尺寸（有顶部文字时高度会变） */
    displayW: 330,
    displayH: 330,
    /** 白缝 / 外白框：滑块按下标走，右侧显示档位文字（无 / 小 / 中 / 大） */
    gapIndex: 1,
    gapLabel: '小',
    outerIndex: 1,
    outerLabel: '小',
    gapOptions: GAP_OPTIONS,
    outerOptions: OUTER_OPTIONS,
    gridTip: '',
    hasPortrait: false,
    /** 人像大小滑块（%）与旋转滑块（度） */
    portraitScale: 90,
    portraitRotation: 0,
    /** 人像高度实际像素（0.9 × 1440，选人像后由 syncData 更新） */
    portraitPx: 1296,
    portraitMin: Math.round(PORTRAIT_MIN_H * 100),
    portraitMax: Math.round(PORTRAIT_MAX_H * 100),
    cellTotal: CELL_TOTAL,
    /** 下方设置面板的当前页：底图 / 人像 / 顶部文字（避免一屏到底还要来回滚） */
    tab: 'bg' as 'bg' | 'portrait' | 'text',
    /** 当前在干什么：摆人像 / 画穿透 */
    editMode: 'portrait' as 'portrait' | 'pen',
    /** 画穿透用什么：画笔加、橡皮擦减 */
    penTool: 'brush' as 'brush' | 'eraser',
    /** 已经画了几段「缝在人像前面」 */
    segmentCount: 0,
    /** 绘画放大倍率（显示用） */
    viewScale: 1,
    /** 格子圆角（默认直角，与 createVisual3dConfig 保持一致） */
    corner: 'square' as CornerStyle,
    cornerOptions: CORNER_OPTIONS,
    /** 顶部文字 */
    textEnabled: false,
    textValue: '',
    textColor: '#1f2328',
    /** 字号档位（小 / 标准 / 大） */
    textSizeIndex: 1,
    textSizeLabel: '标准',
    textSizeOptions: TEXT_SIZE_OPTIONS,
    textAlign: 'left' as TextAlign,
    textColors: TEXT_COLOR_OPTIONS,
    textAligns: TEXT_ALIGN_OPTIONS,
    advice: ADVICE,
    /** 是否展开「更多设置」 */
    moreOpen: false,
    exporting: false,
    working: false,
  },

  handles: null as CanvasHandles | null,
  /** 屏幕外的工作画布：导出与图片加载都在这里做，可视画布保持不动 */
  workHandles: null as CanvasHandles | null,
  /** 底图图片对象（1 张或最多 9 张） */
  cellImages: [] as CanvasImage[],
  /** 人像图片对象 */
  portraitImage: null as CanvasImage | null,
  /** 权威配置 */
  cfg: createVisual3dConfig(),
  maxDisplay: { width: 330, height: 420 },
  /** 画布整体布局（宽度固定，有顶部文字时高度变大） */
  canvasLayout: computeCanvasLayout(createVisual3dConfig()),
  /** 绘画放大视口：canvasPoint × scale + t = 画布像素 */
  view: { scale: 1, tx: 0, ty: 0 },
  /** 双指缩放/平移的起始状态（画穿透时两根手指用来放大） */
  viewGesture: {
    active: false,
    startDistance: 0,
    startScale: 1,
    anchorX: 0,
    anchorY: 0,
  },

  /** 画穿透的手势：钉在某一条白缝上拖 */
  penGesture: { active: false, strip: null as GapStripId | null, anchor: 0 },
  /** 正在拖、还没提交的那一段 */
  previewSegment: null as GapSegment | null,
  /** 撤销用的历史快照（存整份 segments） */
  segmentHistory: [] as GapSegment[][],
  /** 「对着白缝拖一下」只提示一次，别刷屏 */
  penHinted: false,

  /** 人像手势 */
  pGesture: {
    active: false,
    mode: 'none' as 'none' | 'move' | 'transform',
    startX: 0,
    startY: 0,
    startCx: 0.5,
    startCy: 0.5,
    startH: 0.9,
    startRotation: 0,
    startDistance: 0,
    startAngle: 0,
  },

  onLoad() {
    const win = wx.getWindowInfo()
    // 扣掉页面 + 卡片 + 画布外框的留白，画布才不会被工作区边框裁掉
    const available = win.windowWidth - STAGE_RESERVED_RPX * (win.windowWidth / 750)
    this.maxDisplay = {
      width: Math.floor(Math.min(available, 420)),
      height: Math.max(240, win.windowHeight * 0.5),
    }
    this.relayout()
  },

  /* -------------------- 画布 -------------------- */

  async ensureCanvas(): Promise<CanvasHandles> {
    if (!this.handles) {
      const handles = await getCanvasNode('#editCanvas')
      // 画布后备存储：宽 = 九宫格边长，高 = 加上顶部文字区
      const layout = this.canvasLayout
      handles.canvas.width = layout.width
      handles.canvas.height = layout.height
      this.handles = handles
    }
    return this.handles
  },

  /**
   * 重新计算画布布局与显示尺寸。
   * 顶部文字的开关 / 字号会改变画布高度，所以这些操作之后都要走一遍。
   */
  relayout() {
    const layout = computeCanvasLayout(this.cfg)
    this.canvasLayout = layout
    const ratio = layout.height / Math.max(1, layout.width)
    let w = this.maxDisplay.width
    let h = w * ratio
    if (h > this.maxDisplay.height) {
      h = this.maxDisplay.height
      w = h / ratio
    }
    // 尺寸没变就别重设（重设会清空画布，白白闪一下）
    if (this.handles) {
      const canvas = this.handles.canvas
      if (canvas.width !== layout.width) canvas.width = layout.width
      if (canvas.height !== layout.height) canvas.height = layout.height
    }
    this.setData({ displayW: Math.round(w), displayH: Math.round(h) })
    this.syncData()
    this.draw()
  },

  /** 屏幕外的工作画布（一直在页面上，随时可用） */
  async ensureWorkCanvas(): Promise<CanvasHandles> {
    if (!this.workHandles) {
      this.workHandles = await getCanvasNode('#workCanvas')
    }
    return this.workHandles
  },

  /**
   * 显示坐标 → 九宫格局部坐标（含视口反变换）。
   * 注意：顶部文字会让整块九宫格下移 textHeight，所以这里要把它扣掉，
   * 否则开了文字之后点哪都偏一截（命中判定和段落都会被画错位置）。
   */
  toCanvasPoint(touch: CanvasTouch): { x: number; y: number } {
    const raw = this.toCanvasRaw(touch)
    const view = this.view
    return {
      x: (raw.x - view.tx) / view.scale,
      y: (raw.y - view.ty) / view.scale - this.canvasLayout.textHeight,
    }
  },

  /** 显示坐标 → 画布像素（不含视口变换） */
  toCanvasRaw(touch: CanvasTouch): { x: number; y: number } {
    const { displayW, displayH } = this.data
    const { width, height } = this.canvasLayout
    return {
      x: touch.x * (width / Math.max(1, displayW)),
      y: touch.y * (height / Math.max(1, displayH)),
    }
  },

  draw() {
    const handles = this.handles
    if (!handles || !this.cellImages.length) return
    const penMode = this.data.editMode === 'pen'
    drawVisual3dScene(handles.ctx, NINE_GRID_SIDE, this.cfg, {
      cellImages: this.cellImages,
      portraitImage: this.portraitImage,
      overlay: true,
      portraitActive: !penMode,
      penMode,
      previewSegment: this.previewSegment,
      penTool: this.data.penTool,
      // 放大只在画穿透时生效（摆人像时用不到，也免得两套手势打架）
      view: penMode ? this.view : undefined,
    })
  },

  /**
   * 切换下方设置面板。
   * 顺序是「底图 → 人像 → 顶部文字」，没选底图时后两个先不给用
   * （不然会先配一堆参数，结果底图一选又得重调）。
   */
  onSwitchTab(e: WechatMiniprogram.TouchEvent) {
    const tab = e.currentTarget.dataset.tab as 'bg' | 'portrait' | 'text'
    if (tab === this.data.tab) return
    if (tab !== 'bg' && !this.data.hasBg) {
      toast('先选底图')
      return
    }
    this.setData({ tab })
  },

  /** 把配置同步到视图层 */
  syncData() {
    const cfg = this.cfg
    const portrait = cfg.portrait
    // 比例 → 档位下标（取最接近的一档，所以手势/别处改了比例也能对上滑块）
    const gapIndex = nearestOptionIndex(GAP_OPTIONS, cfg.gapRatio)
    const outerIndex = nearestOptionIndex(OUTER_OPTIONS, cfg.outerRatio)
    const textIndex = nearestOptionIndex(TEXT_SIZE_OPTIONS, cfg.text ? cfg.text.sizeRatio : 0.04)
    this.setData({
      gridMode: cfg.gridMode,
      gapIndex,
      gapLabel: GAP_OPTIONS[gapIndex].label,
      outerIndex,
      outerLabel: OUTER_OPTIONS[outerIndex].label,
      hasPortrait: !!portrait,
      portraitScale: portrait ? Math.round(portrait.h * 100) : 90,
      portraitRotation: portrait ? Math.round(portrait.rotation) : 0,
      portraitPx: Math.round((portrait ? portrait.h : 0.9) * NINE_GRID_SIDE),
      segmentCount: cfg.segments.length,
      corner: cfg.corner,
      viewScale: Math.round(this.view.scale * 10) / 10,
      textEnabled: !!cfg.text,
      textValue: cfg.text ? cfg.text.text : '',
      textColor: cfg.text ? cfg.text.color : '#1f2328',
      textSizeIndex: textIndex,
      textSizeLabel: TEXT_SIZE_OPTIONS[textIndex].label,
      textAlign: cfg.text ? cfg.text.align : 'left',
      gridTip: this.buildGridTip(),
    })
  },

  buildGridTip(): string {
    const count = this.cellImages.length
    if (!count) return ''
    if (this.cfg.gridMode === 'single') {
      return '这张照片已按九宫格切开，白缝是下面的白底透出来的。'
    }
    return count >= CELL_TOTAL
      ? `已选 ${count} 张，每格一张。`
      : `已选 ${count} 张，不够 9 张的部分循环使用了（选满 9 张更好看）。`
  },

  /* -------------------- 底图 -------------------- */

  /** 点展示区：还没选底图就直接去选 */
  onTapStage() {
    if (!this.data.hasBg) this.chooseBg()
  },

  /** 切换底图方式：保留已选图片，直接重绘 */
  onPickMode(e: WechatMiniprogram.TouchEvent) {
    const mode = e.currentTarget.dataset.mode as GridMode
    if (mode === this.cfg.gridMode) return
    this.cfg = normalizeVisual3dConfig({ ...this.cfg, gridMode: mode }, NINE_GRID_SIDE)
    this.syncData()
    this.draw()
    if (mode === 'nine' && this.cellImages.length < CELL_TOTAL) {
      toast(`九图模式需要 ${CELL_TOTAL} 张，点「重选底图」补上`)
    }
  },

  onChooseBg() {
    this.chooseBg()
  },

  async chooseBg() {
    if (this.data.working) return
    const count = this.cfg.gridMode === 'nine' ? CELL_TOTAL : 1
    try {
      const paths = await chooseImage(count)
      if (!paths.length) return
      // 底图要逐张压缩、解码，需要点时间，给个带进度的反馈
      showLoading(count > 1 ? '正在处理底图' : '正在处理照片')
      this.setData({ working: true })

      const work = await this.ensureWorkCanvas()
      const images: CanvasImage[] = []
      for (let i = 0; i < paths.length; i += 1) {
        if (paths.length > 1) {
          wx.showLoading({ title: `正在处理 ${i + 1}/${paths.length} 张`, mask: true })
        }
        // 单格只有 400 多像素，先降到 CELL_SOURCE_MAX，9 张也就几 MB，不会爆内存
        const prepared = await prepareImage(paths[i], CELL_SOURCE_MAX)
        images.push((await loadPrepared(work.canvas, prepared)).image)
      }

      this.cellImages = images
      // 首次选图时可见画布节点还没渲染：先 setData 再查询
      this.handles = null
      await new Promise<void>((resolve) => this.setData({ hasBg: true }, resolve))
      await this.ensureCanvas()
      // 画布尺寸与显示尺寸都按当前布局来（可能带顶部文字）
      this.relayout()
      hideLoading()
      if (count > 1 && images.length < CELL_TOTAL) {
        toast(`只选了 ${images.length} 张，已循环填满 ${CELL_TOTAL} 格`)
      }
    } catch (err) {
      hideLoading()
      toastError(err, '底图打不开，换几张试试')
    } finally {
      this.setData({ working: false })
    }
  },

  /* -------------------- 人像图层 -------------------- */

  /** 选择透明背景的人像素材 */
  async onChoosePortrait() {
    if (this.data.working) return
    if (!this.data.hasBg) {
      toast('先选底图')
      return
    }
    try {
      // 透明剪影必须拿原图：微信压缩图是 jpg，透明通道会变成白底
      const paths = await chooseImage(1, ['image'], { needAlpha: true })
      const path = paths[0]
      if (!path) return
      showLoading('正在载入人像')
      this.setData({ working: true })

      const work = await this.ensureWorkCanvas()
      // 关键：人像素材是透明 PNG，不能压缩（compressImage 只支持 jpg，会把透明通道丢掉）
      const prepared = await prepareImage(path, MAX_CANVAS_SIDE, { compress: false })
      const { image: img } = await loadPrepared(work.canvas, prepared)
      this.portraitImage = img

      this.cfg = normalizeVisual3dConfig(
        { ...this.cfg, portrait: createPortrait(prepared.src) },
        NINE_GRID_SIDE
      )
      this.setData({ editMode: 'portrait', tab: 'portrait' })
      this.syncData()
      this.draw()
      hideLoading()
      toast('已加上人像，拖动可以调位置')
    } catch (err) {
      hideLoading()
      toastError(err, '人像图没打开，换一张试试')
    } finally {
      this.setData({ working: false })
    }
  },

  onRemovePortrait() {
    this.cfg = { ...this.cfg, portrait: null }
    this.portraitImage = null
    this.setData({ editMode: 'portrait' })
    this.syncData()
    this.draw()
  },

  onResetPortrait() {
    const portrait = this.cfg.portrait
    if (!portrait) return
    this.cfg = {
      ...this.cfg,
      portrait: normalizePortrait(
        { ...portrait, cx: 0.5, cy: 0.5, h: 0.9, rotation: 0 },
        NINE_GRID_SIDE
      ),
    }
    this.syncData()
    this.draw()
  },

  applyPortrait(patch: Partial<{ h: number; rotation: number }>) {
    const portrait = this.cfg.portrait
    if (!portrait) return
    this.cfg = {
      ...this.cfg,
      portrait: normalizePortrait({ ...portrait, ...patch }, NINE_GRID_SIDE),
    }
    this.syncData()
    this.draw()
  },

  onPortraitScaleChanging(e: WechatMiniprogram.CustomEvent) {
    this.applyPortrait({ h: e.detail.value / 100 })
  },

  onPortraitScaleChange(e: WechatMiniprogram.CustomEvent) {
    this.applyPortrait({ h: e.detail.value / 100 })
  },

  onPortraitRotationChanging(e: WechatMiniprogram.CustomEvent) {
    this.applyPortrait({ rotation: e.detail.value })
  },

  onPortraitRotationChange(e: WechatMiniprogram.CustomEvent) {
    this.applyPortrait({ rotation: e.detail.value })
  },

  /* -------------------- 手势：只用于摆人像 -------------------- */

  onTouchStart(e: WechatMiniprogram.TouchEvent) {
    const touches = e.touches as unknown as CanvasTouch[]
    if (!this.data.hasBg || !touches || !touches.length) return
    // 画穿透：单指画（画笔 / 橡皮擦），双指放大平移（小图上才能画准）
    if (this.data.editMode === 'pen') {
      if (touches.length >= 2) {
        this.beginViewGesture(touches)
        return
      }
      this.beginPenGesture(this.toCanvasPoint(touches[0]))
      return
    }
    const portrait = this.cfg.portrait
    const img = this.portraitImage
    if (!portrait || !img) return
    // 两指直接开始缩放旋转；单指必须按在人像身上
    if (touches.length < 2) {
      const point = this.toCanvasPoint(touches[0])
      if (!hitTestPortrait(portrait, NINE_GRID_SIDE, img.width, img.height, point)) return
    }
    this.beginPortraitGesture(touches)
  },

  /** 当前布局（白缝位置随缝宽 / 白框变化） */
  layout(): NineGridLayout {
    return computeNineGridLayout(NINE_GRID_SIDE, this.cfg.gapRatio, this.cfg.outerRatio)
  },

  /** 白缝容差：缝宽两倍与画布边长 3% 取大者，手指才好点中 */
  stripTolerance(layout: NineGridLayout): number {
    return Math.max(layout.gap * 2, NINE_GRID_SIDE * 0.03)
  },

  beginPenGesture(point: { x: number; y: number }) {
    const layout = this.layout()
    const hit = findNearestStrip(layout, point, this.stripTolerance(layout))
    const g = this.penGesture
    g.active = false
    g.strip = null
    if (!hit) {
      if (!this.penHinted) {
        this.penHinted = true
        toast('对着白缝拖一下')
      }
      return
    }
    g.active = true
    g.strip = hit.id
    g.anchor = hit.position
    this.previewSegment = { strip: hit.id, from: hit.position, to: hit.position }
  },

  movePenGesture(point: { x: number; y: number }) {
    const g = this.penGesture
    if (!g.active || !g.strip) return
    const position = projectOnStrip(this.layout(), g.strip, point)
    this.previewSegment = {
      strip: g.strip,
      from: Math.min(g.anchor, position),
      to: Math.max(g.anchor, position),
    }
    this.draw()
  },

  endPenGesture() {
    const g = this.penGesture
    const segment = this.previewSegment
    g.active = false
    g.strip = null
    this.previewSegment = null
    if (!segment) return
    // 点一下没拖动就不记，免得攒一堆看不见的段
    const layout = this.layout()
    const minLength = Math.max(layout.gap * 1.5, NINE_GRID_SIDE * 0.01)
    if (segment.to - segment.from < minLength) {
      this.draw()
      return
    }
    this.pushHistory()
    // 画笔 = 让这段缝穿到人像前面；橡皮擦 = 把擦到的部分扣掉
    const eraser = this.data.penTool === 'eraser'
    this.cfg = {
      ...this.cfg,
      segments: eraser
        ? subtractSegment(this.cfg.segments, segment)
        : mergeSegment(this.cfg.segments, segment),
    }
    this.syncData()
    this.draw()
  },

  /* -------------------- 放大视口（画穿透时用） -------------------- */

  beginViewGesture(touches: CanvasTouch[]) {
    const p0 = this.toCanvasRaw(touches[0])
    const p1 = this.toCanvasRaw(touches[1])
    const centerX = (p0.x + p1.x) / 2
    const centerY = (p0.y + p1.y) / 2
    const view = this.view
    const g = this.viewGesture
    g.active = true
    g.startDistance = distanceOf(p0, p1)
    g.startScale = view.scale
    // 记住捏合中心对应的「画布坐标」，缩放时让它原地不动
    g.anchorX = (centerX - view.tx) / view.scale
    g.anchorY = (centerY - view.ty) / view.scale
  },

  moveViewGesture(touches: CanvasTouch[]) {
    const g = this.viewGesture
    if (!g.active) return
    const p0 = this.toCanvasRaw(touches[0])
    const p1 = this.toCanvasRaw(touches[1])
    const centerX = (p0.x + p1.x) / 2
    const centerY = (p0.y + p1.y) / 2
    const distance = distanceOf(p0, p1)
    const scale =
      g.startDistance > 1
        ? clamp(g.startScale * (distance / g.startDistance), 1, MAX_VIEW_SCALE)
        : g.startScale
    this.view = {
      scale,
      tx: centerX - g.anchorX * scale,
      ty: centerY - g.anchorY * scale,
    }
    this.clampView()
    this.setData({ viewScale: Math.round(this.view.scale * 10) / 10 })
    this.draw()
  },

  /** 限制平移：画布必须始终铺满显示区，不能被拖出空白 */
  clampView() {
    const { width, height } = this.canvasLayout
    const scale = this.view.scale
    this.view = {
      scale,
      tx: clamp(this.view.tx, width - width * scale, 0),
      ty: clamp(this.view.ty, height - height * scale, 0),
    }
  },

  onResetView() {
    this.view = { scale: 1, tx: 0, ty: 0 }
    this.setData({ viewScale: 1 })
    this.draw()
  },

  /** 记一份快照，用于撤销 */
  pushHistory() {
    this.segmentHistory.push(this.cfg.segments.map((item) => ({ ...item })))
    if (this.segmentHistory.length > 30) this.segmentHistory.shift()
  },

  /** 切换「摆人像 / 画穿透」 */
  onSwitchMode(e: WechatMiniprogram.TouchEvent) {
    const mode = e.currentTarget.dataset.mode as 'portrait' | 'pen'
    if (mode === this.data.editMode) return
    if (mode !== 'pen' && this.view.scale !== 1) {
      // 离开画穿透时把放大复位，否则人像手势的位置会对不上
      this.view = { scale: 1, tx: 0, ty: 0 }
    }
    this.setData({ editMode: mode, viewScale: Math.round(this.view.scale * 10) / 10 })
    this.draw()
  },

  onUndoPen() {
    const previous = this.segmentHistory.pop()
    if (!previous) {
      toast('没有可撤销的')
      return
    }
    this.cfg = { ...this.cfg, segments: previous }
    this.syncData()
    this.draw()
  },

  onClearPen() {
    if (!this.cfg.segments.length) return
    this.pushHistory()
    this.cfg = { ...this.cfg, segments: [] }
    this.syncData()
    this.draw()
  },

  beginPortraitGesture(touches: CanvasTouch[]) {
    const portrait = this.cfg.portrait
    if (!portrait) return
    const g = this.pGesture
    const point = this.toCanvasPoint(touches[0])
    g.active = true
    g.startX = point.x
    g.startY = point.y
    g.startCx = portrait.cx
    g.startCy = portrait.cy
    g.startH = portrait.h
    g.startRotation = portrait.rotation
    if (touches.length >= 2) {
      const p1 = this.toCanvasPoint(touches[1])
      g.mode = 'transform'
      g.startDistance = distanceOf(point, p1)
      g.startAngle = angleOf(point, p1)
    } else {
      g.mode = 'move'
      g.startDistance = 0
      g.startAngle = 0
    }
  },

  onTouchMove(e: WechatMiniprogram.TouchEvent) {
    const touches = e.touches as unknown as CanvasTouch[]
    if (!touches || !touches.length) return
    if (this.viewGesture.active) {
      if (touches.length >= 2) this.moveViewGesture(touches)
      return
    }
    if (this.penGesture.active) {
      this.movePenGesture(this.toCanvasPoint(touches[0]))
      return
    }
    if (!this.pGesture.active) return
    const portrait = this.cfg.portrait
    if (!portrait) return
    const g = this.pGesture
    const p0 = this.toCanvasPoint(touches[0])

    if (touches.length >= 2) {
      const p1 = this.toCanvasPoint(touches[1])
      const distance = distanceOf(p0, p1)
      const angle = angleOf(p0, p1)
      if (g.mode !== 'transform') {
        // 中途多了一根手指：以当前状态为新基准，避免画面跳变
        g.mode = 'transform'
        g.startDistance = distance
        g.startAngle = angle
        g.startH = portrait.h
        g.startRotation = portrait.rotation
      } else {
        const scale = g.startDistance > 1 ? distance / g.startDistance : 1
        this.cfg = {
          ...this.cfg,
          portrait: normalizePortrait(
            {
              ...portrait,
              h: g.startH * scale,
              rotation: normalizeRotation(g.startRotation + (angle - g.startAngle)),
            },
            NINE_GRID_SIDE
          ),
        }
      }
    } else if (g.mode === 'move') {
      this.cfg = {
        ...this.cfg,
        portrait: normalizePortrait(
          {
            ...portrait,
            cx: g.startCx + (p0.x - g.startX) / NINE_GRID_SIDE,
            cy: g.startCy + (p0.y - g.startY) / NINE_GRID_SIDE,
          },
          NINE_GRID_SIDE
        ),
      }
    } else {
      return
    }
    this.draw()
  },

  onTouchEnd() {
    if (this.viewGesture.active) {
      this.viewGesture.active = false
      return
    }
    if (this.penGesture.active || this.previewSegment) {
      this.endPenGesture()
      return
    }
    if (!this.pGesture.active) return
    this.pGesture.active = false
    this.pGesture.mode = 'none'
    this.syncData()
  },

  /* -------------------- 效果设置 -------------------- */

  /** 展开 / 收起更多设置 */
  onToggleMore() {
    this.setData({ moreOpen: !this.data.moreOpen })
  },

  applyConfig(patch: Partial<Visual3dConfig>) {
    this.cfg = normalizeVisual3dConfig({ ...this.cfg, ...patch }, NINE_GRID_SIDE)
    this.syncData()
    this.draw()
  },

  /** 格子间距滑块：滑块值是档位下标（右侧显示无 / 小 / 中 / 大） */
  onGapChanging(e: WechatMiniprogram.CustomEvent) {
    this.applyConfig({ gapRatio: optionRatioAt(GAP_OPTIONS, e.detail.value) })
  },

  onGapChange(e: WechatMiniprogram.CustomEvent) {
    this.applyConfig({ gapRatio: optionRatioAt(GAP_OPTIONS, e.detail.value) })
  },

  /** 外白框滑块 */
  onOuterChanging(e: WechatMiniprogram.CustomEvent) {
    this.applyConfig({ outerRatio: optionRatioAt(OUTER_OPTIONS, e.detail.value) })
  },

  onOuterChange(e: WechatMiniprogram.CustomEvent) {
    this.applyConfig({ outerRatio: optionRatioAt(OUTER_OPTIONS, e.detail.value) })
  },

  /** 圆角 / 直角 */
  onPickCorner(e: WechatMiniprogram.TouchEvent) {
    this.applyConfig({ corner: e.currentTarget.dataset.key as CornerStyle })
  },

  /** 画笔 / 橡皮擦 */
  onPickPenTool(e: WechatMiniprogram.TouchEvent) {
    this.setData({ penTool: e.currentTarget.dataset.tool as 'brush' | 'eraser' })
  },

  /* -------------------- 顶部文字 -------------------- */

  onToggleText(e: WechatMiniprogram.CustomEvent) {
    if (e.detail.value) {
      this.cfg = normalizeVisual3dConfig(
        { ...this.cfg, text: this.cfg.text || createTextConfig() },
        NINE_GRID_SIDE
      )
    } else {
      this.cfg = { ...this.cfg, text: null }
    }
    this.relayout()
  },

  /**
   * 改文字配置
   * @param relayout 字号会改变画布高度，需要重算布局（只改颜色 / 对齐时不用）
   */
  applyText(patch: Partial<TextConfig>, relayout = false) {
    const current = this.cfg.text || createTextConfig()
    this.cfg = normalizeVisual3dConfig(
      { ...this.cfg, text: { ...current, ...patch } },
      NINE_GRID_SIDE
    )
    // 文字区高度由「有没有内容 + 字号」一起决定：从空到有内容也会让画布变高。
    // 不重算的话画布还是旧高度，九宫格会被底边截掉（预览和保存出来的图都缺一块）。
    const heightChanged = measureTextArea(NINE_GRID_SIDE, this.cfg.text) !== this.canvasLayout.textHeight
    if (relayout || heightChanged) {
      this.relayout()
      return
    }
    this.syncData()
    this.draw()
  },

  onTextInput(e: WechatMiniprogram.CustomEvent) {
    this.applyText({ text: String(e.detail.value || '') })
  },

  onPickTextColor(e: WechatMiniprogram.TouchEvent) {
    this.applyText({ color: e.currentTarget.dataset.color as string })
  },

  onPickTextAlign(e: WechatMiniprogram.TouchEvent) {
    this.applyText({ align: e.currentTarget.dataset.key as TextAlign })
  },

  /** 字号滑块：小 / 标准 / 大（字号会改变画布高度，要重算布局） */
  onTextSizeChanging(e: WechatMiniprogram.CustomEvent) {
    this.applyText({ sizeRatio: optionRatioAt(TEXT_SIZE_OPTIONS, e.detail.value) }, true)
  },

  onTextSizeChange(e: WechatMiniprogram.CustomEvent) {
    this.applyText({ sizeRatio: optionRatioAt(TEXT_SIZE_OPTIONS, e.detail.value) }, true)
  },

  /* -------------------- 导出 -------------------- */

  async onExport() {
    if (this.data.exporting) return
    if (!this.data.hasBg || !this.cellImages.length) {
      toast('请先选底图')
      return
    }
    try {
      this.setData({ exporting: true })
      showLoading('正在保存')
      // 用屏幕外的工作画布导出（不画选框），可视画布保持不动，画面不会闪
      const work = await this.ensureWorkCanvas()
      const { width, height } = this.canvasLayout
      setCanvasSize(work.canvas, work.ctx, width, height)
      drawVisual3dScene(work.ctx, NINE_GRID_SIDE, this.cfg, {
        cellImages: this.cellImages,
        portraitImage: this.portraitImage,
      })
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
    return { title: '视觉 3D - 让人像从九宫格里走出来', path: '/pages/index/index' }
  },
})
