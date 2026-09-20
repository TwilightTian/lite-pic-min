/** 首页：四个功能入口 */

interface FeatureItem {
  key: string
  title: string
  desc: string
  icon: string
  bg: string
  path: string
}

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

Page({
  data: {
    features: FEATURES,
  },

  onLoad() {
    const app = getApp<IAppOption>()
    app.globalData.lastPage = 'index'
  },

  onTapFeature(e: WechatMiniprogram.TouchEvent) {
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
