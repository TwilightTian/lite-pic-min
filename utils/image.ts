/**
 * 图片相关封装：选择图片、图片信息、保存到相册
 * 所有图片都只在本地处理，不上传服务器。
 */

export interface ImageInfo {
  path: string
  width: number
  height: number
  type: string
  orientation: string
}

/**
 * 选择图片（相册 / 拍照）
 * @param count 最多选择张数
 * @param mediaType 媒体类型，默认只选图片
 */
export function chooseImage(
  count = 1,
  mediaType: Array<'image' | 'video'> = ['image']
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count,
      mediaType,
      sourceType: ['album', 'camera'],
      // 固定取原图：交给 prepareImage 按需降采样，避免微信压缩后分辨率过低
      sizeType: ['original'],
      success: (res) => {
        const files = res.tempFiles || []
        const paths = files.map((f) => f.tempFilePath).filter(Boolean)
        paths.length ? resolve(paths) : reject(new Error('未选择图片'))
      },
      fail: (err) => reject(new Error(err.errMsg || '选择图片失败')),
    })
  })
}

/** 获取图片宽高信息 */
export function getImageInfo(src: string): Promise<ImageInfo> {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({
      src,
      success: (res) =>
        resolve({
          path: res.path,
          width: res.width,
          height: res.height,
          type: res.type,
          orientation: res.orientation,
        }),
      fail: (err) => reject(new Error(err.errMsg || '读取图片失败')),
    })
  })
}

/** 是否属于相册授权被拒绝的错误 */
export function isAuthDenied(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err || '')).toLowerCase()
  return msg.includes('auth deny') || msg.includes('authorize') || msg.includes('auth denied')
}

/* ------------------------- 原图预处理 ------------------------- */

export interface PreparedImage {
  /** 可用于 canvas 加载的路径 */
  src: string
  /** 实际参与处理的尺寸 */
  width: number
  height: number
  /** 是否做过降采样 */
  scaled: boolean
  /** 原图尺寸（用于提示用户） */
  originalWidth: number
  originalHeight: number
}

/** 用 wx.compressImage 按目标尺寸降采样（要求基础库 2.26.0+，仅支持 jpg） */
function compressTo(src: string, width: number, height: number): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.compressImage({
      src,
      quality: 92,
      compressedWidth: width,
      compressedHeight: height,
      success: (res) => resolve(res.tempFilePath),
      fail: (err) => reject(new Error(err.errMsg || '图片压缩失败')),
    })
  })
}

/**
 * 原图预处理：把超大的原图降采样到可控尺寸。
 * 手机原图动辄 4000×3000 甚至更大，直接交给 canvas 会解码失败或内存溢出（表现为"图片打不开"）。
 * @param maxSide 允许的最长边
 */
export async function prepareImage(src: string, maxSide: number): Promise<PreparedImage> {
  let info: ImageInfo
  try {
    info = await getImageInfo(src)
  } catch (err) {
    // 读不到信息时按原图返回，后续 loadImage 还会再兜底一次
    console.warn('[lite-pic] getImageInfo 失败', err)
    return { src, width: 0, height: 0, scaled: false, originalWidth: 0, originalHeight: 0 }
  }

  const base = {
    originalWidth: info.width,
    originalHeight: info.height,
  }
  const longSide = Math.max(info.width, info.height)
  if (!longSide || longSide <= maxSide) {
    return { src: info.path || src, width: info.width, height: info.height, scaled: false, ...base }
  }

  const ratio = maxSide / longSide
  const targetW = Math.max(1, Math.round(info.width * ratio))
  const targetH = Math.max(1, Math.round(info.height * ratio))
  try {
    const path = await compressTo(src, targetW, targetH)
    const info2 = await getImageInfo(path)
    return { src: path, width: info2.width, height: info2.height, scaled: true, ...base }
  } catch (err) {
    // 例如 PNG 不支持压缩：退回原图，由调用方按实际能力处理
    console.warn('[lite-pic] compressImage 失败，使用原图', err)
    return { src: info.path || src, width: info.width, height: info.height, scaled: false, ...base }
  }
}

/* ------------------------- 相册权限 ------------------------- */

/**
 * 保存图片到相册
 * 授权被拒绝时引导用户前往设置页重新开启权限，开启后可重试一次。
 */
export function saveToAlbum(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    wx.saveImageToPhotosAlbum({
      filePath,
      success: () => resolve(),
      fail: (err) => {
        if (isAuthDenied(err)) {
          wx.showModal({
            title: '需要相册权限',
            content: '保存图片需要访问你的相册，请在设置中开启「保存到相册」后重试。',
            confirmText: '去设置',
            cancelText: '取消',
            success: (modal) => {
              if (!modal.confirm) {
                reject(new Error('未获得相册权限'))
                return
              }
              wx.openSetting({
                success: (setting) => {
                  if (setting.authSetting['scope.writePhotosAlbum']) {
                    // 已授权，重试一次
                    wx.saveImageToPhotosAlbum({
                      filePath,
                      success: () => resolve(),
                      fail: (e2) => reject(new Error(e2.errMsg || '保存失败')),
                    })
                  } else {
                    reject(new Error('未获得相册权限'))
                  }
                },
                fail: () => reject(new Error('打开设置失败')),
              })
            },
          })
          return
        }
        reject(new Error(err.errMsg || '保存失败'))
      },
    })
  })
}

/** 依次保存多张图片到相册，返回成功张数 */
export async function saveAllToAlbum(paths: string[]): Promise<number> {
  let ok = 0
  for (let i = 0; i < paths.length; i += 1) {
    await saveToAlbum(paths[i])
    ok += 1
  }
  return ok
}
