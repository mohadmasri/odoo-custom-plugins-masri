/** @odoo-module **/

import { Component, onWillStart, useRef, useState } from "@odoo/owl";
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { MONTH_OPTIONS, monthName } from "./months";
import { registry } from "@web/core/registry";
import { router } from "@web/core/browser/router";
import { useService } from "@web/core/utils/hooks";
import { PeriodFilter } from "./period_filter";
import { RefPicker } from "./balance_sheet";
import { openRecord } from "./open_record";
import { usePrintPageSize } from "./print_page_size";

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

let uid = 0;

/** مفتاح ثابت لكل صف: الصفوف تُرشَّح بين التبويبات، فلا يصلح الفهرس مفتاحاً */
function keyed(items) {
    for (const item of items) {
        if (!item._k) {
            item._k = item.id ? `id${item.id}` : `new${++uid}`;
        }
    }
    return items;
}

function same(first, second) {
    return JSON.stringify(first) === JSON.stringify(second);
}

/**
 * الرواتب: كشف الشهر وبنوده، وبطاقات الموظفين، وإعدادات الحسابات والنِّسَب.
 */
export class Payroll extends Component {
    static template = "my_accounting.Payroll";
    static components = { PeriodFilter, RefPicker };
    static props = ["*"];

    setup() {
        this.orm = useService("orm");
        this.actionService = useService("action");
        this.dialog = useService("dialog");
        this.notification = useService("notification");
        this.printPage = usePrintPageSize("A4 landscape", "8mm");
        this.excelInput = useRef("excelInput");
        this.months = MONTH_OPTIONS;
        this.saved = { lines: [], settings: null, groups: [], card: null };
        const today = new Date();
        this.state = useState({
            loading: true,
            busy: false,
            tab: "sheet",
            data: null,
            employees: [],
            groups: [],
            finished: [],
            finishedId: false,
            years: [],
            year: `${today.getFullYear()}`,
            month: `${today.getMonth() + 1}`,
            card: null,
            cardDraft: null,
            excel: null,
            excelName: "",
            excelOptions: { edit: true, add: true, stop: true },
            allEmployees: false,
            search: "",
            onlyState: "all",
            onlySocial: "all",
            sheet: "all",
            monthSheet: "all",
            settings: null,
            accountOptions: [],
        });
        onWillStart(async () => {
            this.state.accountOptions = await this.orm.call(
                "myaccounting.bank.statement", "get_account_options", []);
            this.state.years = await this.orm.call("myaccounting.payroll",
                "get_years", []);
            await this.refresh();
            await this.loadSettings();
            await this.loadFinished();
            this.state.loading = false;
            // الرابط /odoo/action-.../<رقم> يفتح بطاقة ذلك الموظف وحدها
            await this.openCardFromUrl();
        });
    }

    /** كشف الشهر المختار في الفلتر، إن كان مبنيّاً */
    async refresh() {
        this.state.data = await this.orm.call("myaccounting.payroll", "get_month",
            [this.state.year, this.state.month]);
        this.saved.lines = clone(this.state.data ? this.state.data.lines : []);
        // كشف الشهر الجديد قد لا يحوي الكشف المختار، فنعود إلى عرض الكل
        if (this.state.monthSheet !== "all" && !this.visibleSections.length) {
            this.state.monthSheet = "all";
        }
    }

    async onPeriodChange({ year, month }) {
        await this.withBusy(async () => {
            this.state.year = `${year || this.state.year}`;
            this.state.month = `${month || this.state.month}`;
            this.state.monthSheet = "all";
            this.closeCard();
            await this.refresh();
        });
    }

    /** «تشرين الثاني 2026»: الاسم للعنوان، والرقم في الفلتر */
    get periodLabel() {
        return `${monthName(this.state.month)} ${this.state.year}`;
    }

