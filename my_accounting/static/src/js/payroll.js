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
        this.saved = { employees: [], lines: [], settings: null };
        const today = new Date();
        this.state = useState({
            loading: true,
            busy: false,
            tab: "sheet",
            payrolls: [],
            data: null,
            employees: [],
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
    }

    async loadSettings() {
        const [employees, settings] = await Promise.all([
            this.orm.call("myaccounting.employee", "get_employees", []),
            this.orm.call("myaccounting.payroll.settings", "get_settings", []),
        ]);
        this.state.employees = employees;
        this.state.settings = settings;
        this.saved.employees = clone(employees);
        this.saved.settings = clone(settings);
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

    /** مجاميع الكشف محسوبةً على الشاشة، فتتحرّك مع التعديل قبل الحفظ */
    get totals() {
        const keys = ["basic_salary", "allowance", "gross", "social_base",
                      "employee_social", "employer_social", "income_tax", "pension",
                      "other_deduction", "total_deduction", "net"];
        const lines = this.state.data ? this.state.data.lines : [];
        const totals = {};
        for (const key of keys) {
            totals[key] = this.round(lines.reduce((sum, line) => sum + (line[key] || 0), 0));
        }
        return totals;
    }

    async postPayroll() {
        await this.withBusy(async () => {
            this.state.data = await this.orm.call("myaccounting.payroll", "post_payroll",
                [[this.state.data.id]]);
            await this.refresh(this.state.data.id);
            this.notification.add("أُنشئ قيد الرواتب مسودةً.", { type: "success" });
        });
    }

    unpostPayroll() {
        this.dialog.add(ConfirmationDialog, {
            title: "فكّ الترحيل",
            body: "سيُحذف قيد الرواتب ما دام مسودة، ويعود الكشف قابلاً للتعديل.",
            confirmLabel: "نعم",
            confirm: () => this.withBusy(async () => {
                this.state.data = await this.orm.call("myaccounting.payroll",
                    "unpost_payroll", [[this.state.data.id]]);
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
        this.state.employees.push({
            id: false, name: "موظف جديد", sequence: 10 * (this.state.employees.length + 1),
            job_title: "", hire_date: "", active: true, basic_salary: 0, allowance: 0,
            gross: 0, social_security: true, social_base: 0, income_tax: 0,
            pension: 0, other_deduction: 0, account_id: false, account: "",
            payment_account_id: false, payment_account: "", note: "",
        });
    }

    removeEmployee(index) {
        this.state.employees.splice(index, 1);
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
