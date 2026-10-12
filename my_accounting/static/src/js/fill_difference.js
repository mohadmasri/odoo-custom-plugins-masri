/** @odoo-module **/

import { Component } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { standardWidgetProps } from "@web/views/widgets/standard_widget_props";

/**
 * زر "املأ الفرق بالقيد": ينقل فرق القيد غير المتوازن إلى البند الفارغ
 * الوحيد المتبقي. إن لم يوجد بند فارغ، أو وُجد أكثر من واحد، لا يعمل شيئاً
 * لأن الفرق حينها لا يخصّ بنداً بعينه.
 */
export class FillDifference extends Component {
    static template = "my_accounting.FillDifference";
    static props = { ...standardWidgetProps };

    get record() {
        return this.props.record;
    }

    /** بند بلا مبلغ: لا مدين ولا دائن، ولم يُكتب فيه صفر عمداً */
    get emptyLines() {
        return this.record.data.line_ids.records.filter((line) =>
            !line.data.debit && !line.data.credit &&
            !line.data.debit_zero_entered && !line.data.credit_zero_entered);
    }

    get difference() {
        return Math.round(
            (this.record.data.total_debit - this.record.data.total_credit) * 1000) / 1000;
    }

    get canFill() {
        return !this.record.data.is_balanced && this.emptyLines.length === 1;
    }

    get hint() {
        const count = this.emptyLines.length;
        if (!count) {
            return "لا يوجد بند فارغ ينتقل إليه الفرق.";
        }
        if (count > 1) {
            return `يوجد ${count} بنود فارغة، فلا يُعرف أيها يأخذ الفرق.`;
        }
        return "ينقل الفرق إلى البند الفارغ المتبقي.";
    }

    async fill() {
        if (!this.canFill) {
            return;
        }
        const line = this.emptyLines[0];
        const difference = this.difference;
        // الجانب الناقص هو الذي يأخذ الفرق
        await line.update(difference > 0 ? { credit: difference } : { debit: -difference });
    }
}

registry.category("view_widgets").add("my_accounting.fill_difference", {
    component: FillDifference,
});
