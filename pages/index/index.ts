/** 首页：功能入口（长按卡片进入拖拽模式，顺序记在本地） */
import { clamp } from '../../utils/util'

interface FeatureItem {
  key: string
  title: string
  desc: string
  icon: string
  bg: string
  path: string
}

/** 视图里的卡片：在功能定义上加了位置样式与拖动状态 */
interface FeatureView extends FeatureItem {
  style: string
  dragging: boolean
}

/** 默认顺序：两个主打功能（九宫格、视觉 3D）放最前面，其余按原来的相对顺序 */
const FEATURES: FeatureItem[] = [
  {
    key: 'grid',
    title: '九宫格切图',
    desc: '一张图切成 9 张',
    icon: '▦',
    bg: '#e8f7ee',
    path: '/pages/grid/index',
  },
  {
    key: 'visual3d',
    title: '视觉 3D',
    desc: '让照片从网格里冒出来',
    icon: '▣',
    bg: '#eae7fd',
    path: '/pages/visual3d/index',
  },
  {
    key: 'watermark',
    title: '水印添加',
    desc: '给照片加字或图标',
    icon: '◨',
    bg: '#eaf1ff',
    path: '/pages/watermark/index',
  },
  {
    key: 'crop',
    title: '图片裁剪',
    desc: '按比例裁掉多余部分',
    icon: '⌗',
    bg: '#fff3e6',
    path: '/pages/crop/index',
  },
  {
    key: 'sticker',
    title: '贴纸',
    desc: '给照片加点表情',
    icon: '☺',
    bg: '#fdeaf3',
    path: '/pages/sticker/index',
  },
]

/** 卡片顺序存在本地，下次打开还是用户自己排的那个顺序 */
const ORDER_STORAGE_KEY = 'featureOrder'
/**
 * 顺序存档的版本号。
 * 默认顺序调整过就 +1：老存档直接作废，否则用户看到的还是旧顺序，改默认顺序等于没改。
 */
const ORDER_VERSION = 2

/*
 * 卡片几何：卡片用绝对定位 + transform 摆位（这样才能做换位动画），
 * 所以宽高间距都在这算好写进行内样式——WXSS 里的 .feature 只管外观。
 * PAGE_PADDING_RPX 必须与 index.wxss 的 .page padding 一致。
 */
const GRID_COLUMNS = 2
const PAGE_PADDING_RPX = 24
const GRID_GAP_RPX = 20
const CARD_HEIGHT_RPX = 208

/** 格子位置（相对 .grid 左上角，px） */
interface Slot {
  x: number
  y: number
}

