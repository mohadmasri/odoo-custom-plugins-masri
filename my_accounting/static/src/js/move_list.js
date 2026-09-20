/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { useSetupAction } from "@web/search/action_hook";
import { JournalImportDialog } from "./journal_import_dialog";

const STATE_LABELS = { draft: "مسودة", incomplete: "غير مكتمل", posted: "مرحّل" };

// الفلاتر والترتيب التي تُحفظ عند فتح قيد وتُستعاد عند الرجوع إلى القائمة
const KEPT_STATE_FIELDS = [
    "name", "ref", "account", "dateFrom", "dateTo",
    "stateFilters", "balanceFilter", "ledgerMonth", "ledgerYear",
    "sortField", "sortDir",
];

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
        // عند الرجوع من قيد إلى القائمة يعيد أودو الحالة المحفوظة في props.state
        const restored = (this.props.state && this.props.state.moveListFilters) || {};
        this.state = useState({
            records: [],
            name: "",
            ref: "",
            account: "",
            dateFrom: "",
            dateTo: "",
            stateFilters: [],
            balanceFilter: "",
            ledgerMonth: "",
            ledgerYear: "",
            selected: {},
            sortField: "",
            sortDir: "asc",
            exporting: false,
            ...restored,
        });
        // تُستدعى قبل مغادرة القائمة (مثلاً عند فتح قيد) فتُحفظ الفلاتر والترتيب
        useSetupAction({
            getLocalState: () => ({
                moveListFilters: Object.fromEntries(
                    KEPT_STATE_FIELDS.map((field) => [field, this.state[field]])
                ),
            }),
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
        if (this.state.stateFilters.length) {
            domain.push(["state", "in", this.state.stateFilters]);
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
            ["name", "date", "ref", "journal", "total_debit", "total_credit", "state",
             "ledger_period_label", "ledger_month", "ledger_year", "has_import_notes"],
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

    isStateActive(value) {
        return this.state.stateFilters.includes(value);
    }

    // كل حالة زر مستقل: الضغط يفعّلها، والضغط عليها وهي مفعّلة يلغيها،
    // ويمكن تفعيل أكثر من حالة معاً.
    onStateFilter(value) {
        this.state.stateFilters = this.isStateActive(value)
            ? this.state.stateFilters.filter((v) => v !== value)
            : [...this.state.stateFilters, value];
        this.loadData();
    }

    // الضغط على عنوان عمود: أول مرة ترتيب تصاعدي، ثم يتبدّل بين تصاعدي وتنازلي
    onSort(field) {
        if (this.state.sortField === field) {
            this.state.sortDir = this.state.sortDir === "asc" ? "desc" : "asc";
        } else {
            this.state.sortField = field;
            this.state.sortDir = "asc";
        }
    }

    clearSort() {
        this.state.sortField = "";
        this.state.sortDir = "asc";
    }

    sortIcon(field) {
        if (this.state.sortField !== field) {
            return "fa-sort text-muted opacity-50";
        }
        return this.state.sortDir === "asc" ? "fa-sort-asc" : "fa-sort-desc";
    }

    // الترتيب يتم في المتصفح لأن كل القيود محمّلة أصلاً، وهذا يسمح بترتيب
    // طبيعي لأرقام القيود ("2" قبل "10") والشهر المحاسبي حسب السنة ثم الشهر.
    get sortedRecords() {
        const { sortField, sortDir } = this.state;
        if (!sortField) {
            return this.state.records;
        }
        const collator = new Intl.Collator("ar", { numeric: true, sensitivity: "base" });
        const stateOrder = { draft: 0, incomplete: 1, posted: 2 };
        const keyOf = (rec) => {
            switch (sortField) {
                case "ledger_period":
                    return (rec.ledger_year || 0) * 100 + parseInt(rec.ledger_month || 0, 10);
                case "state":
                    return stateOrder[rec.state] ?? 99;
                case "total_debit":
                case "total_credit":
                    return rec[sortField] || 0;
                default:
                    return rec[sortField] || "";
            }
        };
        const factor = sortDir === "asc" ? 1 : -1;
        return [...this.state.records].sort((a, b) => {
            const ka = keyOf(a);
            const kb = keyOf(b);
            const cmp = typeof ka === "number" && typeof kb === "number"
                ? ka - kb
                : collator.compare(String(ka), String(kb));
            return cmp * factor || (b.id - a.id);
        });
    }

    onBalanceFilter(value) {
        this.state.balanceFilter = this.state.balanceFilter === value ? "" : value;
        this.loadData();
    }

    get currentYear() {
        return new Date().getFullYear();
    }

    // أزرار الأشهر 1..12 للسنة الحالية: الوصول لشهر محاسبي بضغطة واحدة
    get monthButtons() {
        return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    }

    isMonthActive(month) {
        return this.state.ledgerMonth === String(month) &&
            this.state.ledgerYear === String(this.currentYear);
    }

    // الضغط على الشهر يفعّل الفلتر، والضغط عليه وهو مفعّل يلغيه
    onMonthButton(month) {
        if (this.isMonthActive(month)) {
            this.state.ledgerMonth = "";
            this.state.ledgerYear = "";
        } else {
            this.state.ledgerMonth = String(month);
            this.state.ledgerYear = String(this.currentYear);
        }
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
            stateFilters: [],
            balanceFilter: "",
            ledgerMonth: "",
            ledgerYear: "",
        });
        this.loadData();
    }

    openMove(id) {
        // نمرّر قائمة القيود المعروضة (بنفس ترتيبها وفلاترها) حتى تعمل أسهم
        // التنقل بين القيود داخل نموذج القيد.
        this.actionService.doAction(
            {
                type: "ir.actions.act_window",
                res_model: "myaccounting.move",
                res_id: id,
                views: [[false, "form"]],
                target: "current",
            },
            { props: { resIds: this.sortedRecords.map((rec) => rec.id) } }
        );
    }

    createMove() {
        this.actionService.doAction({
            type: "ir.actions.act_window",
            res_model: "myaccounting.move",
            views: [[false, "form"]],
            target: "current",
        });
    }

    openImportDialog() {
        this.dialogService.add(JournalImportDialog, {
            onImported: () => this.loadData(),
        });
    }

    // تصدير القيود الظاهرة حالياً (بعد الفلاتر) وبنفس ترتيب الجدول، إلى ملف
    // Excel بنفس قالب الاستيراد ليمكن تعديله وإعادة رفعه.
    async exportToExcel() {
        const records = this.sortedRecords;
        if (!records.length) {
            this.notification.add("لا توجد قيود للتصدير.", { type: "warning" });
            return;
        }
        this.state.exporting = true;
        try {
            const fileBase64 = await this.orm.call(
                "myaccounting.move", "export_moves_to_xlsx", [records.map((rec) => rec.id)]);
            const bytes = Uint8Array.from(atob(fileBase64), (char) => char.charCodeAt(0));
            const url = URL.createObjectURL(new Blob([bytes], {
                type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            }));
            const today = new Date().toISOString().slice(0, 10);
            const link = document.createElement("a");
            link.href = url;
            link.download = `القيود المحاسبية ${today}.xlsx`;
            link.click();
            URL.revokeObjectURL(url);
            this.notification.add(`تم تصدير ${records.length} قيد.`, { type: "success" });
        } finally {
            this.state.exporting = false;
        }
    }
}

registry.category("actions").add("my_accounting.move_list", MoveList);
