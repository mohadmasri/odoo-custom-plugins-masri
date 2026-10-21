/** @odoo-module **/

import { Component, onWillStart, useState } from "@odoo/owl";
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { loadLedgerYears } from "./ledger_years";
import { openRecord } from "./open_record";
import { usePrintPageSize } from "./print_page_size";

const MONTHS = [
    "كانون الثاني", "شباط", "آذار", "نيسان", "أيار", "حزيران",
    "تموز", "آب", "أيلول", "تشرين الأول", "تشرين الثاني", "كانون الأول",
];

// الفترات الضريبية المعتادة: شهران معاً، وآخرها يعبر إلى السنة التالية
const PAIRS = [[2, 3], [4, 5], [6, 7], [8, 9], [10, 11], [12, 1]];

/** الفترة المعتادة التي يقع فيها شهر ما، وسنة بدايتها */
function pairOf(year, month) {
    for (const pair of PAIRS) {
        if (pair[0] <= pair[1] && month >= pair[0] && month <= pair[1]) {
            return { year, pair };
        }
        // الفترة العابرة (12 + 1): كانون الثاني يخصّ فترة السنة السابقة
        if (pair[0] > pair[1] && (month === pair[0] || month === pair[1])) {
            return { year: month === pair[1] ? year - 1 : year, pair };
        }
    }
    return { year, pair: [month, month] };
}

/**
 * صفحة الإقرار الضريبي: تجمع ضريبة المبيعات من قيود الفترة المختارة،
 * وتعرض كل فاتورة وكل فاتورة مشتريات على حدة ليُراجَع الرقم لا أن يُصدَّق.
 */
export class TaxReturn extends Component {
    static template = "my_accounting.TaxReturn";
    static props = ["*"];

    setup() {
        this.orm = useService("orm");
        this.actionService = useService("action");
        this.dialog = useService("dialog");
        this.notification = useService("notification");
        this.months = MONTHS;
        this.pairs = PAIRS;
        this.printPage = usePrintPageSize("A4 portrait", "5mm");
        this.state = useState({
            loading: true,
            years: [],
            year: "",
            monthFrom: 1,
            monthTo: 2,
            data: null,
            sheet: null,       // جداول الكشف القابلة للتحرير
            tab: "sheets",     // الجداول أو نموذج الدائرة
            busy: false,
            // إعدادات الأعمدة: لكل جدول قائمته، وتُطبَّق على كل الإقرارات
            columns: {},
            sorts: {},
            showColumns: false,
            savingColumns: false,
            dragTable: "",
            dragIndex: -1,
        });
        onWillStart(async () => {
            const [years, latest, columns, sorts] = await Promise.all([
                loadLedgerYears(this.orm),
                this.orm.call("myaccounting.move", "get_latest_ledger_period", []),
                this.orm.call("myaccounting.tax.column", "get_columns", []),
                this.orm.call("myaccounting.tax.sort", "get_sorts", []),
            ]);
            this.state.columns = columns;
            this.state.sorts = sorts;
            this.state.years = years;
            // الفترة الافتراضية: التي يقع فيها آخر شهر فيه قيود، لا الشهر الحالي
            const year = parseInt(latest.year, 10) || years[0] || new Date().getFullYear();
            const month = parseInt(latest.month, 10) || new Date().getMonth() + 1;
            const found = pairOf(year, month);
            this.state.year = `${found.year}`;
            this.state.monthFrom = found.pair[0];
            this.state.monthTo = found.pair[1];
            await this.load();
        });
    }

    /** سنة نهاية الفترة: "إلى شهر" أصغر من "من شهر" يعني السنة التالية */
    get yearTo() {
        const year = parseInt(this.state.year, 10);
        return this.state.monthTo < this.state.monthFrom ? year + 1 : year;
    }

    get period() {
        return [parseInt(this.state.year, 10), this.state.monthFrom,
                this.yearTo, this.state.monthTo];
    }

    async load() {
        this.state.loading = true;
        try {
            const [data, sheet] = await Promise.all([
                this.orm.call("myaccounting.tax.return", "get_return", this.period),
                this.orm.call("myaccounting.tax.sheet", "get_sheet", this.period),
            ]);
            this.state.data = data;
            this.state.sheet = sheet;
        } finally {
            this.state.loading = false;
        }
    }

