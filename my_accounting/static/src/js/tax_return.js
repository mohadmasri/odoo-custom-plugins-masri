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
        this.printPage = usePrintPageSize("A4 portrait", "10mm");
        this.state = useState({
            loading: true,
            years: [],
            year: "",
            monthFrom: 1,
            monthTo: 2,
            data: null,
            sheet: null,       // جداول الكشف القابلة للتحرير
            busy: false,
        });
        onWillStart(async () => {
            const [years, latest] = await Promise.all([
                loadLedgerYears(this.orm),
                this.orm.call("myaccounting.move", "get_latest_ledger_period", []),
            ]);
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
