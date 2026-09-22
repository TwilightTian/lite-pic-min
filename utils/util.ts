/**
 * 通用小工具
 */

let seq = 0

/** 生成简单唯一 id */
export function uid(prefix = 'id'): string {
  seq += 1
  return `${prefix}_${Date.now().toString(36)}_${seq}`
}

/** 限制取值范围（NaN / Infinity 一律回落到 min，避免把脏数据扩散出去） */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/** 角度转弧度 */
export function toRadian(degree: number): number {
  return (degree * Math.PI) / 180
}

/** 旋转角度归一化到 -180 ~ 180 */
export function normalizeRotation(angle: number): number {
  let a = angle % 360
  if (a > 180) a -= 360
  if (a < -180) a += 360
  return Math.round(a)
}

/** 两指间距 */
export function distanceOf(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}

/** 两指连线角度（度） */
export function angleOf(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
}

/* ------------------------- 档位选项 ------------------------- */

/** 档位选项：key 是标识，ratio 是它对应的比例值；pages 层还会带 label 给用户看 */
export interface RatioOption {
  key: string
  ratio: number
}

/** 按下标取比例值（滑块就是按下标走的，越界夹到两端） */
export function optionRatioAt(options: RatioOption[], index: number): number {
  if (!options.length) return 0
  return options[clamp(Math.round(index), 0, options.length - 1)].ratio
}

/**
 * 比例值反查最接近的档位下标。
 * 手势能把值改成任意比例（比如双指缩放字号），这时滑块也要停在一个档位上，
 * 所以按「最接近」匹配，不要求完全相等。下标既给滑块定位，也用来取档位文字。
 */
export function nearestOptionIndex(options: RatioOption[], ratio: number): number {
  if (!options.length) return 0
  let best = 0
  let bestDiff = Infinity
  for (let i = 0; i < options.length; i += 1) {
    const diff = Math.abs(options[i].ratio - ratio)
    if (diff < bestDiff) {
      best = i
      bestDiff = diff
    }
  }
  return best
}

/* ------------------------- 提示 ------------------------- */

/** 三元组式提示 */
export function toast(title: string, icon: 'none' | 'success' | 'error' = 'none'): void {
  wx.showToast({ title, icon, duration: 1800 })
}

/** 错误提示（统一入口，便于以后接入更细致的错误码处理） */
export function toastError(err: unknown, fallback = '操作失败，请重试'): void {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  console.warn('[lite-pic]', err)
  let title = fallback
  if (msg) {
    if (/cancel/i.test(msg)) return // 用户主动取消，不提示
    title = msg
  }
  if (title.length > 14) title = `${title.slice(0, 13)}…`
  wx.showToast({ title, icon: 'none', duration: 2000 })
}

export function showLoading(title = '处理中'): void {
  wx.showLoading({ title, mask: true })
}

export function hideLoading(): void {
  wx.hideLoading()
}
