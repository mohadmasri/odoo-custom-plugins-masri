/** @odoo-module **/

import { Component, onWillStart, useState } from "@odoo/owl";
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

    async load() {
        this.state.loading = true;
        try {
            this.state.data = await this.orm.call("myaccounting.tax.return", "get_return", [
                parseInt(this.state.year, 10), this.state.monthFrom,
                this.yearTo, this.state.monthTo,
            ]);
        } finally {
            this.state.loading = false;
        }
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