    async loadFinished() {
        this.state.finished = await this.orm.call("myaccounting.payroll.group",
            "get_finished", []);
        if (!this.state.finished.some((item) => item.id === this.state.finishedId)) {
            this.state.finishedId = this.state.finished.length
                ? this.state.finished[0].id : false;
        }
    }

    async loadSettings() {
        const [employees, settings, groups] = await Promise.all([
            this.orm.call("myaccounting.employee", "get_employees", []),
            this.orm.call("myaccounting.payroll.settings", "get_settings", []),
            this.orm.call("myaccounting.payroll.group", "get_groups", []),
        ]);
        this.state.employees = keyed(employees);
        this.state.settings = settings;
        this.state.groups = keyed(groups);
        this.saved.settings = clone(settings);
        this.saved.groups = clone(this.state.groups);
        if (this.state.sheet !== "all" && this.state.sheet !== "none"
                && !groups.some((group) => group.id === this.state.sheet)) {
            this.state.sheet = "all";
        }
    }

    get data() {
        return this.state.data;
    }

    setTab(tab) {
        this.closeCard();
        this.closeExcel();
        this.state.tab = tab;
    }

    fmt(value) {
        let number = Number(value) || 0;
        if (Math.abs(number) < 0.0005) {
            number = 0;
        }
        return number.toLocaleString("en-US", {
            minimumFractionDigits: 3, maximumFractionDigits: 3,
        });
    }

    print() {
        this.printPage.enable();
        window.print();
    }

    async withBusy(action) {
        this.state.busy = true;
        try {
            await action();
        } catch (error) {
            this.notification.add(error.data?.message || "تعذّر التنفيذ.",
                { type: "danger" });
        } finally {
            this.state.busy = false;
        }
    }

    // ------------------------------------------------------------------
    // كشف الشهر
    // ------------------------------------------------------------------

    /** كشف الشهر المختار إن لم يكن مبنيّاً: يُنشأ ويُبنى من البطاقات */
    async buildMonth() {
        await this.withBusy(async () => {
            if (!this.state.data) {
                await this.orm.call("myaccounting.payroll", "create_payroll",
                    [this.state.year, this.state.month]);
                this.state.years = await this.orm.call("myaccounting.payroll",
                    "get_years", []);
            }
            await this.refresh();
            if (this.state.data) {
                this.state.data = await this.orm.call("myaccounting.payroll",
                    "fill_from_employees", [[this.state.data.id]]);
                this.saved.lines = clone(this.state.data.lines);
            }
            this.notification.add(`بُني كشف ${this.periodLabel} من البطاقات.`,
                { type: "success" });
        });
    }

    async fillFromEmployees() {
        await this.withBusy(async () => {
            this.state.data = await this.orm.call("myaccounting.payroll",
                "fill_from_employees", [[this.state.data.id]]);
            this.saved.lines = clone(this.state.data.lines);
        });
    }

    editLine(line, field, ev) {
        line[field] = parseFloat(ev.target.value) || 0;
        const gross = this.round(line.basic_salary + line.allowance);
        line.gross = gross;
        line.total_deduction = this.round(
            line.employee_social + line.income_tax + line.pension + line.other_deduction);
        line.net = this.round(gross - line.total_deduction);
    }

    round(value) {
        return Math.round((Number(value) || 0) * 1000) / 1000;
    }

    get linesDirty() {
        return !same(this.state.data ? this.state.data.lines : [], this.saved.lines);
    }

    async saveLines() {
        await this.withBusy(async () => {
            this.state.data = await this.orm.call("myaccounting.payroll", "save_lines",
                [this.state.data.id, clone(this.state.data.lines)]);
            this.saved.lines = clone(this.state.data.lines);
            this.notification.add("حُفظ.", { type: "success" });
        });
    }

    cancelLines() {
        this.state.data.lines = clone(this.saved.lines);
    }

    sumOf(lines) {
        const keys = ["basic_salary", "allowance", "gross", "social_base",
                      "employee_social", "employer_social", "income_tax", "pension",
                      "other_deduction", "total_deduction", "net"];
        const totals = {};
        for (const key of keys) {
            totals[key] = this.round(lines.reduce((sum, line) => sum + (line[key] || 0), 0));
        }
        return totals;
    }

