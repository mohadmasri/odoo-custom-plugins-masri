/** @odoo-module **/

import { Component, onWillStart, useState } from "@odoo/owl";
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { RefPicker } from "./balance_sheet";
import { openRecord } from "./open_record";
import { usePrintPageSize } from "./print_page_size";

const MONTHS = [
    ["1", "كانون الثاني"], ["2", "شباط"], ["3", "آذار"], ["4", "نيسان"],
    ["5", "أيار"], ["6", "حزيران"], ["7", "تموز"], ["8", "آب"],
    ["9", "أيلول"], ["10", "تشرين الأول"], ["11", "تشرين الثاني"], ["12", "كانون الأول"],
];

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
    static components = { RefPicker };
    static props = ["*"];

    setup() {
        this.orm = useService("orm");
        this.actionService = useService("action");
        this.dialog = useService("dialog");
        this.notification = useService("notification");
        this.printPage = usePrintPageSize("A4 landscape", "8mm");
        this.months = MONTHS;
        this.saved = { employees: [], lines: [], settings: null, groups: [] };
        const today = new Date();
        this.state = useState({
            loading: true,
            busy: false,
            tab: "sheet",
            payrolls: [],
            data: null,
            employees: [],
            groups: [],
            sheet: "all",
            monthSheet: "all",
            settings: null,
            accountOptions: [],
            newYear: `${today.getFullYear()}`,
            newMonth: `${today.getMonth() + 1}`,
        });
        onWillStart(async () => {
            this.state.accountOptions = await this.orm.call(
                "myaccounting.bank.statement", "get_account_options", []);
            await this.refresh();
            await this.loadSettings();
            this.state.loading = false;
        });
    }

    async refresh(payrollId) {
        const [payrolls, data] = await Promise.all([
            this.orm.call("myaccounting.payroll", "get_payrolls", []),
            this.orm.call("myaccounting.payroll", "get_payroll", [payrollId || false]),
        ]);
        this.state.payrolls = payrolls;
        this.state.data = data || null;
        this.saved.lines = data ? clone(data.lines) : [];
        // كشف الشهر الجديد قد لا يحوي الكشف المختار، فنعود إلى عرض الكل
        if (this.state.monthSheet !== "all" && !this.visibleSections.length) {
            this.state.monthSheet = "all";
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
        this.saved.employees = clone(this.state.employees);
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

    isPayroll(id) {
        return this.state.data && this.state.data.id === id;
    }

    async openPayroll(ev) {
        const id = parseInt(ev.target.value, 10);
        if (id) {
            await this.refresh(id);
        }
    }

    onNew(field, ev) {
        this.state[field] = ev.target.value;
    }

    async createPayroll() {
        await this.withBusy(async () => {
            const id = await this.orm.call("myaccounting.payroll", "create_payroll",
                [this.state.newYear, this.state.newMonth]);
            await this.refresh(id);
            this.notification.add("أُنشئ كشف الشهر من بطاقات الموظفين.",
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

    /** الكشف المعروض من الشهر: الكل أو واحد بعينه */
    get visibleSections() {
        const sheet = this.state.monthSheet;
        if (sheet === "all") {
            return this.sheetSections;
        }
        return this.sheetSections.filter(
            (section) => section.key === (sheet === "none" ? "none" : `g${sheet}`));
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

    monthPostedOf(id) {
        const section = this.sheetSections.find(
            (item) => item.key === (id === false ? "none" : `g${id}`));
        return section ? section.posted : false;
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
        const sheets = this.state.data ? this.state.data.sheets || [] : [];
        return [...buckets.keys()].sort((a, b) => rank(a) - rank(b)).map((id) => {
            const group = this.state.groups.find((item) => item.id === id);
            const own = buckets.get(id);
            // حالة القيد تأتي من الخادم: لكل كشف قيده أو لا قيد له
            const sheet = sheets.find((item) => (item.id || false) === id) || {};
            return {
                key: id === false ? "none" : `g${id}`,
                sheet: id === false ? "none" : id,
                name: group ? group.name : "بلا كشف",
                lines: own,
                totals: this.sumOf(own),
                posted: !!sheet.posted,
                move: sheet.move || "",
                move_id: sheet.move_id || false,
            };
        });
    }

    /** الكشوف المعروضة التي لم تُرحَّل بعد */
    get toPost() {
        return this.visibleSections.filter((section) => !section.posted);
    }

    /** الكشوف المعروضة المُرحَّلة */
    get posted() {
        return this.visibleSections.filter((section) => section.posted);
    }

    /** اسم الزرّ: الكشف المختار بعينه، أو عدد ما بقي عند «عرض الكل» */
    get postLabel() {
        const todo = this.toPost;
        if (todo.length === 1) {
            return `أنشئ قيد ${todo[0].name}`;
        }
        return `أنشئ قيود الكشوف (${todo.length})`;
    }

    get unpostLabel() {
        const done = this.posted;
        if (done.length === 1) {
            return `فكّ ترحيل ${done[0].name}`;
        }
        return `فكّ ترحيل الكشوف (${done.length})`;
    }

    async postPayroll() {
        await this.withBusy(async () => {
            const count = this.toPost.length;
            this.state.data = await this.orm.call("myaccounting.payroll", "post_payroll",
                [[this.state.data.id], this.state.monthSheet]);
            await this.refresh(this.state.data.id);
            this.notification.add(count === 1 ? "أُنشئ قيد الكشف مسودةً."
                                              : `أُنشئت ${count} قيود مسودةً.`,
                                  { type: "success" });
        });
    }

    unpostPayroll() {
        const done = this.posted;
        const what = done.length === 1 ? `قيد ${done[0].name}` : `${done.length} قيود`;
        this.dialog.add(ConfirmationDialog, {
            title: "فكّ الترحيل",
            body: `سيُحذف ${what} ما دام مسودةً، ويعود الكشف قابلاً للتعديل.`,
            confirmLabel: "نعم",
            confirm: () => this.withBusy(async () => {
                this.state.data = await this.orm.call("myaccounting.payroll",
                    "unpost_payroll", [[this.state.data.id], this.state.monthSheet]);
                await this.refresh(this.state.data.id);
            }),
            cancel: () => {},
        });
    }

    deletePayroll() {
        const payroll = this.state.data;
        this.dialog.add(ConfirmationDialog, {
            title: `حذف "${payroll.name}"`,
            body: "سيُحذف كشف الشهر بكل بنوده.",
            confirmLabel: "احذف",
            confirm: () => this.withBusy(async () => {
                await this.orm.call("myaccounting.payroll", "delete_payroll",
                    [[payroll.id]]);
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

    get employeesDirty() {
        return !same(this.state.employees, this.saved.employees);
    }

    editEmployee(employee, field, ev) {
        const numbers = ["sequence", "basic_salary", "allowance", "social_base",
                         "income_tax", "pension", "other_deduction"];
        if (numbers.includes(field)) {
            employee[field] = field === "sequence"
                ? parseInt(ev.target.value, 10) || 0
                : parseFloat(ev.target.value) || 0;
        } else if (field === "social_security" || field === "active") {
            employee[field] = ev.target.checked;
        } else {
            employee[field] = ev.target.value;
        }
        employee.gross = this.round(employee.basic_salary + employee.allowance);
    }

    setSheet(sheet) {
        this.state.sheet = sheet;
    }

    /** موظفو الكشف المعروض: «عرض الكل» أو كشفٌ بعينه أو بلا كشف */
    get visibleEmployees() {
        const sheet = this.state.sheet;
        if (sheet === "all") {
            return this.state.employees;
        }
        if (sheet === "none") {
            return this.state.employees.filter((employee) => !employee.group_id);
        }
        return this.state.employees.filter((employee) => employee.group_id === sheet);
    }

    get currentGroup() {
        return this.state.groups.find((group) => group.id === this.state.sheet) || null;
    }

    countOf(groupId) {
        return this.state.employees.filter(
            (employee) => (employee.group_id || false) === groupId).length;
    }

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
            .filter((group) => group.id)
            .map((group) => ({ token: `${group.id}`, display: group.name, hint: "" }));
    }

    groupToken(employee) {
        return employee.group_id ? `${employee.group_id}` : "";
    }

    onEmployeeGroup(employee, token) {
        employee.group_id = parseInt(token, 10) || false;
    }

    /** الفارغ يرث حساب كشفه، فنُظهر في الحقل ما سيورثه */
    placeholderAccount(employee) {
        const group = this.state.groups.find((item) => item.id === employee.group_id);
        return (group && group.account) || "حساب الرواتب العام";
    }

    placeholderPayment(employee) {
        const group = this.state.groups.find((item) => item.id === employee.group_id);
        return (group && group.payment_account) || "حساب الدفع العام";
    }

    onEmployeeAccount(employee, token) {
        employee.account_id = parseInt(token, 10) || false;
    }

    accountToken(employee) {
        return employee.account_id ? `${employee.account_id}` : "";
    }

    onEmployeePayment(employee, token) {
        employee.payment_account_id = parseInt(token, 10) || false;
    }

    paymentToken(employee) {
        return employee.payment_account_id ? `${employee.payment_account_id}` : "";
    }

    addEmployee() {
        const group = this.currentGroup;
        this.state.employees.push(keyed([{
            id: false, name: "موظف جديد", sequence: 10 * (this.state.employees.length + 1),
            group_id: group ? group.id : false, group: group ? group.name : "",
            job_title: "", hire_date: "", active: true, basic_salary: 0, allowance: 0,
            gross: 0, social_security: true, social_base: 0, income_tax: 0,
            pension: 0, other_deduction: 0, account_id: false, account: "",
            payment_account_id: false, payment_account: "", note: "",
        }])[0]);
    }

    removeEmployee(employee) {
        const index = this.state.employees.indexOf(employee);
        if (index >= 0) {
            this.state.employees.splice(index, 1);
        }
    }

    async saveEmployees() {
        await this.withBusy(async () => {
            await this.orm.call("myaccounting.employee", "save_employees",
                [clone(this.state.employees)]);
            await this.loadSettings();
            this.notification.add("حُفظ الموظفون.", { type: "success" });
        });
    }

    cancelEmployees() {
        this.state.employees = clone(this.saved.employees);
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
            payment_account: "", count: 0,
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
