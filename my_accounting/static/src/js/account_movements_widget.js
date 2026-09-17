/** @odoo-module **/

import { Component, useState, onWillStart, onWillUpdateProps } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { standardWidgetProps } from "@web/views/widgets/standard_widget_props";
import { user } from "@web/core/user";

const STATE_LABELS = { draft: "مسودة", posted: "مرحّل" };

export class AccountMovementsPanel extends Component {
    static template = "my_accounting.AccountMovementsPanel";
    static props = { ...standardWidgetProps };

    setup() {
        this.orm = useService("orm");
        this.actionService = useService("action");
        this.state = useState({
            records: [],
            childAccounts: [],
            moveName: "",
            ref: "",
            dateFrom: "",
            dateTo: "",
            accountFilter: "",
        });
        this.stateLabels = STATE_LABELS;
        this._debounceTimer = null;
        onWillStart(() => this.loadAccounts().then(() => this.loadData()));
        onWillUpdateProps(() => this.loadAccounts().then(() => this.loadData()));
    }

    get accountId() {
        return this.props.record.resId;
    }

    get totalDebit() {
        return this.state.records.reduce((sum, rec) => sum + rec.debit, 0);
    }

    get totalCredit() {
        return this.state.records.reduce((sum, rec) => sum + rec.credit, 0);
    }

    get domain() {
        const domain = this.state.accountFilter
            ? [["account_id", "=", this.state.accountFilter]]
            : [["account_id", "child_of", this.accountId]];
        if (this.state.moveName) {
            domain.push(["move_id.name", "ilike", this.state.moveName]);
        }
        if (this.state.ref) {
            domain.push(["move_id.ref", "ilike", this.state.ref]);
        }
        if (this.state.dateFrom) {
            domain.push(["date", ">=", this.state.dateFrom]);
        }
        if (this.state.dateTo) {
            domain.push(["date", "<=", this.state.dateTo]);
        }
        return domain;
    }

    async loadAccounts() {
        if (!this.accountId) {
            this.state.childAccounts = [];
            return;
        }
        this.state.childAccounts = await this.orm.searchRead(
            "myaccounting.account",
            [["id", "child_of", this.accountId]],
            ["code", "name"],
            { order: "code_path" }
        );
        if (this.state.accountFilter &&
            !this.state.childAccounts.some((a) => a.id === this.state.accountFilter)) {
            this.state.accountFilter = "";
        }
    }

    async loadData() {
        if (!this.accountId) {
            this.state.records = [];
            return;
        }
        this.state.records = await this.orm.searchRead(
            "myaccounting.move.line",
            this.domain,
            ["date", "move_id", "account_id", "name", "debit", "credit", "move_state"],
            { order: "date, id" }
        );
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

    onAccountFilter(ev) {
        const value = ev.target.value;
        this.state.accountFilter = value ? parseInt(value, 10) : "";
        this.loadData();
    }

    clearFilters() {
        Object.assign(this.state, { moveName: "", ref: "", dateFrom: "", dateTo: "", accountFilter: "" });
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

    printStatement() {
        // ملاحظة: doAction لا يمرر مفاتيح context المخصصة (date_from/date_to/line_ids) إلى
        // رابط تقرير qweb-html (يستخدم فقط user context)، لذا نبني الرابط يدوياً هنا
        // لضمان طباعة نفس الحركات المعروضة بعد تطبيق الفلاتر.
        const accountId = this.state.accountFilter || this.accountId;
        const context = {
            ...user.context,
            date_from: this.state.dateFrom || false,
            date_to: this.state.dateTo || false,
            line_ids: this.state.records.map((rec) => rec.id),
        };
        const url = `/report/html/my_accounting.report_myaccounting_account_statement/${accountId}` +
            `?context=${encodeURIComponent(JSON.stringify(context))}`;
        window.open(url, "_blank");
    }
}

registry.category("view_widgets").add("my_accounting.account_movements_panel", {
    component: AccountMovementsPanel,
});
