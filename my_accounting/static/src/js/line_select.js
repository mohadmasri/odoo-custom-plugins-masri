/** @odoo-module **/

import { Component, onWillStart, reactive, useState } from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { standardWidgetProps } from "@web/views/widgets/standard_widget_props";

/**
 * البنود المؤشَّرة في القيد المفتوح. تعيش خارج السجل نفسه حتى يمكن
 * التأشير على بنود قيد مرحّل (قائمته للقراءة فقط)، ولا تُحفظ في القاعدة.
 */
export const lineSelection = reactive({ moveId: null, ids: [] });

function keyOf(record) {
    return record.resId || record.id;
}

/** يبدأ تحديداً جديداً عند الانتقال إلى قيد آخر */
function useMove(moveId) {
    if (lineSelection.moveId !== moveId) {
        lineSelection.moveId = moveId;
        lineSelection.ids = [];
    }
}

/** مربع التأشير بجانب البند */
export class LineSelectBox extends Component {
    static template = "my_accounting.LineSelectBox";
    static props = { ...standardWidgetProps };

    setup() {
        this.selection = useState(lineSelection);
    }

    get lineKey() {
        return keyOf(this.props.record);
    }

    get checked() {
        return this.selection.ids.includes(this.lineKey);
    }

    toggle(ev) {
        const key = this.lineKey;
        this.selection.ids = ev.target.checked
            ? this.selection.ids.concat([key])
            : this.selection.ids.filter((id) => id !== key);
    }
}

/** نافذة اختيار القيد الذي تُنسخ إليه البنود */
export class CopyLinesDialog extends Component {
    static template = "my_accounting.CopyLinesDialog";
    static components = { Dialog };
    static props = {
        close: Function,
        count: Number,
        currentMoveId: [Number, Boolean],
        currentMoveName: { type: String, optional: true },
        onConfirm: Function,
    };

    setup() {
        this.orm = useService("orm");
        this.listId = "o_copy_lines_moves";
        // "same" ينسخ البنود مرة أخرى في القيد نفسه (تكرار بند متشابه)
        this.state = useState({
            mode: this.props.currentMoveId ? "same" : "new",
            targetId: false,
            text: "",
            moves: [],
        });
        onWillStart(async () => {
            this.state.moves = await this.orm.call(
                "myaccounting.move", "get_copy_targets", []);
        });
    }

    /** القيد الذي ستذهب إليه البنود فعلاً حسب الخيار المختار */
    get target() {
        const id = this.state.mode === "same" ? this.props.currentMoveId : this.state.targetId;
        return this.state.moves.find((move) => move.id === id);
    }

    onTargetInput(ev) {
        this.state.text = ev.target.value;
        const move = this.state.moves.find((item) => item.label === ev.target.value);
        this.state.targetId = move ? move.id : false;
    }

    get problem() {
        if (this.state.mode === "new") {
            return "";
        }
        if (this.state.mode === "existing" && !this.state.targetId) {
            return "اختر القيد الذي تريد النسخ إليه.";
        }
        const target = this.target;
        if (target && target.state === "posted") {
            return `القيد ${target.name} مرحّل، فلا تُضاف إليه بنود. أعده إلى مسودة أولاً.`;
        }
        return "";
    }

    confirm() {
        if (this.problem) {
            return;
        }
        const target = this.state.mode === "new" ? false : this.target && this.target.id;
        this.props.onConfirm(target || false);
        this.props.close();
    }
}

/** شريط "نسخ إلى قيد" فوق بنود القيد، يظهر حين يُؤشَّر على بند */
export class LineCopyBar extends Component {
    static template = "my_accounting.LineCopyBar";
    static props = { ...standardWidgetProps };

    setup() {
        this.orm = useService("orm");
        this.dialog = useService("dialog");
        this.action = useService("action");
        this.notification = useService("notification");
        this.selection = useState(lineSelection);
        useMove(this.props.record.resId);
    }

    get count() {
        return this.selection.ids.length;
    }

    get countLabel() {
        const count = this.count;
        if (count === 1) {
            return "بند واحد";
        }
        if (count === 2) {
            return "بندين";
        }
        return count <= 10 ? `${count} بنود` : `${count} بنداً`;
    }

    clear() {
        this.selection.ids = [];
    }

    open() {
        this.dialog.add(CopyLinesDialog, {
            count: this.count,
            currentMoveId: this.props.record.resId,
            currentMoveName: this.props.record.data.name || "",
            onConfirm: (targetId) => this.copy(targetId),
        });
    }

    async copy(targetId) {
        const ids = this.selection.ids.filter((id) => typeof id === "number");
        if (!ids.length) {
            this.notification.add("البنود المؤشَّرة غير محفوظة بعد.", { type: "warning" });
            return;
        }
        // النسخ في القيد المفتوح نفسه يتطلب إعادة تحميله بعدها، فنحفظ
        // تعديلاته غير المحفوظة أولاً حتى لا تضيع عند التحميل.
        const here = !!targetId && targetId === this.props.record.resId;
        if (here && this.props.record.dirty && !(await this.props.record.save())) {
            return;
        }
        try {
            const result = await this.orm.call(
                "myaccounting.move", "copy_lines_to", [ids, targetId || false]);
            this.clear();
            if (here) {
                await this.props.record.load();
            }
            this.notification.add(
                here
                    ? `نُسخ ${result.count} بند في هذا القيد.`
                    : `نُسخ ${result.count} بند إلى القيد ${result.name || ""}`.trim()
                      + (result.created ? " (قيد جديد)" : ""),
                here ? { type: "success" } : {
                    type: "success",
                    buttons: [{
                        name: "افتح القيد",
                        onClick: () => this.openMove(result.id),
                    }],
                });
        } catch (error) {
            this.notification.add(
                error.data?.message || error.message || "تعذّر نسخ البنود.",
                { type: "danger" });
        }
    }

    openMove(moveId) {
        this.action.doAction({
            type: "ir.actions.act_window",
            res_model: "myaccounting.move",
            res_id: moveId,
            views: [[false, "form"]],
            target: "current",
        });
    }
}

registry.category("view_widgets").add("my_accounting.line_select", {
    component: LineSelectBox,
});
registry.category("view_widgets").add("my_accounting.line_copy", {
    component: LineCopyBar,
});
