/**
 * 轻图工具箱 - 小程序入口
 * 纯本地处理，无后端、无登录、不上传图片。
 */
App<IAppOption>({
  globalData: {
    /** 最近一次进入的功能页，仅用于埋点/体验优化 */
    lastPage: '',
  },

  onLaunch() {
    // 打印一次运行环境，方便排查基础库问题
    const info = wx.getAppBaseInfo ? wx.getAppBaseInfo() : ({} as WechatMiniprogram.AppBaseInfo)
    console.log('[lite-pic] launch, SDKVersion =', (info as WechatMiniprogram.AppBaseInfo).SDKVersion)
  },

  onError(err: string) {
    console.error('[lite-pic] error:', err)
  },
})
