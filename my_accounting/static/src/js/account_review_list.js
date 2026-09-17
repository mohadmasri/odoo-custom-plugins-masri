/** @odoo-module **/

import { registry } from "@web/core/registry";
import { listView } from "@web/views/list/list_view";
import { ListRenderer } from "@web/views/list/list_renderer";

// عند تحديد خانة حساب له حسابات فرعية ظاهرة في نفس القائمة، تُحدَّد كل تلك
// الحسابات الفرعية معه تلقائياً (بكل مستوياتها). عند إلغاء التحديد لا يُلغى
// تحديد ما تحته، حتى يمكن اختيار حساب رئيسي بكل فروعه ثم إلغاء تحديد الرئيسي
// فقط والإبقاء على الفروع محددة (مثلاً لحذفها كلها دون حذف الحساب الرئيسي).
export class AccountReviewListRenderer extends ListRenderer {
    toggleRecordSelection(record, ev) {
        if (!this.canSelectRecord) {
            return;
        }
        const isRecordPresent = this.props.list.records.includes(this.lastCheckedRecord);
        if (this.shiftKeyMode && isRecordPresent) {
            this.toggleRangeSelection(record);
        } else {
            const selected = !record.selected;
            record.toggleSelection(selected);
            if (selected) {
                this.cascadeSelectionToChildren(record, selected);
            }
        }
        this.lastCheckedRecord = record;
    }

    cascadeSelectionToChildren(record, selected) {
        const byParent = {};
        for (const r of this.props.list.records) {
            const parentId = r.data.parent_id && r.data.parent_id.id;
            if (parentId) {
                if (!byParent[parentId]) {
                    byParent[parentId] = [];
                }
                byParent[parentId].push(r);
            }
        }
        const stack = [record.resId];
        while (stack.length) {
            const parentId = stack.pop();
            for (const child of byParent[parentId] || []) {
                child.toggleSelection(selected);
                stack.push(child.resId);
            }
        }
    }
}

registry.category("views").add("myaccounting_account_review_list", {
    ...listView,
    Renderer: AccountReviewListRenderer,
});