    /** مجاميع الكشف محسوبةً على الشاشة، فتتحرّك مع التعديل قبل الحفظ */
    get totals() {
        return this.sumOf(this.state.data ? this.state.data.lines : []);
    }

    setMonthSheet(sheet) {
        this.state.monthSheet = sheet;
    }

    /** الكشف المعروض من الشهر: الكل أو واحد بعينه.

        وفي كل قسم «start»: عدد من قبله، فيتصل ترقيم الموظفين عبر الكشوف.
     */
    get visibleSections() {
        const sheet = this.state.monthSheet;
        const shown = sheet === "all" ? this.sheetSections
            : this.sheetSections.filter(
                (section) => section.key === (sheet === "none" ? "none" : `g${sheet}`));
        let start = 0;
        return shown.map((section) => {
            const numbered = Object.assign({}, section, { start });
            start += section.lines.length;
            return numbered;
        });
    }

    /** مجاميع ما هو معروض، فيطبع الكشف الواحد مجموعه هو */
    get visibleTotals() {
        return this.sumOf(this.visibleSections.flatMap((section) => section.lines));
    }

    get visibleCount() {
        return this.visibleSections.reduce(
            (sum, section) => sum + section.lines.length, 0);
    }

    get monthLabel() {
        const section = this.state.monthSheet === "all" ? null : this.visibleSections[0];
        return section ? section.name : "";
    }

    monthCountOf(id) {
        const section = this.sheetSections.find(
            (item) => item.key === (id === false ? "none" : `g${id}`));
        return section ? section.lines.length : 0;
    }

    /** بنود الشهر مقسومةً على الكشوف بترتيبها، وبلا كشف في آخرها */
    get sheetSections() {
        const lines = this.state.data ? this.state.data.lines : [];
        const order = this.state.groups.map((group) => group.id);
        const buckets = new Map();
        for (const line of lines) {
            const id = line.group_id || false;
            if (!buckets.has(id)) {
                buckets.set(id, []);
            }
            buckets.get(id).push(line);
        }
        const rank = (id) => {
            if (id === false) {
                return 9999;
            }
            const index = order.indexOf(id);
            return index < 0 ? 9998 : index;
        };
        return [...buckets.keys()].sort((a, b) => rank(a) - rank(b)).map((id) => {
            const group = this.state.groups.find((item) => item.id === id);
            return {
                key: id === false ? "none" : `g${id}`,
                sheet: id === false ? "none" : id,
                name: group ? group.name : "بلا كشف",
                lines: buckets.get(id),
            };
        });
    }

    /** اسم الزرّ: الكشف المختار بعينه، أو كشوف الشهر كلها */
    get postLabel() {
        const shown = this.visibleSections;
        if (shown.length === 1) {
            return `أنشئ قيد ${shown[0].name}`;
        }
        return `أنشئ قيود الكشوف (${shown.length})`;
    }

    /**
     * القيد يخرج من الكشف ولا يبقى موصولاً به: الصفحة لا تتتبّع قيوداً،
     * فالكشف يُعدَّل ويُحذف بعده، والقيد يبقى في الدفتر وحده.
     */
    postPayroll() {
        const label = this.postLabel;
        this.dialog.add(ConfirmationDialog, {
            title: label,
            body: "يُنشأ القيد مسودةً في الدفتر بلا صلةٍ بالكشف — فإن ضغطتَ"
                + " الزرّ مرّتين صار في الدفتر قيدان.",
            confirmLabel: "أنشئ",
            confirm: () => this.withBusy(async () => {
                const done = await this.orm.call("myaccounting.payroll",
                    "post_payroll", [[this.state.data.id], this.state.monthSheet]);
                await this.refresh();
                this.notification.add(`أُنشئ في الدفتر: ${done.moves.join("، ")}`,
                                      { type: "success" });
            }),
            cancel: () => {},
        });
    }

