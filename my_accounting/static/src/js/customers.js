/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { PeriodFilter } from "./period_filter";
import { openRecord } from "./open_record";
import { user } from "@web/core/user";
import { deserializeDateTime, formatDateTime } from "@web/core/l10n/dates";
import { Dialog } from "@web/core/dialog/dialog";

const round3 = (value) => Math.round((value || 0) * 1000) / 1000;
const fmt3 = (value) => (Math.abs(value || 0) < 0.0005 ? 0 : value)
    .toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 });

/**
 * نافذة تخصيص سند قبض لفواتير العميل: لكل فاتورة المتاح عليها وخانة للمبلغ.
 * بلا تخصيص يُوزَّع السند تلقائياً على أقدم الفواتير.
 */
export class ReceiptAllocationDialog extends Component {
    static template = "my_accounting.ReceiptAllocationDialog";
    static components = { Dialog };
    static props = ["moveId", "customerId", "onSaved", "close"];

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.fmt = fmt3;
        this.state = useState({ data: null, rows: [] });
        onWillStart(async () => {
            const data = await this.orm.call("myaccounting.customers", "get_receipt_allocation",
                [this.props.moveId, this.props.customerId]);
            const rows = data.invoices.map((inv) => ({ ...inv, checked: inv.current > 0, amount: inv.current }));
            // أول فتح: نعبّئ الفواتير المذكورة في بيان السند (مثل "تحصيل ف 283 و 284")
            if (!data.has_allocation) {
                let left = data.amount;
                for (const number of data.suggested) {
                    const row = rows.find((r) => r.number === number);
                    if (row && left > 0.0005 && row.available > 0.0005) {
                        row.checked = true;
                        row.suggested = true;
                        row.amount = round3(Math.min(row.available, left));
                        left -= row.amount;
                    }
                }
            }
            this.state.data = data;
            this.state.rows = rows;
        });
    }

    // الفواتير المسددة بالكامل بتخصيص سندات أخرى لا تظهر
    get visibleRows() {
        return this.state.rows.filter((row) => row.available > 0.0005 || row.current > 0.0005 || row.checked);
    }

    get allocated() {
        return round3(this.state.rows.reduce((sum, row) => sum + (row.checked ? row.amount || 0 : 0), 0));
    }

    get left() {
        return round3(this.state.data.amount - this.allocated);
    }

    get hasError() {
        return this.left < -0.0005 || this.state.rows.some((row) => row.checked && row.amount > row.available + 0.0005);
    }

    toggle(row, ev) {
        row.checked = ev.target.checked;
        if (row.checked && !row.amount) {
            row.amount = round3(Math.max(0, Math.min(row.available, this.left)));
        }
        if (!row.checked) {
            row.amount = 0;
        }
    }

    setAmount(row, ev) {
        row.amount = round3(parseFloat(ev.target.value) || 0);
        row.checked = row.amount > 0;
    }

    async save() {
        const allocations = this.state.rows
            .filter((row) => row.checked && row.amount > 0)
            .map((row) => ({ number: row.number, amount: row.amount }));
        await this.orm.call("myaccounting.customers", "save_receipt_allocation",
            [this.props.moveId, this.props.customerId, allocations]);
        this.notification.add(allocations.length ? "تم حفظ التخصيص." : "أُلغي التخصيص: السند يُوزَّع تلقائياً.",
            { type: "success" });
        await this.props.onSaved();
        this.props.close();
    }

    async clear() {
        await this.orm.call("myaccounting.customers", "save_receipt_allocation",
            [this.props.moveId, this.props.customerId, []]);
        this.notification.add("أُلغي التخصيص: السند يُوزَّع تلقائياً على الأقدم.", { type: "success" });
        await this.props.onSaved();
        this.props.close();
    }
}

/**
 * صفحة العملاء: أرصدة الذمم، سجل الفواتير الصادرة بالترتيب الرقمي، وسندات القبض.
 * رصيد العميل = إجمالي مدين حسابه − إجمالي دائنه (بلا ربط التحصيل بفواتير بعينها).
 */
export class CustomersPage extends Component {
    static template = "my_accounting.Customers";
    static components = { PeriodFilter };
    static props = ["*"];

    setup() {
        this.orm = useService("orm");
        this.actionService = useService("action");
        this.notification = useService("notification");
        this.dialog = useService("dialog");
        // يمكن فتح الصفحة على تبويب معيّن (من مربعات الصفحة الرئيسية)
        const context = (this.props.action && this.props.action.context) || {};
        this.state = useState({
            data: null,
            loading: true,
            tab: context.customers_tab || (context.customer_id ? "all" : "customers"),
            search: "",
            customerId: context.customer_id || null,
            includeDrafts: false,
            invoiceStatus: context.invoice_status || "all", // all | open | partial | paid
            ledgerMonth: "", // فلتر شهر دفتر الأستاذ (نفس أزرار صفحة القيود)
            ledgerYear: "",
            notesFilter: "open", // open | resolved | all
            resolvingKey: null,
            resolutionText: "",
        });
        onWillStart(() => this.loadData());
    }

