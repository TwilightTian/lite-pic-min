/**
 * 图片相关封装：选择图片、图片信息、保存到相册
 * 所有图片都只在本地处理，不上传服务器。
 */
import { CanvasImage, CanvasNode, loadImage } from './canvas'

export interface ImageInfo {
  path: string
  width: number
  height: number
  type: string
  orientation: string
}

/* ------------------------- 选图 ------------------------- */

export interface ChooseOptions {
  /**
   * 是否必须拿原图。
   * 透明素材（人像剪影、水印图）一定要传：微信的压缩图是 jpg，透明通道会丢。
   */
  needAlpha?: boolean
}

/**
 * 选择图片（相册 / 拍照）
 * @param count 最多选择张数
 * @param mediaType 媒体类型，默认只选图片
 * @param options needAlpha = 透明素材，强制原图
 */
export function chooseImage(
  count = 1,
  mediaType: Array<'image' | 'video'> = ['image'],
  options: ChooseOptions = {}
): Promise<string[]> {
  // 两个都传：微信选择器里会显示「原图」开关，由用户自己决定（默认不勾 = 拿压缩图，
  // 也就不会出现几十兆原图解码失败"打不开"的情况）。只传 ['compressed'] 会把那个开关藏起来。
  // 透明素材例外：必须原图，否则压缩成 jpg 会丢透明通道。
  const sizeType: Array<'original' | 'compressed'> =
    options.needAlpha === true ? ['original'] : ['original', 'compressed']
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count,
      mediaType,
      sourceType: ['album', 'camera'],
      sizeType,
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
  /** 首选路径（降采样后的临时文件；没降采样就是原图） */
  src: string
  /**
   * 原图路径。压缩产物在部分机型 / 开发者工具上会损坏
   * （getImageInfo 能读出尺寸，但 canvas 解不了），这时退回原图。
   */
  originalSrc: string
  /** wx.getImageInfo 给出的本地路径，再兜一层 */
  infoSrc: string
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

export interface PrepareOptions {
  /**
   * 是否允许用 wx.compressImage 降采样，默认 true。
   * 人像素材这类「透明背景 PNG」必须传 false：
   * compressImage 只支持 jpg，会把透明通道丢掉，剪影就变成一块白底。
   */
  compress?: boolean
}

/**
 * 原图预处理：把超大的原图降采样到可控尺寸。
 * 手机原图动辄 4000×3000 甚至更大，直接交给 canvas 会解码失败或内存溢出（表现为"图片打不开"）。
 * @param maxSide 允许的最长边
 */
export async function prepareImage(
  src: string,
  maxSide: number,
  options: PrepareOptions = {}
): Promise<PreparedImage> {
  const allowCompress = options.compress !== false
  let info: ImageInfo
  try {
    info = await getImageInfo(src)
  } catch (err) {
    // 读不到信息时按原图返回，后续载入还会再兜底
    console.warn('[lite-pic] getImageInfo 失败', err)
    return {
      src,
      originalSrc: src,
      infoSrc: '',
      width: 0,
      height: 0,
      scaled: false,
      originalWidth: 0,
      originalHeight: 0,
    }
  }

  const base = {
    originalSrc: src,
    infoSrc: info.path || '',
    originalWidth: info.width,
    originalHeight: info.height,
  }
  const longSide = Math.max(info.width, info.height)
  if (!allowCompress || !longSide || longSide <= maxSide) {
    return { src, width: info.width, height: info.height, scaled: false, ...base }
  }

  const ratio = maxSide / longSide
  const targetW = Math.max(1, Math.round(info.width * ratio))
  const targetH = Math.max(1, Math.round(info.height * ratio))
  try {
    const path = await compressTo(src, targetW, targetH)
    const info2 = await getImageInfo(path)
    return { src: path, width: info2.width, height: info2.height, scaled: true, ...base }
  } catch (err) {
    // 例如 PNG 不支持压缩：退回原图
    console.warn('[lite-pic] compressImage 失败，使用原图', err)
    return { src, width: info.width, height: info.height, scaled: false, ...base }
  }
}

/** 长边超过这个值就算"大得不合理"（约 3600 万像素以上），提示要说得更明确一些 */
export const HUGE_IMAGE_SIDE = 6000

/**
 * 选图后的尺寸说明。
 * 照片被缩小时必须把「原尺寸 → 处理尺寸」都告诉用户，
 * 否则他会以为保存出来还是原来那个尺寸（用户明确要求过）。
 */
export function describeImageSize(prepared: PreparedImage): string {
  if (!prepared.scaled) {
    return `照片 ${prepared.width}×${prepared.height}，可以直接处理`
  }
  const ow = prepared.originalWidth
  const oh = prepared.originalHeight
  if (Math.max(ow, oh) > HUGE_IMAGE_SIDE) {
    return `照片特别大（${ow}×${oh}），已自动缩小到 ${prepared.width}×${prepared.height} 再处理`
  }
  return `照片 ${ow}×${oh} 有点大，已自动缩小到 ${prepared.width}×${prepared.height} 再处理`
}

/**
 * 把预处理结果真正载入 canvas。
 * 压缩后的临时文件在部分机型 / 开发者工具上会损坏，
 * 所以按「压缩产物 → 原图 → getImageInfo 路径」依次尝试，能用哪个算哪个。
 */
export async function loadPrepared(
  canvas: CanvasNode,
  prepared: PreparedImage
): Promise<{ image: CanvasImage; src: string }> {
  const candidates = [prepared.src, prepared.originalSrc, prepared.infoSrc]
  const tried: string[] = []
  for (const candidate of candidates) {
    if (!candidate || tried.indexOf(candidate) >= 0) continue
    tried.push(candidate)
    try {
      return { image: await loadImage(canvas, candidate), src: candidate }
    } catch (err) {
      console.warn('[lite-pic] 该路径载入失败，换下一条', candidate.slice(-16), err)
    }
  }
  throw new Error('图片读取失败，换一张试试')
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
