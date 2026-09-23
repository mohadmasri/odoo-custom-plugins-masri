/** @odoo-module **/

import { patch } from "@web/core/utils/patch";
import { ListRenderer } from "@web/views/list/list_renderer";

/**
 * التنقل داخل بنود القيد بـ Shift + سهم (عند الإضافة أو التعديل):
 *  - Shift + أعلى/أسفل: البند السابق/التالي مع البقاء في نفس الحقل.
 *  - Shift + يمين/يسار: الحقل السابق/التالي في نفس البند.
 *
 * السهم وحده يبقى للكتابة داخل الحقل (تحريك المؤشّر واختيار الاقتراحات)،
 * وخارج حقول الكتابة ينقل بين القيود (انظر pager_hotkeys.js).
 */
patch(ListRenderer.prototype, {
    onCellKeydownEditMode(hotkey, cell, group, record) {
        if (this.maLineNavigation(hotkey, cell, record)) {
            return true;
        }
        return super.onCellKeydownEditMode(hotkey, cell, group, record);
    },

    // الميزة خاصة بشاشات المحاسبة (بنود القيد وبنود قيد الصورة)
    get maIsAccountingList() {
        const root = this.props.list && this.props.list.model && this.props.list.model.root;
        return !!root && String(root.resModel || "").startsWith("myaccounting.");
    },

    maLineNavigation(hotkey, cell, record) {
        if (!this.maIsAccountingList || !record) {
            return false;
        }
        const row = cell.parentElement;

        // الحقل السابق/التالي في نفس البند (يتبع اتجاه الشاشة)
        if (hotkey === "shift+arrowleft" || hotkey === "shift+arrowright") {
            const forward = this.isRTL ? hotkey === "shift+arrowleft" : hotkey === "shift+arrowright";
            const toFocus = forward
                ? this.findNextFocusableOnRow(row, cell)
                : this.findPreviousFocusableOnRow(row, cell);
            if (!toFocus) {
                return false;
            }
            this.focus(toFocus);
            return true;
        }

        // البند السابق/التالي مع البقاء في نفس العمود
        if (hotkey === "shift+arrowup" || hotkey === "shift+arrowdown") {
            const { list } = this.props;
            const index = list.records.indexOf(record);
            const target = list.records[index + (hotkey === "shift+arrowdown" ? 1 : -1)];
            if (!target) {
                return false;
            }
            const column = this.columns.find((col) => col.name === cell.getAttribute("name"));
            this.cellToFocus = { record: target, column: column || this.columns[0] };
            list.enterEditMode(target);
            return true;
        }
        return false;
    },
});
