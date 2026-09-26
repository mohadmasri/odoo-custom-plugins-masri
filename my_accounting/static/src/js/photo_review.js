/** @odoo-module **/

import { Component, onWillStart, useRef, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { useExternalListener } from "@odoo/owl";
import { JournalPicker } from "./journal_input";

const MONTHS = [
    ["1", "1 - كانون الثاني"], ["2", "2 - شباط"], ["3", "3 - آذار"], ["4", "4 - نيسان"],
    ["5", "5 - أيار"], ["6", "6 - حزيران"], ["7", "7 - تموز"], ["8", "8 - آب"],
    ["9", "9 - أيلول"], ["10", "10 - تشرين الأول"], ["11", "11 - تشرين الثاني"],
    ["12", "12 - كانون الأول"],
];

/**
 * المراجعة السريعة لقيود الصور: الصورة إلى جانب بنودها، وتأكيد وانتقال
 * إلى القيد التالي بضغطة واحدة، بلا فتح نموذج وإغلاقه لكل قيد.
 */
export class PhotoReview extends Component {
    static template = "my_accounting.PhotoReview";
    static components = { JournalPicker };
    static props = ["*"];

    setup() {
        this.orm = useService("orm");
        this.actionService = useService("action");
        this.notification = useService("notification");
        this.months = MONTHS;
        // مراجع خانات الترويسة: التصحيح بضغطة يحدّث ما تراه في الخانة أيضاً
        this.fieldRefs = {
            name: useRef("f_name"),
            date: useRef("f_date"),
            ledger_month: useRef("f_ledger_month"),
            ledger_year: useRef("f_ledger_year"),
        };
        this.state = useState({
            loading: true,
            entries: [],
            accounts: [],
            index: 0,
            saving: false,
            posted: 0,       // كم قيداً رُحّل في هذه الجلسة
            zoom: false,     // تكبير الصورة
        });
        onWillStart(() => this.load());
        useExternalListener(window, "keydown", (ev) => this.onKey(ev));
    }

    async load() {
        this.state.loading = true;
        const data = await this.orm.call("myaccounting.photo.entry", "get_review_queue", []);
        this.state.entries = data.entries;
        this.state.accounts = data.accounts;
        this.state.index = Math.min(this.state.index, Math.max(0, data.entries.length - 1));
        this.state.loading = false;
    }

    get entry() {
        return this.state.entries[this.state.index] || null;
    }

    get remaining() {
        return this.state.entries.length;
    }

    get position() {
        return this.remaining ? this.state.index + 1 : 0;
    }

    get imageUrl() {
        return this.entry
            ? `/web/image/myaccounting.photo.entry/${this.entry.id}/image`
            : "";
    }

    // المجاميع تُحسب في الشاشة مباشرة، فتتغيّر مع كل تعديل قبل الحفظ
    get totals() {
        const lines = this.entry ? this.entry.lines : [];
        const debit = lines.reduce((sum, line) => sum + (parseFloat(line.debit) || 0), 0);
        const credit = lines.reduce((sum, line) => sum + (parseFloat(line.credit) || 0), 0);
        return {
            debit,
            credit,
            difference: Math.round((debit - credit) * 1000) / 1000,
        };
    }

    get differenceText() {
        return Math.abs(this.totals.difference).toFixed(3);
    }

    get missingAccounts() {
        return this.entry ? this.entry.lines.filter((line) => !line.account_id).length : 0;
    }

    get canPost() {
        return !!this.entry && !this.totals.difference && !this.missingAccounts && !!this.entry.date;
    }

    accountLabel(id) {
        const account = this.state.accounts.find((acc) => acc.id === id);
        return account ? account.label : "";
    }

    // ------------------------------------------------------------------
    // التعديل
    // ------------------------------------------------------------------

    setHeader(field, value) {
        this.entry[field] = value;
    }

    // الفحوصات التلقائية: تصحيح بضغطة ثم إعادة الفحص من الخادم
    async applyFix(check) {
        this.setHeader(check.fix.field, check.fix.value);
        // الخانة المرسومة لا تتبع القيمة وحدها، فنحدّثها صراحةً
        const ref = this.fieldRefs[check.fix.field];
        if (ref && ref.el) {
            ref.el.value = check.fix.value;
        }
        await this.save(false);
        this.notification.add("صُحّح: " + check.fix.label, { type: "success" });
    }

    get blockingChecks() {
        return this.entry ? this.entry.checks.filter((check) => check.level === "danger") : [];
    }

    get warningChecks() {
        return this.entry ? this.entry.checks.filter((check) => check.level !== "danger") : [];
    }

    setLine(line, field, value) {
        line[field] = value;
        if (field === "account_id" && value) {
            line.uncertain = false;
        }
    }

    onAmount(line, field, ev) {
        const raw = ev.target.value.trim();
        line[field] = raw === "" ? 0 : parseFloat(raw) || 0;
        // صفر مكتوب بخط اليد له معنى محاسبي، فنحفظه كصفر مُدخل
        line[`${field}_zero_entered`] = raw === "0" || raw === "0.000";
    }

    removeLine(line) {
        const lines = this.entry.lines;
        lines.splice(lines.indexOf(line), 1);
    }

    addLine() {
        this.entry.lines.push({
            id: false,
            name: "",
            account_text: "",
            account_id: false,
            account_label: "",
            debit: 0,
            credit: 0,
            debit_zero_entered: false,
            credit_zero_entered: false,
            uncertain: false,
            uncertain_reason: "",
        });
    }

    onAccountInput(line, ev) {
        const label = ev.target.value;
        const account = this.state.accounts.find((acc) => acc.label === label);
        this.setLine(line, "account_id", account ? account.id : false);
        line.account_label = account ? account.label : label;
    }

    // ------------------------------------------------------------------
    // التنقل والحفظ والترحيل
    // ------------------------------------------------------------------

    go(step) {
        const next = this.state.index + step;
        if (next >= 0 && next < this.state.entries.length) {
            this.state.index = next;
            this.state.zoom = false;
        }
    }

    payload() {
        const entry = this.entry;
        return [
            [entry.id],
            {
                name: entry.name,
                date: entry.date,
                ref: entry.ref,
                journal: entry.journal,
                ledger_month: entry.ledger_month,
                ledger_year: entry.ledger_year,
            },
            entry.lines.map((line) => ({
                id: line.id || false,
                name: line.name,
                account_id: line.account_id,
                debit: parseFloat(line.debit) || 0,
                credit: parseFloat(line.credit) || 0,
                debit_zero_entered: line.debit_zero_entered,
                credit_zero_entered: line.credit_zero_entered,
                uncertain: line.uncertain,
            })),
        ];
    }

    async save(notify = true) {
        if (!this.entry || this.state.saving) {
            return;
        }
        this.state.saving = true;
        try {
            const updated = await this.orm.call(
                "myaccounting.photo.entry", "save_review", this.payload());
            Object.assign(this.entry, updated);
            if (notify) {
                this.notification.add("حُفظت التعديلات.", { type: "success" });
            }
        } finally {
            this.state.saving = false;
        }
    }

    /** تأكيد وترحيل ثم الانتقال إلى القيد التالي في الطابور */
    async postAndNext() {
        if (!this.entry || this.state.saving) {
            return;
        }
        this.state.saving = true;
        try {
            const result = await this.orm.call(
                "myaccounting.photo.entry", "post_review", this.payload());
            this.notification.add(`رُحّل القيد ${result.move || ""}`.trim(), { type: "success" });
            this.state.entries.splice(this.state.index, 1);
            this.state.posted += 1;
            if (this.state.index >= this.state.entries.length) {
                this.state.index = Math.max(0, this.state.entries.length - 1);
            }
            this.state.zoom = false;
        } catch (error) {
            this.notification.add(
                error.data?.message || error.message || "تعذّر ترحيل القيد.", { type: "danger" });
        } finally {
            this.state.saving = false;
        }
    }

    openForm() {
        this.actionService.doAction({
            type: "ir.actions.act_window",
            res_model: "myaccounting.photo.entry",
            res_id: this.entry.id,
            views: [[false, "form"]],
            target: "current",
        });
    }

    openList() {
        this.actionService.doAction("my_accounting.action_myaccounting_photo_entries");
    }

    // اختصارات: Ctrl+Enter ترحيل وانتقال، Ctrl+S حفظ، Alt+سهم تنقّل
    onKey(ev) {
        if (ev.ctrlKey && ev.key === "Enter") {
            ev.preventDefault();
            this.postAndNext();
        } else if (ev.ctrlKey && ev.key.toLowerCase() === "s") {
            ev.preventDefault();
            this.save();
        } else if (ev.altKey && (ev.key === "ArrowLeft" || ev.key === "ArrowRight")) {
            ev.preventDefault();
            this.go(ev.key === "ArrowLeft" ? 1 : -1);
        }
    }
}

registry.category("actions").add("my_accounting.photo_review", PhotoReview);