    deletePayroll() {
        const payroll = this.state.data;
        this.dialog.add(ConfirmationDialog, {
            title: `حذف "${payroll.name}"`,
            body: "سيُحذف كشف الشهر بكل بنوده، وتبقى قيوده في الدفتر كما هي.",
            confirmLabel: "احذف",
            confirm: () => this.withBusy(async () => {
                await this.orm.call("myaccounting.payroll", "delete_payroll",
                    [[payroll.id]]);
                this.state.years = await this.orm.call("myaccounting.payroll",
                    "get_years", []);
                await this.refresh();
            }),
            cancel: () => {},
        });
    }

    openMove(moveId, isMiddleClick) {
        if (moveId) {
            openRecord(this.actionService, "myaccounting.move", moveId, isMiddleClick);
        }
    }

    // ------------------------------------------------------------------
    // الموظفون
    // ------------------------------------------------------------------

    setSheet(sheet) {
        this.state.sheet = sheet;
    }

    /** بطاقات موظفي الشهر المختار، أو كل البطاقات إن طُلبت */
    get monthEmployees() {
        if (this.state.allEmployees || !this.state.data) {
            return this.state.employees;
        }
        const ids = new Set(this.state.data.lines.map((line) => line.employee_id));
        return this.state.employees.filter((employee) => ids.has(employee.id));
    }

    /**
     * بطاقات الموظفين المعروضة: بعد الشهر والكشف والبحث والفلاتر.
     * والكل يعمل معاً، فتُقرأ النتيجة في عدّاد البطاقات فوق الشبكة.
     */
    get visibleEmployees() {
        const sheet = this.state.sheet;
        const text = this.state.search.trim();
        let shown = this.monthEmployees;
        if (sheet === "none") {
            shown = shown.filter((employee) => !employee.group_id);
        } else if (sheet !== "all") {
            shown = shown.filter((employee) => employee.group_id === sheet);
        }
        if (this.state.onlyState !== "all") {
            const wanted = this.state.onlyState === "active";
            shown = shown.filter((employee) => !!employee.active === wanted);
        }
        if (this.state.onlySocial !== "all") {
            const wanted = this.state.onlySocial === "yes";
            shown = shown.filter(
                (employee) => !!employee.social_security === wanted);
        }
        if (text) {
            shown = shown.filter((employee) => [
                employee.name, employee.job_title, employee.group,
                employee.national_id, employee.phone,
            ].some((field) => (field || "").includes(text)));
        }
        return shown;
    }

    onSearch(ev) {
        this.state.search = ev.target.value;
    }

    setFilter(field, value) {
        this.state[field] = value;
    }

    get stateFilters() {
        return [["all", "الكل"], ["active", "على رأس العمل"], ["stopped", "موقوف"]];
    }

    get socialFilters() {
        return [["all", "الكل"], ["yes", "مشمول بالضمان"], ["no", "غير مشمول"]];
    }

    /** ما يُكتب على البطاقة: المشروع وحاله */
    groupOf(employee) {
        const group = this.state.groups.find(
            (item) => item.id === employee.group_id);
        return group || null;
    }

    deleteEmployee(employee) {
        this.dialog.add(ConfirmationDialog, {
            title: `حذف بطاقة "${employee.name}"`,
            body: "تُحذف البطاقة نفسها. ومن دخل كشف رواتبٍ لا تُحذف بطاقته،"
                + " فأوقِفه من بطاقته بدلاً من ذلك.",
            confirmLabel: "احذف",
            confirm: () => this.withBusy(async () => {
                await this.orm.call("myaccounting.employee", "delete_employee",
                    [employee.id]);
                await this.loadSettings();
                this.notification.add("حُذفت البطاقة.", { type: "success" });
            }),
            cancel: () => {},
        });
    }

    toggleAllEmployees() {
        this.state.allEmployees = !this.state.allEmployees;
        this.state.sheet = "all";
    }

