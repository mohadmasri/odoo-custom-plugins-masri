/** @odoo-module **/

import { registry } from "@web/core/registry";
import { FloatField, floatField } from "@web/views/fields/float/float_field";
import { parseFloat } from "@web/views/fields/parsers";

/**
 * مبلغ مدين/دائن في بند القيد: الخانة التي لم يُدخل فيها شيء تبقى فارغة بدل "0.000"،
 * أما الصفر الذي يُكتب يدوياً فيُعرض (له معنى محاسبي آخر). التمييز عبر حقل منطقي
 * يُحدَّد في الخيار zero_flag (مثل debit_zero_entered).
 */
export class AmountField extends FloatField {
    static props = { ...FloatField.props, zeroFlag: { type: String, optional: true } };

    get zeroEntered() {
        return this.props.zeroFlag ? this.props.record.data[this.props.zeroFlag] : true;
    }

    get formattedValue() {
        if (!this.value && !this.zeroEntered) {
            return "";
        }
        return super.formattedValue;
    }

    // خانة الإدخال الأصلية تستدعي parse عند كل تغيير: نعرف منها الفرق بين "" و"0"
    parse(text) {
        const raw = (text || "").trim();
        const value = raw === "" ? 0 : parseFloat(raw, { allowOperation: true });
        const zeroEntered = raw !== "" && value === 0;
        if (this.props.zeroFlag && this.props.record.data[this.props.zeroFlag] !== zeroEntered) {
            this.props.record.update({ [this.props.zeroFlag]: zeroEntered });
        }
        return value;
    }
}

registry.category("fields").add("myaccounting_amount", {
    ...floatField,
    component: AmountField,
    extractProps: (fieldInfo, dynamicInfo) => ({
        ...floatField.extractProps(fieldInfo, dynamicInfo),
        zeroFlag: fieldInfo.options.zero_flag,
    }),
});
