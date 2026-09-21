/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { user } from "@web/core/user";
import { deserializeDateTime, formatDateTime } from "@web/core/l10n/dates";

/**
 * صفحة العملاء: أرصدة الذمم، سجل الفواتير الصادرة بالترتيب الرقمي، وسندات القبض.
 * رصيد العميل = إجمالي مدين حسابه − إجمالي دائنه (بلا ربط التحصيل بفواتير بعينها).
 */
export class CustomersPage extends Component {
    static template = "my_accounting.Customers";
    static props = ["*"];

    setup() {
        this.orm = useService("orm");
        this.actionService = useService("action");
        this.notification = useService("notification");
        this.state = useState({
            data: null,
            loading: true,
            tab: "customers",
            search: "",
            customerId: null,
            includeDrafts: false,
            notesFilter: "open", // open | resolved | all
            resolvingKey: null,
            resolutionText: "",
        });
        onWillStart(() => this.loadData());
    }

    async loadData() {
        this.state.loading = true;
        this.state.data = await this.orm.call("myaccounting.customers", "get_customers_data", [],
            { include_drafts: this.state.includeDrafts });
        this.state.loading = false;
    }

    toggleDrafts(ev) {
        this.state.includeDrafts = ev.target.checked;
        this.loadData();
    }

    setTab(tab) {
        this.state.tab = tab;
    }

    // ------------------------------------------------------------------
    // الفلترة: العميل المحدد + البحث بالاسم أو رقم الفاتورة أو البيان
    // ------------------------------------------------------------------

    matches(text) {
        const query = this.state.search.trim().toLowerCase();
        return !query || String(text || "").toLowerCase().includes(query);
    }

    get customers() {
        const data = this.state.data;
        if (!data) {
            return [];
        }
        return data.customers.filter((c) => this.matches(`${c.code} ${c.name}`));
    }

    get invoices() {
        const data = this.state.data;
        if (!data) {
            return [];
        }
        return data.invoices.filter((inv) =>
            (!this.state.customerId || inv.customer_id === this.state.customerId) &&
            this.matches(`${inv.number || ""} ${inv.customer} ${inv.label} ${inv.move_name}`));
    }

    get receipts() {
        const data = this.state.data;
        if (!data) {
            return [];
        }
        return data.receipts.filter((rec) =>
            (!this.state.customerId || rec.customer_id === this.state.customerId) &&
            this.matches(`${rec.move_name} ${rec.customer} ${rec.label}`));
    }

    // السجل الكامل: الفواتير والمرتجعات وسندات القبض معاً، بالتاريخ، مع رصيد متراكم
    get fullLedger() {
        const kindOrder = { invoice: 0, return: 1, receipt: 2 };
        const rows = [
            ...this.invoices.map((inv) => ({
                key: `inv-${inv.line_id}`,
                date: inv.date,
                kind: inv.kind,
                number: inv.number,
                customer: inv.customer,
                label: inv.label,
                debit: inv.amount > 0 ? inv.amount : 0,
                credit: inv.amount < 0 ? -inv.amount : 0,
                move_id: inv.move_id,
                move_name: inv.move_name,
                state: inv.state,
            })),
            ...this.receipts.map((rec, index) => ({
                key: `rec-${rec.move_id}-${index}`,
                date: rec.date,
                kind: "receipt",
                number: rec.move_name,
                customer: rec.customer,
                label: rec.label,
                debit: 0,
                credit: rec.amount,
                move_id: rec.move_id,
                move_name: rec.move_name,
                state: rec.state,
            })),
        ];
        rows.sort((a, b) =>
            (a.date || "").localeCompare(b.date || "") ||
            kindOrder[a.kind] - kindOrder[b.kind] ||
            String(a.number || "").localeCompare(String(b.number || ""), undefined, { numeric: true }));
        let balance = 0;
        for (const row of rows) {
            balance += row.debit - row.credit;
            row.balance = balance;
        }
        return rows;
    }

    // مجاميع الجداول (حسب الفلترة الحالية)
    get fullLedgerTotals() {
        const rows = this.fullLedger;
        const debit = rows.reduce((sum, row) => sum + row.debit, 0);
        const credit = rows.reduce((sum, row) => sum + row.credit, 0);
        return { debit, credit, balance: debit - credit };
    }