    /** الكشوف الفعّالة، ومعها المؤرشف الذي ما زال فيه موظفون */
    get liveGroups() {
        return this.state.groups.filter(
            (group) => group.active || this.countOf(group.id));
    }

    /** أرشيف الكشوف: مشاريع انتهت، تبقى بموظفيها وحساباتها */
    get archivedGroups() {
        return this.state.groups.filter((group) => !group.active);
    }

    get activeGroups() {
        return this.state.groups.filter((group) => group.active);
    }

    toggleGroupArchive(group) {
        group.active = !group.active;
    }

    get currentGroup() {
        return this.state.groups.find((group) => group.id === this.state.sheet) || null;
    }

    countOf(groupId) {
        return this.monthEmployees.filter(
            (employee) => (employee.group_id || false) === groupId).length;
    }

    /** مجاميع البطاقات المعروضة */
    get employeeTotals() {
        const keys = ["basic_salary", "allowance", "social_base", "income_tax",
                      "pension", "other_deduction"];
        const totals = {};
        for (const key of keys) {
            totals[key] = this.round(this.visibleEmployees.reduce(
                (sum, employee) => sum + (employee[key] || 0), 0));
        }
        return totals;
    }

    /** خيارات الكشوف للاختيار: المحفوظة منها فقط، فهي وحدها لها معرّف */
    get groupOptions() {
        return this.state.groups
            .filter((group) => group.id && group.active)
            .map((group) => ({ token: `${group.id}`, display: group.name, hint: "" }));
    }

    /** الموظف الجديد يُدخل من بطاقته لا من سطرٍ في الجدول */
    async newEmployeeCard() {
        const group = this.currentGroup;
        await this.withBusy(async () => {
            const card = await this.orm.call("myaccounting.employee",
                "new_employee_card",
                [group ? group.id : false, 10 * (this.state.employees.length + 1)]);
            this.setCard(card);
        });
    }

    // ------------------------------------------------------------------
    // الكشوف
    // ------------------------------------------------------------------

    get groupsDirty() {
        return !same(this.state.groups, this.saved.groups);
    }

    editGroup(group, field, ev) {
        group[field] = field === "sequence"
            ? parseInt(ev.target.value, 10) || 0
            : ev.target.value;
    }

    groupAccountToken(group) {
        return group.account_id ? `${group.account_id}` : "";
    }

    onGroupAccount(group, token) {
        const id = parseInt(token, 10) || false;
        group.account_id = id;
        group.account = this.accountName(id);
    }

    groupPaymentToken(group) {
        return group.payment_account_id ? `${group.payment_account_id}` : "";
    }

    onGroupPayment(group, token) {
        const id = parseInt(token, 10) || false;
        group.payment_account_id = id;
        group.payment_account = this.accountName(id);
    }

    accountName(id) {
        const found = this.state.accountOptions.find((item) => item.token === `${id}`);
        return found ? found.display : "";
    }

    addGroup() {
        this.state.groups.push(keyed([{
            id: false, name: "كشف جديد", sequence: 10 * (this.state.groups.length + 1),
            account_id: false, account: "", payment_account_id: false,
            payment_account: "", journal: "", active: true, count: 0,
        }])[0]);
    }

    removeGroup(group) {
        const index = this.state.groups.indexOf(group);
        if (index >= 0) {
            this.state.groups.splice(index, 1);
        }
    }

    async saveGroups() {
        await this.withBusy(async () => {
            await this.orm.call("myaccounting.payroll.group", "save_groups",
                [clone(this.state.groups)]);
            await this.loadSettings();
            this.notification.add("حُفظت الكشوف.", { type: "success" });
        });
    }

    cancelGroups() {
        this.state.groups = clone(this.saved.groups);
    }

    // ------------------------------------------------------------------
    // رفع كشف إكسل: يعدّل البطاقات، والكشف يُبنى منها
    // ------------------------------------------------------------------