    async loadData() {
        this.state.loading = true;
        this.state.data = await this.orm.call("myaccounting.customers", "get_customers_data", [],
            {
                include_drafts: this.state.includeDrafts,
                ledger_month: this.state.ledgerMonth || false,
                ledger_year: this.state.ledgerYear || false,
            });
        this.state.loading = false;
    }

    toggleDrafts(ev) {
        this.state.includeDrafts = ev.target.checked;
        this.loadData();
    }

    // فلتر الفترة الموحّد (السنة + الأشهر)
    onPeriodChange({ year, month }) {
        this.state.ledgerYear = year;
        this.state.ledgerMonth = month;
        this.loadData();
    }

    // رصيد أول الشهر المحدد (للعميل المحدد أو لكل العملاء)
    get openingBalance() {
        const data = this.state.data;
        if (!data || !this.state.ledgerMonth) {
            return 0;
        }
        return this.selectedCustomer ? this.selectedCustomer.opening : data.totals.opening;
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
        let balance = this.openingBalance;
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
        return { debit, credit, balance: this.openingBalance + debit - credit };
    }

    get invoiceTotals() {
        const real = this.invoicesShown.filter((inv) => inv.kind === "invoice");
        const invoiced = real.reduce((sum, inv) => sum + inv.amount, 0);
        const returned = -this.invoicesShown.filter((inv) => inv.kind === "return")
            .reduce((sum, inv) => sum + inv.amount, 0);
        return {
            invoiced,
            returned,
            net: invoiced - returned,
            collected: real.reduce((sum, inv) => sum + inv.collected, 0),
            remaining: real.reduce((sum, inv) => sum + inv.remaining, 0),
        };
    }

    // مطابقة: المتبقي على الفواتير − الدفعات غير المخصّصة = المستحق على العملاء.
    // تظهر فقط دون بحث نصي أو فلتر شهر أو حالة "محصّلة/جزئي"، حتى تكون الأرقام قابلة للمقارنة.
    get reconciliation() {
        const data = this.state.data;
        if (!data || this.state.search.trim() || this.state.ledgerMonth ||
                !["all", "open"].includes(this.state.invoiceStatus)) {
            return null;
        }
        const remaining = this.invoiceTotals.remaining;
        const unapplied = this.receipts.reduce((sum, rec) => sum + (rec.unallocated || 0), 0);
        const balance = this.selectedCustomer ? this.selectedCustomer.balance : data.totals.balance;
        const other = balance - (remaining - unapplied);
        if (Math.abs(unapplied) < 0.0005 && Math.abs(other) < 0.0005) {
            return null; // لا فرق يحتاج توضيحاً
        }
        return { remaining, unapplied, other, balance };
    }

    // ------------------------------------------------------------------
    // التحصيل: حالة كل فاتورة، وتخصيص السندات
    // ------------------------------------------------------------------

    // "غير محصّلة" تشمل الجزئية أيضاً (كل فاتورة عليها متبقٍّ)
    statusMatches(inv, status) {
        if (status === "all") {
            return true;
        }
        if (inv.kind !== "invoice") {
            return false;
        }
        return status === "open" ? ["open", "partial"].includes(inv.status) : inv.status === status;
    }

    get invoicesShown() {
        return this.invoices.filter((inv) => this.statusMatches(inv, this.state.invoiceStatus));
    }

    get invoiceStatusCounts() {
        const counts = {};
        for (const status of ["all", "open", "partial", "paid"]) {
            counts[status] = this.invoices.filter((inv) =>
                (status === "all" ? inv.kind === "invoice" : this.statusMatches(inv, status))).length;
        }
        return counts;
    }

    statusLabel(status) {
        return { open: "غير محصّلة", partial: "جزئي", paid: "محصّلة", returned: "ملغاة بمرتجع" }[status] || "";
    }

    statusClass(status) {
        return {
            open: "text-bg-danger",
            partial: "text-bg-warning",
            paid: "text-bg-success",
            returned: "text-bg-secondary",
        }[status] || "text-bg-light";
    }

    paymentsTitle(inv) {
        return (inv.payments || []).map((p) =>
            `${p.receipt}: ${fmt3(p.amount)}${p.manual ? "" : " (تلقائي)"}`).join("\n");
    }

    openAllocation(rec) {
        this.dialog.add(ReceiptAllocationDialog, {
            moveId: rec.move_id,
            customerId: rec.customer_id,
            onSaved: () => this.loadData(),
        });
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
            receipt_unallocated: "fa-link",
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

    openMove(moveId, isMiddleClick = false) {
        openRecord(this.actionService, "myaccounting.move", moveId, isMiddleClick);
    }

    printStatement(customerId) {
        const url = `/report/html/my_accounting.report_myaccounting_account_statement/${customerId}` +
            `?context=${encodeURIComponent(JSON.stringify(user.context))}`;
        window.open(url, "_blank");
    }
}

registry.category("actions").add("my_accounting.customers", CustomersPage);