Page({
  data: {
    features: [] as FeatureView[],
    gridHeight: 0,
    /** 拖拽模式：卡片可拖动、点击不跳转 */
    dragMode: false,
  },

  /** 当前顺序（权威数据，拖动时直接改它） */
  items: FEATURES.slice() as FeatureItem[],
  /** 几何尺寸（px） */
  geom: { cardW: 0, cardH: 0, gap: 0 },
  /**
   * 拖动状态。
   * startX/startY 是长按那一刻的手指位置（page 坐标），originX/originY 是卡片当时的格子位置，
   * 移动时用「手指位移」推卡片，长按瞬间不会跳。
   */
  drag: {
    active: false,
    index: -1,
    x: 0,
    y: 0,
    startX: 0,
    startY: 0,
    originX: 0,
    originY: 0,
  },

  onLoad() {
    const app = getApp<IAppOption>()
    app.globalData.lastPage = 'index'
    this.items = this.loadOrder()
    this.computeGeometry()
    this.syncView()
  },

  /* -------------------- 布局 -------------------- */

  computeGeometry() {
    const win = wx.getWindowInfo()
    const unit = win.windowWidth / 750
    const gap = GRID_GAP_RPX * unit
    const gridWidth = win.windowWidth - PAGE_PADDING_RPX * 2 * unit
    const cardW = (gridWidth - gap * (GRID_COLUMNS - 1)) / GRID_COLUMNS
    this.geom = { cardW, cardH: CARD_HEIGHT_RPX * unit, gap }
  },

  /** 第 index 个格子的位置 */
  slotAt(index: number): Slot {
    const col = index % GRID_COLUMNS
    const row = Math.floor(index / GRID_COLUMNS)
    return {
      x: col * (this.geom.cardW + this.geom.gap),
      y: row * (this.geom.cardH + this.geom.gap),
    }
  },

  /** 卡片行内样式；lifted 时缩小放大一点，看起来像被"拿起来" */
  cardStyle(x: number, y: number, lifted = false): string {
    return (
      'width:' + Math.round(this.geom.cardW) + 'px;' +
      'height:' + Math.round(this.geom.cardH) + 'px;' +
      'transform:translate3d(' + Math.round(x) + 'px,' + Math.round(y) + 'px,0)' +
      (lifted ? ' scale(1.05)' : '') +
      ';'
    )
  },

  buildViews(): FeatureView[] {
    const views: FeatureView[] = []
    for (let i = 0; i < this.items.length; i += 1) {
      const item = this.items[i]
      const dragging = this.drag.active && this.drag.index === i
      const slot = this.slotAt(i)
      views.push({
        ...item,
        style: this.cardStyle(dragging ? this.drag.x : slot.x, dragging ? this.drag.y : slot.y, dragging),
        dragging,
      })
    }
    return views
  },

  /** 把顺序与几何同步到视图 */
  syncView() {
    const rows = Math.ceil(this.items.length / GRID_COLUMNS)
    const { cardH, gap } = this.geom
    this.setData({
      features: this.buildViews(),
      gridHeight: Math.round(rows * cardH + (rows - 1) * gap),
    })
  },

  /* -------------------- 顺序存储 -------------------- */

  loadOrder(): FeatureItem[] {
    let saved: string[] = []
    try {
      const raw = wx.getStorageSync(ORDER_STORAGE_KEY)
      // 老版本存的是纯数组，没有版本号：默认顺序已经变过，直接作废用新默认
      if (raw && !Array.isArray(raw) && raw.version === ORDER_VERSION && Array.isArray(raw.keys)) {
        saved = raw.keys as string[]
      }
    } catch (err) {
      saved = []
    }
    const ordered: FeatureItem[] = []
    for (let i = 0; i < saved.length; i += 1) {
      const item = FEATURES.find((f) => f.key === saved[i])
      if (item && ordered.indexOf(item) < 0) ordered.push(item)
    }
    // 新增的功能不在旧顺序里，补到末尾
    for (let i = 0; i < FEATURES.length; i += 1) {
      if (ordered.indexOf(FEATURES[i]) < 0) ordered.push(FEATURES[i])
    }
    return ordered
  },

  saveOrder() {
    const keys: string[] = []
    for (let i = 0; i < this.items.length; i += 1) keys.push(this.items[i].key)
    try {
      wx.setStorageSync(ORDER_STORAGE_KEY, { version: ORDER_VERSION, keys })
    } catch (err) {
      // 存不上不影响这次使用
    }
  },

  /* -------------------- 拖拽排序 -------------------- */

  /**
   * 长按卡片 = 进入拖拽模式并"拿起"这张卡。
   * 注意：小程序里长按之后继续移动手指不会滚动页面（官方对 longpress 的说明），
   * 所以这里不需要 catchtouchmove；普通模式下页面照常滚动。
   */
  onLongPressCard(e: WechatMiniprogram.TouchEvent) {
    const index = Number(e.currentTarget.dataset.index)
    if (!(index >= 0)) return
    const slot = this.slotAt(index)
    const touch = e.touches && e.touches.length ? e.touches[0] : null
    this.drag = {
      active: true,
      index,
      x: slot.x,
      y: slot.y,
      startX: touch ? touch.pageX : 0,
      startY: touch ? touch.pageY : 0,
      originX: slot.x,
      originY: slot.y,
    }
    this.setData({ dragMode: true, features: this.buildViews() })
  },

  onCardTouchMove(e: WechatMiniprogram.TouchEvent) {
    if (!this.drag.active) return
    const touch = e.touches && e.touches.length ? e.touches[0] : null
    if (!touch) return

    const drag = this.drag
    drag.x = this.limitX(drag.originX + (touch.pageX - drag.startX))
    drag.y = this.limitY(drag.originY + (touch.pageY - drag.startY))

    const target = this.indexAt(drag.x + this.geom.cardW / 2, drag.y + this.geom.cardH / 2)
    if (target !== drag.index) {
      // 换位：把自己抽出来插到新位置，其余卡片会顺着 transition 滑过去
      const moved = this.items.splice(drag.index, 1)[0]
      this.items.splice(target, 0, moved)
      drag.index = target
      this.setData({ features: this.buildViews() })
      return
    }
    // 只是平移：只更新被拖的那一张，setData 尽量小
    this.setData({
      ['features[' + drag.index + '].style']: this.cardStyle(drag.x, drag.y, true),
    })
  },

  onCardTouchEnd() {
    if (!this.drag.active) return
    this.drag.active = false
    this.drag.index = -1
    // 松手落位：去掉"拖拽中"样式，卡片顺着 transition 滑回格子（仍留在拖拽模式）
    this.setData({ features: this.buildViews() })
    this.saveOrder()
  },

  /** 拖出格子范围就停住，别让手指把卡片带出屏幕 */
  limitX(x: number): number {
    return clamp(x, 0, (GRID_COLUMNS - 1) * (this.geom.cardW + this.geom.gap))
  },

  limitY(y: number): number {
    const rows = Math.ceil(this.items.length / GRID_COLUMNS)
    return clamp(y, 0, Math.max(0, rows - 1) * (this.geom.cardH + this.geom.gap))
  },

  /** 卡片中心落在哪个格子（取最近的格子中心） */
  indexAt(x: number, y: number): number {
    const { cardW, cardH, gap } = this.geom
    const rows = Math.ceil(this.items.length / GRID_COLUMNS)
    const col = clamp(Math.round((x - cardW / 2) / (cardW + gap)), 0, GRID_COLUMNS - 1)
    const row = clamp(Math.round((y - cardH / 2) / (cardH + gap)), 0, Math.max(0, rows - 1))
    const index = col + row * GRID_COLUMNS
    return index > this.items.length - 1 ? this.items.length - 1 : index
  },

  /** 退出拖拽模式 */
  onExitDrag() {
    this.drag.active = false
    this.drag.index = -1
    this.setData({ dragMode: false, features: this.buildViews() })
    this.saveOrder()
  },

  /* -------------------- 跳转 -------------------- */

  onTapFeature(e: WechatMiniprogram.TouchEvent) {
    // 拖拽模式下点击不跳转，免得排完顺序又误点进功能页
    if (this.data.dragMode) return
    const key = e.currentTarget.dataset.key as string
    const feature = FEATURES.find((f) => f.key === key)
    if (!feature) return
    wx.navigateTo({ url: feature.path })
  },

  onTapAbout() {
    wx.navigateTo({ url: '/pages/about/index' })
  },

  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent {
    return { title: '轻图九宫格 - 本地处理图片工具', path: '/pages/index/index' }
  },
})
