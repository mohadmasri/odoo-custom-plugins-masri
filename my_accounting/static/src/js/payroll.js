/** @odoo-module **/

import { Component, onWillStart, useRef, useState } from "@odoo/owl";
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { MONTH_OPTIONS } from "./months";
import { registry } from "@web/core/registry";
import { router } from "@web/core/browser/router";
import { useService } from "@web/core/utils/hooks";
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
    static components = { RefPicker };
    static props = ["*"];

    setup() {
        this.orm = useService("orm");
        this.actionService = useService("action");
        this.dialog = useService("dialog");
        this.notification = useService("notification");
        this.printPage = usePrintPageSize("A4 landscape", "8mm");
        this.excelInput = useRef("excelInput");
        this.uploadInput = useRef("uploadInput");
        this.months = MONTH_OPTIONS;
        this.saved = { employees: [], lines: [], settings: null, groups: [], card: null };
        const today = new Date();
        this.state = useState({
            loading: true,
            busy: false,
            tab: "sheet",
            payrolls: [],
            data: null,
            employees: [],
            groups: [],
            card: null,
            cardDraft: null,
            uploads: [],
            upload: null,
            uploadSheet: "all",
            excel: null,
            excelName: "",
            excelOptions: { edit: true, add: true, stop: true },
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
            await this.loadUploads();
            this.state.loading = false;
            // الرابط /odoo/action-.../<رقم> يفتح بطاقة ذلك الموظف وحدها
            await this.openCardFromUrl();
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
            body: `يبقى ${what} في الدفتر كما هو، ويعود الكشف قابلاً للتعديل`
                + ` والترحيل من جديد — فإن أنشأت قيداً بعده صار في الدفتر قيدان.`,
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
            body: "سيُحذف كشف الشهر بكل بنوده، وتبقى قيوده في الدفتر كما هي.",
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
        // المسمّى والبيانات الشخصية تُعدَّل من البطاقة، والجدول للراتب
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

    /** الموظف الجديد يُدخل من بطاقته لا من سطرٍ في الجدول */
    async newEmployeeCard() {
        if (this.employeesDirty) {
            this.notification.add("احفظ تغييرات الجدول قبل فتح بطاقة جديدة.",
                                  { type: "warning" });
            return;
        }
        const group = this.currentGroup;
        await this.withBusy(async () => {
            const card = await this.orm.call("myaccounting.employee",
                "new_employee_card",
                [group ? group.id : false, 10 * (this.state.employees.length + 1)]);
            this.setCard(card);
        });
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
            payment_account: "", journal: "", count: 0,
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
    // كشف مرفوع: يُقرأ ويُحفظ وتُنشأ منه القيود، بلا بطاقات ولا تعديل
    // ------------------------------------------------------------------

    async loadUploads(uploadId = false) {
        const [uploads, upload] = await Promise.all([
            this.orm.call("myaccounting.payroll.upload", "get_uploads", []),
            this.orm.call("myaccounting.payroll.upload", "get_upload",
                [uploadId || (this.state.upload ? this.state.upload.id : false)]),
        ]);
        this.state.uploads = uploads;
        this.state.upload = upload || null;
        if (this.state.uploadSheet !== "all" && !this.uploadVisible.length) {
            this.state.uploadSheet = "all";
        }
    }

    pickUpload() {
        this.uploadInput.el.click();
    }

    async onUploadFile(ev) {
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
            const upload = await this.orm.call("myaccounting.payroll.upload",
                "read_excel", [content, file.name, this.state.newYear,
                    this.state.newMonth]);
            this.state.uploadSheet = "all";
            await this.loadUploads(upload.id);
            this.notification.add(`رُفع الكشف: ${upload.lines.length} بنداً.`,
                                  { type: "success" });
        });
    }

    async openUpload(ev) {
        const id = parseInt(ev.target.value, 10);
        await this.withBusy(async () => {
            this.state.uploadSheet = "all";
            await this.loadUploads(id);
        });
    }

    isUpload(id) {
        return this.state.upload && this.state.upload.id === id;
    }

    deleteUpload() {
        const upload = this.state.upload;
        this.dialog.add(ConfirmationDialog, {
            title: `حذف "${upload.name}"`,
            body: "سيُحذف الكشف المرفوع بكل بنوده، وتبقى قيوده في الدفتر كما هي.",
            confirmLabel: "احذف",
            confirm: () => this.withBusy(async () => {
                await this.orm.call("myaccounting.payroll.upload", "delete_upload",
                    [[upload.id]]);
                this.state.upload = null;
                await this.loadUploads();
            }),
            cancel: () => {},
        });
    }

    /** كشوف الملف: بنود كل ورقة ومجاميعها، بترتيب كشوف النظام */
    get uploadSections() {
        const data = this.state.upload;
        if (!data) {
            return [];
        }
        return data.sheets.map((sheet) => {
            const own = data.lines.filter((line) => line.key === sheet.key);
            return { ...sheet, lines: own, totals: this.sumOf(own) };
        });
    }

    get uploadVisible() {
        const sheet = this.state.uploadSheet;
        const shown = sheet === "all" ? this.uploadSections
            : this.uploadSections.filter((item) => item.key === sheet);
        let start = 0;
        return shown.map((section) => {
            const numbered = { ...section, start };
            start += section.lines.length;
            return numbered;
        });
    }

    get uploadTotals() {
        return this.sumOf(this.uploadVisible.flatMap((section) => section.lines));
    }

    get uploadCount() {
        return this.uploadVisible.reduce(
            (sum, section) => sum + section.lines.length, 0);
    }

    get uploadLabel() {
        const section = this.state.uploadSheet === "all" ? null : this.uploadVisible[0];
        return section ? section.name : "";
    }

    setUploadSheet(key) {
        this.state.uploadSheet = key;
    }

    get uploadToPost() {
        return this.uploadVisible.filter((section) => !section.posted);
    }

    get uploadPosted() {
        return this.uploadVisible.filter((section) => section.posted);
    }

    get uploadPostLabel() {
        const todo = this.uploadToPost;
        return todo.length === 1 ? `أنشئ قيد ${todo[0].name}`
                                 : `أنشئ قيود الكشوف (${todo.length})`;
    }

    get uploadUnpostLabel() {
        const done = this.uploadPosted;
        return done.length === 1 ? `فكّ ربط ${done[0].name}`
                                 : `فكّ ربط الكشوف (${done.length})`;
    }

    async postUpload() {
        await this.withBusy(async () => {
            const count = this.uploadToPost.length;
            await this.orm.call("myaccounting.payroll.upload", "post_upload",
                [[this.state.upload.id], this.state.uploadSheet]);
            await this.loadUploads(this.state.upload.id);
            this.notification.add(count === 1 ? "أُنشئ قيد الكشف مسودةً."
                                              : `أُنشئت ${count} قيود مسودةً.`,
                                  { type: "success" });
        });
    }

    unpostUpload() {
        const done = this.uploadPosted;
        const what = done.length === 1 ? `قيد ${done[0].move}` : `${done.length} قيود`;
        this.dialog.add(ConfirmationDialog, {
            title: "فكّ الربط",
            body: `يبقى ${what} في الدفتر كما هو، ويعود الكشف المرفوع قابلاً`
                + ` لإنشاء قيدٍ جديد — فإن أنشأته صار في الدفتر قيدان.`,
            confirmLabel: "نعم",
            confirm: () => this.withBusy(async () => {
                await this.orm.call("myaccounting.payroll.upload", "unpost_upload",
                    [[this.state.upload.id], this.state.uploadSheet]);
                await this.loadUploads(this.state.upload.id);
            }),
            cancel: () => {},
        });
    }

    // ------------------------------------------------------------------
    // رفع كشف إكسل: يعدّل البطاقات، والكشف يُبنى منها
    // ------------------------------------------------------------------

    pickExcel() {
        if (this.employeesDirty) {
            this.notification.add("احفظ تغييرات الجدول قبل رفع ملف.",
                                  { type: "warning" });
            return;
        }
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
             + (options.stop ? plan.stop.length : 0);
    }

    async applyExcel() {
        await this.withBusy(async () => {
            const done = await this.orm.call("myaccounting.employee", "apply_excel",
                [this.excelContent, { ...this.state.excelOptions }]);
            this.closeExcel();
            await this.loadSettings();
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
            this.notification.add(parts.length ? parts.join(" · ")
                                               : "لا تغيير على البطاقات.",
                                  { type: "success" });
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
        if (this.employeesDirty) {
            this.notification.add("احفظ تغييرات الجدول قبل فتح البطاقة.",
                                  { type: "warning" });
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
