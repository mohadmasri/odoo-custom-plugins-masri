/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";

const STATE_LABELS = { draft: "مسودة", posted: "مرحّل" };

const LEDGER_MONTH_OPTIONS = [
    { value: "1", label: "1 - يناير" }, { value: "2", label: "2 - فبراير" },
    { value: "3", label: "3 - مارس" }, { value: "4", label: "4 - أبريل" },
    { value: "5", label: "5 - مايو" }, { value: "6", label: "6 - يونيو" },
    { value: "7", label: "7 - يوليو" }, { value: "8", label: "8 - أغسطس" },
    { value: "9", label: "9 - سبتمبر" }, { value: "10", label: "10 - أكتوبر" },
    { value: "11", label: "11 - نوفمبر" }, { value: "12", label: "12 - ديسمبر" },
];

export class MoveList extends Component {
    static template = "my_accounting.MoveList";
    static props = ["*"];

    setup() {
        this.orm = useService("orm");
        this.actionService = useService("action");
        this.dialogService = useService("dialog");
        this.notification = useService("notification");
        this.state = useState({
            records: [],
            name: "",
            ref: "",
            account: "",
            dateFrom: "",
            dateTo: "",
            stateFilter: "",
            balanceFilter: "",
            ledgerMonth: "",
            ledgerYear: "",
            selected: {},
        });
        this.stateLabels = STATE_LABELS;
        this.ledgerMonthOptions = LEDGER_MONTH_OPTIONS;
        onWillStart(() => this.loadData());
        this._debounceTimer = null;
    }

    get selectedIds() {
        return Object.keys(this.state.selected)
            .filter((id) => this.state.selected[id])
            .map((id) => parseInt(id, 10));
    }

    get allSelected() {
        return this.state.records.length > 0 &&
            this.state.records.every((rec) => this.state.selected[rec.id]);
    }

    toggleSelectAll(ev) {
        const checked = ev.target.checked;
        const selected = {};
        if (checked) {
            for (const rec of this.state.records) {
                selected[rec.id] = true;
            }
        }
        this.state.selected = selected;
    }

    toggleSelect(id, ev) {
        ev.stopPropagation();
        const selected = { ...this.state.selected };
        selected[id] = ev.target.checked;
        this.state.selected = selected;
    }

    clearSelection() {
        this.state.selected = {};
    }

    printSelected() {
        const ids = this.selectedIds;
        if (!ids.length) {
            return;
        }
        this.actionService.doAction({
            type: "ir.actions.report",
            report_name: "my_accounting.report_myaccounting_move",
            report_type: "qweb-html",
            context: { active_ids: ids },
        });
    }

    async bulkPost() {
        const ids = this.selectedIds;
        if (!ids.length) {
            return;
        }
        try {
            await this.orm.call("myaccounting.move", "action_post", [ids]);
            this.notification.add("تم ترحيل القيود المحددة.", { type: "success" });
        } catch (e) {
            this.notification.add(e.data && e.data.message ? e.data.message : "تعذّر ترحيل بعض القيود.", { type: "danger" });
        }
        this.clearSelection();
        await this.loadData();
    }

    async bulkResetToDraft() {
        const ids = this.selectedIds;
        if (!ids.length) {
            return;
        }
        await this.orm.call("myaccounting.move", "action_reset_to_draft", [ids]);
        this.notification.add("تم إعادة القيود المحددة إلى مسودة.", { type: "success" });
        this.clearSelection();
        await this.loadData();
    }

    bulkDelete() {
        const ids = this.selectedIds;
        if (!ids.length) {
            return;
        }
        this.dialogService.add(ConfirmationDialog, {
            title: "حذف القيود المحددة",
            body: `هل أنت متأكد من حذف ${ids.length} قيد؟ لا يمكن حذف القيود المرحّلة.`,
            confirmLabel: "حذف",
            confirmClass: "btn-danger",
            confirm: async () => {
                try {
                    await this.orm.call("myaccounting.move", "unlink", [ids]);
                    this.notification.add("تم حذف القيود المحددة.", { type: "success" });
                } catch (e) {
                    this.notification.add(e.data && e.data.message ? e.data.message : "تعذّر حذف بعض القيود.", { type: "danger" });
                }
                this.clearSelection();
                await this.loadData();
            },
            cancel: () => {},
        });
    }

    get domain() {
        const domain = [];
        if (this.state.name) {
            domain.push(["name", "ilike", this.state.name]);
        }
        if (this.state.ref) {
            domain.push(["ref", "ilike", this.state.ref]);
        }
        if (this.state.account) {
            domain.push("|");
            domain.push(["line_ids.account_id.code", "ilike", this.state.account]);
            domain.push(["line_ids.account_id.name", "ilike", this.state.account]);
        }
        if (this.state.dateFrom) {
            domain.push(["date", ">=", this.state.dateFrom]);
        }
        if (this.state.dateTo) {
            domain.push(["date", "<=", this.state.dateTo]);
        }
        if (this.state.stateFilter) {
            domain.push(["state", "=", this.state.stateFilter]);
        }
        if (this.state.balanceFilter) {
            domain.push(["is_balanced", "=", this.state.balanceFilter === "balanced"]);
        }
        if (this.state.ledgerMonth) {
            domain.push(["ledger_month", "=", this.state.ledgerMonth]);
        }
        if (this.state.ledgerYear) {
            domain.push(["ledger_year", "=", parseInt(this.state.ledgerYear, 10)]);
        }
        return domain;
    }

    async loadData() {
        this.state.records = await this.orm.searchRead(
            "myaccounting.move",
            this.domain,
            ["name", "date", "ref", "journal", "total_debit", "total_credit", "state", "ledger_period_label"],
            { order: "date desc, id desc" }
        );
        this.state.selected = {};
    }

    onTextInput(field, ev) {
        this.state[field] = ev.target.value;
        clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => this.loadData(), 350);
    }

    onDateInput(field, ev) {
        this.state[field] = ev.target.value;
        this.loadData();
    }

    onStateFilter(value) {
        this.state.stateFilter = this.state.stateFilter === value ? "" : value;
        this.loadData();
    }

    onBalanceFilter(value) {
        this.state.balanceFilter = this.state.balanceFilter === value ? "" : value;
        this.loadData();
    }

    onLedgerMonthFilter(ev) {
        this.state.ledgerMonth = ev.target.value;
        this.loadData();
    }

    onLedgerYearInput(ev) {
        this.state.ledgerYear = ev.target.value;
        clearTimeout(this._ledgerYearTimer);
        this._ledgerYearTimer = setTimeout(() => this.loadData(), 350);
    }

    clearFilters() {
        Object.assign(this.state, {
            name: "",
            ref: "",
            account: "",
            dateFrom: "",
            dateTo: "",
            stateFilter: "",
            balanceFilter: "",
            ledgerMonth: "",
            ledgerYear: "",
        });
        this.loadData();
    }

    openMove(id) {
        this.actionService.doAction({
            type: "ir.actions.act_window",
            res_model: "myaccounting.move",
            res_id: id,
            views: [[false, "form"]],
            target: "current",
        });
    }

    createMove() {
        this.actionService.doAction({
            type: "ir.actions.act_window",
            res_model: "myaccounting.move",
            views: [[false, "form"]],
            target: "current",
        });
    }
}

registry.category("actions").add("my_accounting.move_list", MoveList);