    pickExcel() {
        this.excelInput.el.click();
    }

    async onExcelFile(ev) {
        const file = ev.target.files && ev.target.files[0];
        ev.target.value = "";
        if (!file) {
            return;
        }
        const content = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result.split(",")[1]);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
        });
        await this.withBusy(async () => {
            const plan = await this.orm.call("myaccounting.employee",
                "preview_excel", [content]);
            this.excelContent = content;
            this.state.excelName = file.name;
            this.state.excel = plan;
            // شهر الملف من ترويسة أوراقه، ويبقى قابلاً للتعديل قبل الموافقة
            this.state.excelMonth = plan.month ? `${plan.month}` : this.state.month;
            this.state.excelYear = plan.year ? `${plan.year}` : this.state.year;
        });
    }

    closeExcel() {
        this.state.excel = null;
        this.excelContent = null;
    }

    toggleExcel(option, ev) {
        this.state.excelOptions[option] = ev.target.checked;
    }

    get excelCount() {
        const plan = this.state.excel;
        const options = this.state.excelOptions;
        return (options.edit ? plan.changed.length : 0)
             + (options.add ? plan.new.length : 0)
             + (options.stop ? plan.stop.length : 0)
             + (options.archive ? plan.archive.length : 0);
    }

    onExcelPeriod(field, ev) {
        this.state[field] = ev.target.value;
    }

    /** الموافقة: تُطبَّق على البطاقات ثم يُبنى كشف الشهر منها */
    async applyExcel() {
        await this.withBusy(async () => {
            const result = await this.orm.call("myaccounting.payroll",
                "apply_sheet_file",
                [this.excelContent, { ...this.state.excelOptions },
                    this.state.excelYear, this.state.excelMonth]);
            const done = result.applied;
            this.state.year = `${this.state.excelYear}`;
            this.state.month = `${this.state.excelMonth}`;
            this.closeExcel();
            this.state.tab = "sheet";
            this.state.monthSheet = "all";
            this.state.years = await this.orm.call("myaccounting.payroll",
                "get_years", []);
            await this.loadSettings();
            await this.loadFinished();
            await this.refresh();
            const parts = [];
            if (done.edited) {
                parts.push(`عُدِّلت ${done.edited} بطاقة`);
            }
            if (done.added) {
                parts.push(`أُضيفت ${done.added}`);
            }
            if (done.stopped) {
                parts.push(`أُوقفت ${done.stopped}`);
            }
            if (done.groups.length) {
                parts.push(`واستجدّ كشف ${done.groups.join("، ")}`);
            }
            if (done.archived.length) {
                parts.push(`وانتهى مشروع ${done.archived.join("، ")}`);
            }
            if (done.revived.length) {
                parts.push(`وعاد ${done.revived.join("، ")}`);
            }
            parts.push(`وبُني كشف ${this.periodLabel}`);
            this.notification.add(parts.join(" · "), { type: "success" });
        });
    }

    // ------------------------------------------------------------------
    // بطاقة الموظف
    // ------------------------------------------------------------------

    /** بيانات الموظف الشخصية والوظيفية */
    get cardFields() {
        return [
            { name: "name", label: "الاسم", type: "text" },
            { name: "job_title", label: "المسمّى الوظيفي", type: "text" },
            { name: "hire_date", label: "تاريخ التعيين", type: "date" },
            { name: "national_id", label: "الرقم الوطني", type: "text" },
            { name: "social_number", label: "رقم الضمان", type: "text" },
            { name: "phone", label: "الهاتف", type: "text" },
            { name: "address", label: "العنوان", type: "text" },
            { name: "note", label: "ملاحظة", type: "text" },
        ];
    }

    /** مكوّنات راتبه الشهري، تُعدَّل من البطاقة كما تُعدَّل من الجدول */
    get cardMoneyFields() {
        return [
            { name: "basic_salary", label: "الراتب الأساسي" },
            { name: "allowance", label: "العلاوات" },
            { name: "social_base", label: "الخاضع للضمان" },
            { name: "income_tax", label: "ضريبة الدخل" },
            { name: "pension", label: "صندوق التقاعد" },
            { name: "other_deduction", label: "استقطاعات أخرى" },
        ];
    }

    get cardNumbers() {
        return [...this.cardMoneyFields.map((field) => field.name), "sequence"];
    }

    get cardFlags() {
        return ["social_security", "active"];
    }

    get cardTitle() {
        return this.state.card.employee.id
            ? this.state.card.employee.name
            : "بطاقة موظف جديد";
    }

    /** الراتب محسوباً على الشاشة، فيتحرّك مع التعديل قبل الحفظ */
    get cardGross() {
        const draft = this.state.cardDraft;
        return this.round((draft.basic_salary || 0) + (draft.allowance || 0));
    }

    get cardBase() {
        const draft = this.state.cardDraft;
        if (!draft.social_security) {
            return 0;
        }
        return draft.social_base || this.cardGross;
    }

    get cardSocial() {
        const rate = this.state.settings ? this.state.settings.employee_rate : 0;
        return this.round((this.cardBase * rate) / 100);
    }

    get cardNet() {
        const draft = this.state.cardDraft;
        return this.round(this.cardGross - this.cardSocial - (draft.income_tax || 0)
                          - (draft.pension || 0) - (draft.other_deduction || 0));
    }

    get cardGroupToken() {
        return this.state.cardDraft.group_id ? `${this.state.cardDraft.group_id}` : "";
    }

    onCardGroup(token) {
        this.state.cardDraft.group_id = parseInt(token, 10) || false;
    }

    get cardAccountToken() {
        return this.state.cardDraft.account_id ? `${this.state.cardDraft.account_id}` : "";
    }

    onCardAccount(token) {
        this.state.cardDraft.account_id = parseInt(token, 10) || false;
    }

    get cardPaymentToken() {
        return this.state.cardDraft.payment_account_id
            ? `${this.state.cardDraft.payment_account_id}` : "";
    }

    onCardPayment(token) {
        this.state.cardDraft.payment_account_id = parseInt(token, 10) || false;
    }

    /** الفارغ يرث حساب كشفه، فنُظهر في الحقل ما سيورثه */
    get cardGroupAccount() {
        const group = this.state.groups.find(
            (item) => item.id === this.state.cardDraft.group_id);
        return (group && group.account) || "حساب الرواتب العام";
    }

    get cardGroupPayment() {
        const group = this.state.groups.find(
            (item) => item.id === this.state.cardDraft.group_id);
        return (group && group.payment_account) || "حساب الدفع العام";
    }

    /** بطاقة الرابط: ما فُتح في تبويبٍ جديد يُظهر صاحبه لا الجدول */
    get yearOptions() {
        return this.state.years.length ? this.state.years
                                       : [Number(this.state.year)];
    }

    async openCardFromUrl() {
        const employeeId = router.current.resId;
        if (!employeeId || !this.state.employees.some(
                (employee) => employee.id === employeeId)) {
            return;
        }
        this.state.tab = "employees";
        await this.openCard({ id: employeeId });
    }

    /** رابط البطاقة: /odoo/action-.../<رقم الموظف>، يفتحها وحدها */
    cardHref(employeeId) {
        return router.stateToUrl({
            action: "my_accounting.action_myaccounting_payroll",
            resId: employeeId,
        });
    }

    async openCard(employee, isMiddleClick) {
        if (!employee.id) {
            this.notification.add("احفظ الموظف الجديد قبل فتح بطاقته.",
                                  { type: "warning" });
            return;
        }
        if (isMiddleClick) {
            // الزرّ الأوسط (أو Ctrl + نقر): تبويب جديد من المتصفح
            window.open(this.cardHref(employee.id), "_blank", "noopener");
            return;
        }
        await this.withBusy(async () => {
            const card = await this.orm.call("myaccounting.employee",
                "get_employee_card", [employee.id]);
            this.setCard(card);
        });
    }

    setCard(card) {
        this.state.card = card;
        const draft = {};
        for (const field of this.cardFields) {
            draft[field.name] = card.employee[field.name] || "";
        }
        for (const name of this.cardNumbers) {
            draft[name] = card.employee[name] || 0;
        }
        for (const name of this.cardFlags) {
            draft[name] = !!card.employee[name];
        }
        draft.payment_method = card.employee.payment_method || "transfer";
        draft.group_id = card.employee.group_id || false;
        draft.account_id = card.employee.account_id || false;
        draft.payment_account_id = card.employee.payment_account_id || false;
        this.state.cardDraft = draft;
        this.saved.card = clone(draft);
    }

    closeCard() {
        this.state.card = null;
        this.state.cardDraft = null;
    }

    editCard(field, ev) {
        if (this.cardNumbers.includes(field)) {
            this.state.cardDraft[field] = field === "sequence"
                ? parseInt(ev.target.value, 10) || 0
                : parseFloat(ev.target.value) || 0;
        } else if (this.cardFlags.includes(field)) {
            this.state.cardDraft[field] = ev.target.checked;
        } else {
            this.state.cardDraft[field] = ev.target.value;
        }
    }

    get cardDirty() {
        return !!this.state.cardDraft && !same(this.state.cardDraft, this.saved.card);
    }

    async saveCard() {
        await this.withBusy(async () => {
            const isNew = !this.state.card.employee.id;
            const card = await this.orm.call("myaccounting.employee",
                "save_employee_card",
                [this.state.card.employee.id, clone(this.state.cardDraft)]);
            this.setCard(card);
            // الجدول يحمل بيانات البطاقة نفسها، فيُحدَّث معها
            await this.loadSettings();
            this.notification.add(isNew ? "أُضيف الموظف." : "حُفظت البطاقة.",
                                  { type: "success" });
        });
    }

    cancelCard() {
        this.state.cardDraft = clone(this.saved.card);
    }

    // ------------------------------------------------------------------
    // المشاريع المنتهية
    // ------------------------------------------------------------------

    get finishedProject() {
        return this.state.finished.find(
            (item) => item.id === this.state.finishedId) || null;
    }

    setFinished(id) {
        this.state.finishedId = id;
    }

    monthTotals(month) {
        return this.sumOf(month.lines);
    }

    async reviveProject(project) {
        await this.withBusy(async () => {
            const groups = clone(this.state.groups);
            const group = groups.find((item) => item.id === project.id);
            if (group) {
                group.active = true;
                await this.orm.call("myaccounting.payroll.group", "save_groups",
                    [groups]);
            }
            await this.loadSettings();
            await this.loadFinished();
            this.notification.add(`عاد كشف ${project.name}.`, { type: "success" });
        });
    }

    // ------------------------------------------------------------------
    // الإعدادات
    // ------------------------------------------------------------------

    get settingsDirty() {
        return !same(this.state.settings, this.saved.settings);
    }

    editRate(field, ev) {
        this.state.settings[field] = parseFloat(ev.target.value) || 0;
    }

    onSettingAccount(entry, token) {
        entry.id = parseInt(token, 10) || false;
    }

    settingToken(entry) {
        return entry.id ? `${entry.id}` : "";
    }

    async saveSettings() {
        await this.withBusy(async () => {
            const values = {
                employee_rate: this.state.settings.employee_rate,
                employer_rate: this.state.settings.employer_rate,
            };
            for (const entry of this.state.settings.accounts) {
                values[entry.field] = entry.id;
            }
            await this.orm.call("myaccounting.payroll.settings", "save_settings", [values]);
            await this.loadSettings();
            this.notification.add("حُفظت الإعدادات.", { type: "success" });
        });
    }

    cancelSettings() {
        this.state.settings = clone(this.saved.settings);
    }
}

registry.category("actions").add("my_accounting.payroll", Payroll);
