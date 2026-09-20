/** 通用滑块控件：标签 + 数值 + 滑块 */
Component({
  options: {
    styleIsolation: 'isolated',
  },

  properties: {
    label: { type: String, value: '' },
    value: { type: Number, value: 0 },
    min: { type: Number, value: 0 },
    max: { type: Number, value: 100 },
    step: { type: Number, value: 1 },
    unit: { type: String, value: '' },
    /** 数值展示的小数位 */
    precision: { type: Number, value: 0 },
    disabled: { type: Boolean, value: false },
  },

  data: {
    display: '0',
  },

  observers: {
    'value, precision': function (value: number, precision: number) {
      this.setData({ display: Number(value || 0).toFixed(precision || 0) })
    },
  },

  methods: {
    /** 拖动中：用于实时预览 */
    onChanging(e: WechatMiniprogram.CustomEvent) {
      this.triggerEvent('changing', { value: Number(e.detail.value) || 0 })
    },
    /** 拖动结束 */
    onChange(e: WechatMiniprogram.CustomEvent) {
      this.triggerEvent('change', { value: Number(e.detail.value) || 0 })
    },
  },
})