    get invoiceTotals() {
        const invoiced = this.invoices.filter((inv) => inv.kind === "invoice")
            .reduce((sum, inv) => sum + inv.amount, 0);
        const returned = -this.invoices.filter((inv) => inv.kind === "return")
            .reduce((sum, inv) => sum + inv.amount, 0);
        return { invoiced, returned, net: invoiced - returned };
    }

    get receiptsTotal() {
        return this.receipts.reduce((sum, rec) => sum + rec.amount, 0);
    }

    kindLabel(kind) {
        return { invoice: "فاتورة", return: "مرتجع", receipt: "سند قبض" }[kind];
    }

    get selectedCustomer() {
        const data = this.state.data;
        return data && this.state.customerId
            ? data.customers.find((c) => c.id === this.state.customerId)
            : null;
    }

    // ------------------------------------------------------------------
    // ملاحظات المراجعة (تُحسب في الخادم، وتُحل يدوياً مع ملاحظة الحل)
    // ------------------------------------------------------------------

    // ملاحظات العميل المحدد + الملاحظات العامة (مثل الأرقام الناقصة)
    get relevantNotes() {
        const notes = this.state.data ? this.state.data.notes : [];
        return notes.filter((note) =>
            !this.state.customerId || !note.customer_id || note.customer_id === this.state.customerId);
    }

    get openNotesCount() {
        return this.relevantNotes.filter((note) => !note.resolved).length;
    }

    get visibleNotes() {
        const filter = this.state.notesFilter;
        return this.relevantNotes.filter((note) =>
            (filter === "all" || (filter === "resolved") === note.resolved) &&
            this.matches(`${note.title} ${note.detail} ${note.resolution}`));
    }

    // الملاحظات غير المحلولة التي تظهر داخل تبويب معيّن
    openNotesFor(tab) {
        return this.relevantNotes.filter((note) => note.tab === tab && !note.resolved);
    }

    noteIcon(kind) {
        return {
            missing_invoice: "fa-question-circle",
            duplicate_invoice: "fa-clone",
            invoice_no_number: "fa-hashtag",
            return_unmatched: "fa-undo",
            missing_receipt: "fa-question-circle",
            credit_balance: "fa-exchange",
        }[kind] || "fa-exclamation-triangle";
    }

    // وقت الحل بتوقيت المستخدم (الخادم يرسله بتوقيت UTC)
    fmtDateTime(value) {
        return value ? formatDateTime(deserializeDateTime(value)) : "";
    }

    noteTabLabel(tab) {
        return { invoices: "سجل الفواتير", receipts: "سندات القبض", customers: "أرصدة العملاء" }[tab];
    }

    showNotes() {
        this.state.notesFilter = "open";
        this.state.tab = "notes";
    }

    startResolve(note) {
        this.state.resolvingKey = note.key;
        this.state.resolutionText = note.resolution || "";
    }

    cancelResolve() {
        this.state.resolvingKey = null;
        this.state.resolutionText = "";
    }

    async saveResolve(note) {
        const text = this.state.resolutionText.trim();
        if (!text) {
            this.notification.add("اكتب ملاحظة الحل أولاً (مثلاً: الرقم 279 هو رقم إشعار الإرجاع).", { type: "warning" });
            return;
        }
        await this.orm.call("myaccounting.customers", "resolve_note", [note.key, text],
            { kind: note.kind, title: note.title });
        this.cancelResolve();
        this.notification.add("تم حل الملاحظة.", { type: "success" });
        await this.loadData();
    }

    async reopenNote(note) {
        await this.orm.call("myaccounting.customers", "reopen_note", [note.key]);
        await this.loadData();
    }

    selectCustomer(customer) {
        this.state.customerId = customer.id;
        this.state.tab = "all";
    }

    clearCustomer() {
        this.state.customerId = null;
    }

    // ------------------------------------------------------------------

    fmt(value) {
        return Math.abs(value || 0) < 0.0005
            ? "0.000"
            : value.toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
    }

    balanceClass(value) {
        if (value > 0.0005) return "text-danger";
        if (value < -0.0005) return "text-primary";
        return "text-success";
    }

    openMove(moveId) {
        this.actionService.doAction({
            type: "ir.actions.act_window",
            res_model: "myaccounting.move",
            res_id: moveId,
            views: [[false, "form"]],
            target: "current",
        });
    }

    printStatement(customerId) {
        const url = `/report/html/my_accounting.report_myaccounting_account_statement/${customerId}` +
            `?context=${encodeURIComponent(JSON.stringify(user.context))}`;
        window.open(url, "_blank");
    }
}

registry.category("actions").add("my_accounting.customers", CustomersPage);