    // ------------------------------------------------------------------
    // جداول الكشف
    // ------------------------------------------------------------------

    get sheet() {
        return this.state.sheet;
    }

    rowsOf(key) {
        return this.state.sheet ? this.state.sheet.rows[key] : [];
    }

    totalOf(key, field) {
        return this.state.sheet ? this.state.sheet.totals[key][field] : 0;
    }

    isPurchase(key) {
        return key.startsWith("purchase");
    }

    // ------------------------------------------------------------------
    // أعمدة الجداول: الاسم والترتيب من الإعدادات
    // ------------------------------------------------------------------

    /** أعمدة جدول بعينه بترتيب إعداداته هو */
    columnsFor(key) {
        return this.state.columns[key] || [];
    }

    /** عدد خانات السطر كله: الأعمدة زائد الإشارة والرابط والحذف */
    spanOf(key) {
        return this.columnsFor(key).length + 3;
    }

    /** العمود الذي تُكتب فيه كلمة "المجموع": ما قبل أول عمود رقمي */
    totalLabelKey(key) {
        const columns = this.columnsFor(key);
        const first = columns.findIndex((column) => this.isNumberColumn(column));
        return first > 0 ? columns[first - 1].key : null;
    }

    cellValue(row, column) {
        return row[this.cellField(column)];
    }

    cellField(column) {
        switch (column.key) {
            case "taxno": return "tax_number";
            case "doc": return "doc_number";
            case "type": return "doc_type";
            case "move": return "move_name";
            default: return column.key;
        }
    }

    isNumberColumn(column) {
        return column.key === "amount" || column.key === "tax";
    }

    /** الخانات الطويلة تُطبع نصاً بجانب حقلها لتلتفّ على سطرين */
    isWrapColumn(column) {
        return column.key === "label" || column.key === "party";
    }

    /** التاريخ في الطباعة كما يعرضه الحقل: شهر/يوم/سنة */
    fmtDate(value) {
        const parts = `${value || ""}`.split("-");
        return parts.length === 3 ? `${parts[1]}/${parts[2]}/${parts[0]}` : (value || "");
    }

    toggleColumns() {
        this.state.showColumns = !this.state.showColumns;
    }

    // ------------------------------------------------------------------
    // ترتيب صفوف الجدول حسب عمود منه
    // ------------------------------------------------------------------

    sortOf(table) {
        return this.state.sorts[table] || { key: "", descending: false };
    }

    isSortColumn(table, key) {
        return this.sortOf(table).key === key;
    }

    hasSort(table) {
        return !!this.sortOf(table).key;
    }

    onSortColumn(table, ev) {
        const key = ev.target.value;
        // عمود يُختار لأول مرة يبدأ تصاعدياً، لا باتجاه ترتيب سابق
        const descending = key && this.hasSort(table) ? this.sortOf(table).descending : false;
        this.saveSort(table, key, descending);
    }

    setSortDirection(table, descending) {
        if (!this.hasSort(table) || this.sortOf(table).descending === descending) {
            return;
        }
        this.saveSort(table, this.sortOf(table).key, descending);
    }

    async saveSort(table, key, descending) {
        this.state.savingColumns = true;
        try {
            this.state.sorts = await this.orm.call(
                "myaccounting.tax.sort", "set_sort", [table, key, descending]);
            // الترتيب يُطبَّق عند قراءة الكشف، فنعيد قراءته
            this.state.sheet = await this.orm.call(
                "myaccounting.tax.sheet", "get_sheet", this.period);
        } catch (error) {
            this.notification.add(error.data?.message || "تعذّر حفظ الترتيب.",
                { type: "danger" });
        } finally {
            this.state.savingColumns = false;
        }
    }

    isDragging(table, index) {
        return this.state.dragTable === table && this.state.dragIndex === index;
    }

    onColumnDragStart(table, index, ev) {
        this.state.dragTable = table;
        this.state.dragIndex = index;
        ev.dataTransfer.effectAllowed = "move";
        ev.dataTransfer.setData("text/plain", `${index}`);
    }

