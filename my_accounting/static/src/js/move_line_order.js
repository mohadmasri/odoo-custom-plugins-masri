/** @odoo-module **/

import { Component } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { standardFieldProps } from "@web/views/fields/standard_field_props";
import { useService } from "@web/core/utils/hooks";

/**
 * سهمان صغيران بجانب كل بند لتحريكه لأعلى أو لأسفل داخل القيد،
 * بديلاً عن السحب والإفلات. يعملان على البنود المحفوظة والجديدة معاً،
 * ويُحفظ الترتيب الجديد عند حفظ القيد.
 */
export class MoveLineOrder extends Component {
    static template = "my_accounting.MoveLineOrder";
    static props = { ...standardFieldProps };

    setup() {
        this.orm = useService("orm");
    }

    // قائمة بنود القيد التي ينتمي إليها هذا البند
    get list() {
        const record = this.props.record;
        for (const value of Object.values(record.model.root.data)) {
            if (value && value.records && value.records.some((rec) => rec.id === record.id)) {
                return value;
            }
        }
        return null;
    }

    get index() {
        const list = this.list;
        return list ? list.records.findIndex((rec) => rec.id === this.props.record.id) : -1;
    }

    get isFirst() {
        return this.index <= 0;
    }

    // القيد المرحّل لا تُحرَّر بنوده في الواجهة، فنعيد ترتيبه عبر الخادم مباشرة
    get isPosted() {
        return this.props.record.model.root.data.state === "posted";
    }

    get isLast() {
        const list = this.list;
        return !list || this.index === list.records.length - 1;
    }

    async move(delta) {
        const list = this.list;
        const from = this.index;
        const to = from + delta;
        if (!list || from < 0 || to < 0 || to >= list.records.length) {
            return;
        }
        if (this.isPosted && this.props.record.resId) {
            await this.orm.call("myaccounting.move.line", "action_reorder",
                                [[this.props.record.resId], delta]);
            await this.props.record.model.root.load();
            return;
        }
        // إعادة الترتيب في أودو تعتمد على حقل الترتيب وعلى كون القائمة مرتّبة به،
        // ونحدّدهما هنا لأننا نستخدم أسهماً بدل أداة السحب القياسية (handle).
        if (!list.handleField) {
            list.handleField = "sequence";
        }
        if (!list.orderBy || !list.orderBy.length) {
            // ترتيب القائمة بحقل الترتيب أولاً (كما تفعل أداة السحب القياسية)
            await list.sortBy("sequence");
        }
        // resequence(المنقول، المرجع): لأعلى نضع البند قبل الذي فوقه،
        // ولأسفل نضعه بعد الذي تحته.
        const records = list.records;
        const targetId = delta < 0
            ? (to === 0 ? null : records[to - 1].id)
            : records[to].id;
        await list.resequence(this.props.record.id, targetId);
    }
}

registry.category("fields").add("myaccounting_line_order", {
    component: MoveLineOrder,
    supportedTypes: ["integer"],
    listViewWidth: 46,
    isEmpty: () => false,
});
