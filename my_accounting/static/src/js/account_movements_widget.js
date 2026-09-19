/** @odoo-module **/

import { Component, useState, onWillStart, onWillUpdateProps } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { standardWidgetProps } from "@web/views/widgets/standard_widget_props";
import { user } from "@web/core/user";
import {
    emptyMovementFilter,
    hasMovementFilter,
    loadMovementFilter,
    movementFilterParams,
    saveMovementFilter,
} from "./movement_filter_store";

const STATE_LABELS = { draft: "مسودة", incomplete: "غير مكتمل", posted: "مرحّل" };

export class AccountMovementsPanel extends Component {
    static template = "my_accounting.AccountMovementsPanel";
    static props = { ...standardWidgetProps };

    setup() {
        this.orm = useService("orm");
        this.actionService = useService("action");
        this.notification = useService("notification");
        // عند فتح الحساب من شجرة الحسابات: نبدأ بنفس فلتر الشجرة، وأي تعديل أو
        // إلغاء هنا يُحفظ ليظهر في الشجرة أيضاً عند الرجوع إليها.
        this.fromTree = !!this.props.record.context?.my_accounting_from_tree;
        this.state = useState({
            records: [],
            childAccounts: [],
            moveNames: [],
            moveName: "",
            ref: "",
            accountFilter: "",
            // فلتر الحركة المشترك مع الشجرة: تاريخ / رقم قيد / شهر دفتر الأستاذ
            filter: (this.fromTree && loadMovementFilter()) || emptyMovementFilter(),
            // القيم الافتراضية المحسوبة على الخادم (اليوم / آخر قيد / الشهر الحالي)
            resolved: null,
        });
        this.stateLabels = STATE_LABELS;
        this._debounceTimer = null;
        onWillStart(() => Promise.all([this.loadAccounts(), this.loadMoveNames()]).then(() => this.loadData()));
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

    get hasFilter() {
        return hasMovementFilter(this.state.filter);
    }

    get baseDomain() {
        const domain = this.state.accountFilter
            ? [["account_id", "=", this.state.accountFilter]]
            : [["account_id", "child_of", this.accountId]];
        if (this.state.moveName) {
            domain.push(["move_id.name", "ilike", this.state.moveName]);
        }
        if (this.state.ref) {
            domain.push(["move_id.ref", "ilike", this.state.ref]);
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

    async loadMoveNames() {
        this.state.moveNames = await this.orm.call("myaccounting.account", "get_move_names", []);
    }

    async loadData() {
        if (!this.accountId) {
            this.state.records = [];
            return;
        }
        let filterDomain = [];
        this.state.resolved = null;
        if (this.hasFilter) {
            const result = await this.orm.call(
                "myaccounting.account", "get_movement_filter", [], movementFilterParams(this.state.filter));
            filterDomain = result.domain;
            this.state.resolved = result;
        }
        this.state.records = await this.orm.searchRead(
            "myaccounting.move.line",
            [...this.baseDomain, ...filterDomain],
            ["date", "move_id", "account_id", "name", "debit", "credit", "move_state"],
            { order: "date, id" }
        );
    }

    onTextInput(field, ev) {
        this.state[field] = ev.target.value;
        clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => this.loadData(), 350);
    }

    // تغيير أحد حقول فلتر الحركة (تاريخ / قيد / شهر أستاذ)
    onFilterChange(field, ev) {
        const value = ev.target.value.trim();
        if ((field === "moveFrom" || field === "moveTo") && value && !this.state.moveNames.includes(value)) {
            this.notification.add(`رقم القيد "${value}" غير موجود.`, { type: "danger" });
            ev.target.value = this.state.filter[field];
            return;
        }
        this.state.filter[field] = value;
        this.persistFilter();
        this.loadData();
    }

    persistFilter() {
        if (this.fromTree) {
            saveMovementFilter(this.state.filter);
        }
    }

    onAccountFilter(ev) {
        const value = ev.target.value;
        this.state.accountFilter = value ? parseInt(value, 10) : "";
        this.loadData();
    }

    clearMovementFilter() {
        this.state.filter = emptyMovementFilter();
        this.persistFilter();
        this.loadData();
    }

    clearFilters() {
        Object.assign(this.state, { moveName: "", ref: "", accountFilter: "", filter: emptyMovementFilter() });
        this.persistFilter();
        this.loadData();
    }

    openMove(id) {
        // أكثر من بند قد ينتمي لنفس القيد، فنزيل التكرار مع الحفاظ على الترتيب
        const resIds = [...new Set(this.state.records.map((rec) => rec.move_id[0]))];
        this.actionService.doAction(
            {
                type: "ir.actions.act_window",
                res_model: "myaccounting.move",
                res_id: id,
                views: [[false, "form"]],
                target: "current",
            },
            { props: { resIds } }
        );
    }

    printStatement() {
        // ملاحظة: doAction لا يمرر مفاتيح context المخصصة (date_from/date_to/line_ids) إلى
        // رابط تقرير qweb-html (يستخدم فقط user context)، لذا نبني الرابط يدوياً هنا
        // لضمان طباعة نفس الحركات المعروضة بعد تطبيق الفلاتر.
        const accountId = this.state.accountFilter || this.accountId;
        const filter = this.state.filter;
        const resolved = this.state.resolved || {};
        const context = {
            ...user.context,
            date_from: filter.dateFrom || false,
            date_to: resolved.date_to || false,
            move_from: resolved.move_from || false,
            move_to: resolved.move_to || false,
            ledger_from: filter.ledgerFrom || false,
            ledger_to: resolved.ledger_to || false,
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