    onColumnDragOver(table, index, ev) {
        ev.preventDefault();
        const from = this.state.dragIndex;
        // السحب لا يعبر من جدول إلى آخر: لكل جدول أعمدته
        if (this.state.dragTable !== table || from === -1 || from === index) {
            return;
        }
        const list = this.state.columns[table];
        const [moved] = list.splice(from, 1);
        list.splice(index, 0, moved);
        this.state.dragIndex = index;
    }

    onColumnDragEnd(table) {
        if (this.state.dragIndex !== -1) {
            this.state.dragIndex = -1;
            this.state.dragTable = "";
            this.saveColumns(table);
        }
    }

    onColumnLabel(table, column, ev) {
        const label = ev.target.value.trim() || column.default_label;
        if (label === column.label) {
            return;
        }
        column.label = label;
        this.saveColumns(table);
    }

    async saveColumns(table) {
        const items = this.columnsFor(table).map(
            (column) => ({ key: column.key, label: column.label }));
        this.state.savingColumns = true;
        // الحفظ متسلسل: نقرتان متتاليتان لا تتسابقان على الترتيب
        this.saveChain = (this.saveChain || Promise.resolve())
            .catch(() => {})
            .then(() => this.orm.call("myaccounting.tax.column", "set_columns",
                                      [table, items]));
        try {
            await this.saveChain;
        } catch (error) {
            this.notification.add(error.data?.message || "تعذّر حفظ الأعمدة.",
                { type: "danger" });
            this.state.columns = await this.orm.call(
                "myaccounting.tax.column", "get_columns", []);
        } finally {
            this.state.savingColumns = false;
        }
    }

    async resetColumns(table) {
        this.state.columns = await this.orm.call(
            "myaccounting.tax.column", "reset_columns", [table]);
        this.notification.add("عادت أعمدة الجدول إلى أسمائها وترتيبها الأصلي.",
            { type: "success" });
    }

    setTab(tab) {
        this.state.tab = tab;
    }

    // ------------------------------------------------------------------
    // نموذج الدائرة: خانات الإقرار الرسمي محسوبة من الجداول
    // ------------------------------------------------------------------

    sumRows(key, field, keep) {
        return this.rowsOf(key)
            .filter(keep || (() => true))
            .reduce((total, row) => total + (row[field] || 0), 0);
    }

    get form() {
        const taxed = (row) => !!row.tax;
        const net = (field, keep) => this.round(
            this.sumRows("sale", field, keep) - this.sumRows("sale_return", field, keep));
        // 2) المشتريات المحلية الخاضعة، بعد مرتجعها
        const purchase = this.netAmount("purchase");
        const purchaseTax = this.round(
            this.totalOf("purchase", "tax") - this.totalOf("purchase_return", "tax"));
        // 6) المبيعات الخاضعة و10) المعفاة، كلاهما بعد مرتجعه
        const sales = net("amount", taxed);
        const salesTax = net("tax", taxed);
        const exempt = this.exemptSales;
        // 11) حصة المدخلات التي تخصّ المبيعات المعفاة فلا تُخصم
        const base = this.round(sales + exempt);
        const blocked = base ? this.round(purchaseTax * exempt / base) : 0;
        const due = this.round(salesTax + blocked - purchaseTax);
        return {
            purchase, purchaseTax, sales, salesTax, exempt, base, blocked,
            share: base ? Math.round(exempt / base * 10000) / 100 : 0,
            due: due > 0 ? due : 0,
            credit: due < 0 ? -due : 0,
        };
    }

    /** مجموع قيم جدول بعد خصم مرتجعاته */
    netAmount(key) {
        return this.round(this.totalOf(key, "amount")
            - this.totalOf(`${key}_return`, "amount"));
    }

    /** المبيعات الخاضعة: كامل المبيعات بعد المرتجع ناقص المعفاة */
    get taxableSales() {
        return this.round(this.netAmount("sale") - this.exemptSales);
    }

