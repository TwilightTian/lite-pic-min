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
    /**
     * 要显示成具体数值（如 "29px"）时由页面算好传进来，传了就盖掉按 value 算的数字。
     * 滑块本身仍按比例走，显示值取决于画布大小，所以只能页面侧算。
     */
    display: { type: String, value: '' },
  },

  data: {
    text: '0',
  },

  observers: {
    'value, precision, display': function (value: number, precision: number, display: string) {
      this.setData({ text: display || Number(value || 0).toFixed(precision || 0) })
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
