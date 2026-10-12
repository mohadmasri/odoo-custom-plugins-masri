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

// الفترات الضريبية المعتادة: شهران معاً
const PAIRS = [[2, 3], [4, 5], [6, 7], [8, 9], [10, 11], [12, 12]];

/**
 * صفحة الإقرار الضريبي: تجمع ضريبة المبيعات من قيود الفترة المختارة،
 * وتعرض كل فاتورة وكل بند مدخلات على حدة ليُراجَع الرقم لا أن يُصدَّق.
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
            this.state.years = await loadLedgerYears(this.orm);
            this.state.year = String(this.state.years[0] || new Date().getFullYear());
            const month = new Date().getMonth() + 1;
            // الفترة الافتراضية: الزوج الذي يقع فيه الشهر الحالي
            const pair = PAIRS.find(([from, to]) => month >= from && month <= to) || [month, month];
            this.state.monthFrom = pair[0];
            this.state.monthTo = pair[1];
            await this.load();
        });
    }

    async load() {
        this.state.loading = true;
        try {
            this.state.data = await this.orm.call("myaccounting.tax.return", "get_return", [
                this.state.year, this.state.monthFrom, this.state.monthTo,
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

    async onMonth(field, ev) {
        const value = parseInt(ev.target.value, 10);
        this.state[field] = value;
        // "من" بعد "إلى" لا معنى له، فنسحب الآخر معه
        if (field === "monthFrom" && value > this.state.monthTo) {
            this.state.monthTo = value;
        }
        if (field === "monthTo" && value < this.state.monthFrom) {
            this.state.monthFrom = value;
        }
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