    /** المبيعات التي لا ضريبة عليها (صفرية أو معفاة)، بعد خصم مرتجعاتها */
    get exemptSales() {
        const sum = (key) => this.rowsOf(key)
            .filter((row) => !row.tax)
            .reduce((total, row) => total + (row.amount || 0), 0);
        return this.round(sum("sale") - sum("sale_return"));
    }

    round(value) {
        return Math.round(value * 1000) / 1000;
    }

    /** المستحق من مجاميع الجداول: مبيعات ناقص مرتجعاتها ناقص صافي المشتريات */
    get sheetDue() {
        const net = (key) => this.totalOf(key, "tax");
        return Math.round((net("sale") - net("sale_return")
            - (net("purchase") - net("purchase_return"))) * 1000) / 1000;
    }

    async build(keepEdits) {
        if (this.state.busy) {
            return;
        }
        this.state.busy = true;
        try {
            const result = await this.orm.call("myaccounting.tax.sheet", "build_sheet",
                [...this.period, keepEdits]);
            this.state.sheet = result;
            this.notification.add(
                result.added ? `أُضيف ${result.added} سطراً من القيود.`
                             : "لا جديد في القيود لم يُسجَّل بعد.",
                { type: result.added ? "success" : "info" });
        } catch (error) {
            this.notification.add(error.data?.message || "تعذّر البناء.", { type: "danger" });
        } finally {
            this.state.busy = false;
        }
    }

    rebuild() {
        this.dialog.add(ConfirmationDialog, {
            title: "إعادة بناء الكشف",
            body: "سيُمسح كل ما في الجداول ويُبنى من جديد من القيود، "
                + "بما في ذلك ما كتبته بيدك (الأرقام الضريبية والصفوف المضافة).",
            confirmLabel: "أعد البناء",
            confirm: () => this.build(false),
            cancel: () => {},
        });
    }

    async saveCell(row, field, ev) {
        const value = field === "amount" || field === "tax"
            ? parseFloat(ev.target.value) || 0
            : ev.target.value;
        if (String(row[field]) === String(value)) {
            return;
        }
        this.state.sheet = await this.orm.call("myaccounting.tax.sheet", "save_row",
            [row.id, { [field]: value }]);
    }

    async addRow(key) {
        this.state.sheet = await this.orm.call("myaccounting.tax.sheet", "add_row",
            [this.state.sheet.id, key]);
    }

    async deleteRow(row) {
        this.state.sheet = await this.orm.call("myaccounting.tax.sheet", "delete_row", [row.id]);
    }

    get data() {
        return this.state.data;
    }

    get totals() {
        return this.state.data ? this.state.data.totals : null;
    }

    fmt(value) {
        let number = Number(value) || 0;
        // الصفر السالب الناتج عن الطرح يُعرض صفراً عادياً
        if (Math.abs(number) < 0.0005) {
            number = 0;
        }
        return number.toLocaleString("en-US", {
            minimumFractionDigits: 3, maximumFractionDigits: 3,
        });
    }

    isYear(year) {
        return `${year}` === this.state.year;
    }

    /** مجموع عمود في قسم من أقسام الإقرار */
    sectionTotal(rows, field) {
        return rows.reduce((sum, row) => sum + (Number(row[field]) || 0), 0);
    }

    monthName(number) {
        return MONTHS[Number(number) - 1] || "";
    }

    isPair(pair) {
        return this.state.monthFrom === pair[0] && this.state.monthTo === pair[1];
    }

    async setPair(pair) {
        this.state.monthFrom = pair[0];
        this.state.monthTo = pair[1];
        await this.load();
    }

    async onYear(ev) {
        this.state.year = ev.target.value;
        await this.load();
    }

    // "إلى شهر" أصغر من "من شهر" مقصود: الفترة تعبر إلى السنة التالية
    async onMonth(field, ev) {
        this.state[field] = parseInt(ev.target.value, 10);
        await this.load();
    }

    openMove(moveId, isMiddleClick) {
        openRecord(this.actionService, "myaccounting.move", moveId, isMiddleClick);
    }

    print() {
        this.printPage.enable();
        window.print();
    }
}

registry.category("actions").add("my_accounting.tax_return", TaxReturn);
