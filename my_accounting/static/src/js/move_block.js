/** @odoo-module **/

import { Component, onWillStart, useState } from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { standardWidgetProps } from "@web/views/widgets/standard_widget_props";
import { buildBlockLines, buildBlockText } from "./block_formula";

const ACCOUNT_LIST_ID = "o_move_block_accounts";

/**
 * نافذة الكتلة: خانات المبالغ كما عُرّفت في صفحة "الكتل الجاهزة"، والبنود
 * تُحسب منها أمام المستخدم قبل الإضافة فلا مفاجأة بعدها.
 */
export class MoveBlockDialog extends Component {
    static template = "my_accounting.MoveBlockDialog";
    static components = { Dialog };
    static props = {
        close: Function,
        block: Object,
        accounts: Array,
        onConfirm: Function,
    };

    setup() {
        this.listId = ACCOUNT_LIST_ID;
        const values = {};
        for (const field of this.props.block.fields) {
            values[field.key] = field.default_value || "";
        }
        this.state = useState({ text: "", values, accounts: {} });
    }

    get block() {
        return this.props.block;
    }

    /** البنود التي يُسأل عن حسابها عند كل استعمال */
    get askedLines() {
        return this.block.lines.filter((line) => line.ask_account);
    }

    accountLabel(id) {
        const account = this.props.accounts.find((acc) => acc.id === id);
        return account ? account.label : "";
    }

    onAccountInput(lineId, ev) {
        const account = this.props.accounts.find((acc) => acc.label === ev.target.value);
        this.state.accounts[lineId] = account ? account.id : false;
    }

    onValue(key, ev) {
        this.state.values[key] = ev.target.value;
    }

    get numbers() {
        const numbers = {};
        for (const field of this.block.fields) {
            numbers[field.key] = parseFloat(this.state.values[field.key]) || 0;
        }
        return numbers;
    }

    /** البيان: تكتبه الكتلة من صيغتها، وإلا فمن المستخدم */
    get composed() {
        return buildBlockText(this.block, this.state.values, this.state.accounts,
            this.props.accounts);
    }

    get text() {
        return this.block.text_template
            ? this.composed.text
            : this.state.text.trim();
    }

    get lines() {
        return buildBlockLines(this.block, this.numbers, this.state.accounts,
            this.text);
    }

    get problem() {
        if (this.block.text_template) {
            const missing = this.composed.missing;
            if (missing.length) {
                return `اكتب ${missing.join(" و")}.`;
            }
        } else if (!this.state.text.trim()) {
            return "اكتب البيان.";
        }
        const lines = this.lines;
        if (!lines.length) {
            return "كل البنود بصفر، اكتب المبالغ.";
        }
        const broken = lines.find((line) => line.error);
        if (broken) {
            return `خطأ في صيغة أحد البنود: ${broken.error}`;
        }
        if (lines.some((line) => !line.account_id)) {
            return "اختر كل الحسابات المطلوبة.";
        }
        return "";
    }

    confirm() {
        if (this.problem) {
            return;
        }
        this.props.onConfirm(this.lines);
        this.props.close();
    }

    onKeydown(ev) {
        if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            this.confirm();
        }
    }
}

/**
 * شريط الكتل فوق بنود القيد: زر لكل كتلة معرَّفة في الإعدادات.
 */
export class MoveBlockBar extends Component {
    static template = "my_accounting.MoveBlockBar";
    static props = { ...standardWidgetProps };

    setup() {
        this.orm = useService("orm");
        this.dialog = useService("dialog");
        this.action = useService("action");
        this.notification = useService("notification");
        this.data = useState({ blocks: [], accounts: [] });
        onWillStart(async () => {
            const loaded = await this.orm.call("myaccounting.block", "get_blocks", []);
            this.data.blocks = loaded.blocks.filter((block) => block.active);
            this.data.accounts = loaded.accounts;
        });
    }

    get readonly() {
        return this.props.record.data.state === "posted";
    }

    get accountListId() {
        return ACCOUNT_LIST_ID;
    }

    open(block) {
        this.dialog.add(MoveBlockDialog, {
            block,
            accounts: this.data.accounts,
            onConfirm: (lines) => this.addLines(block, lines),
        });
    }

    async addLines(block, lines) {
        const list = this.props.record.data.line_ids;
        for (const line of lines) {
            // mode readonly: نضيف البنود دون فتح أي صف في وضع التحرير
            const record = await list.addNewRecord({ position: "bottom", mode: "readonly" });
            await record.update({
                name: line.name,
                account_id: { id: line.account_id, display_name: this.label(line.account_id) },
                debit: line.debit,
                credit: line.credit,
                debit_zero_entered: !!line.debit_zero_entered,
                credit_zero_entered: !!line.credit_zero_entered,
            });
        }
        this.notification.add(`أُضيفت ${lines.length} بنود من كتلة ${block.name}.`,
            { type: "success" });
    }

    label(id) {
        const account = this.data.accounts.find((acc) => acc.id === id);
        return account ? account.name : "";
    }

    openSettings() {
        this.action.doAction("my_accounting.action_myaccounting_blocks");
    }
}

registry.category("view_widgets").add("my_accounting.move_block", {
    component: MoveBlockBar,
});
