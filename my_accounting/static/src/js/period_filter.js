/** @odoo-module **/

import { Component, onWillStart, useState } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { loadLedgerYears } from "./ledger_years";

/**
 * فلتر الفترة الموحّد لكل الشاشات: قائمة السنة (السنوات التي فيها قيود فقط)
 * وأزرار الأشهر 1..12. أي تعديل هنا يظهر في كل الصفحات التي تستخدمه.
 *
 * الخصائص:
 *  - year / month: القيمة الحالية ("" أو 0 تعني "الكل").
 *  - allowAllYears: إظهار خيار "كل السنوات" (الصفحات التي تقبل بلا فترة).
 *  - years: قائمة سنوات جاهزة (وإلا تُحمَّل من الخادم).
 *  - onChange({ year, month }): تُستدعى بالقيم الجديدة كنصوص.
 */
export class PeriodFilter extends Component {
    static template = "my_accounting.PeriodFilter";
    static props = {
        year: { type: [String, Number, Boolean], optional: true },
        month: { type: [String, Number, Boolean], optional: true },
        allowAllYears: { type: Boolean, optional: true },
        years: { type: Array, optional: true },
        onChange: Function,
        slots: { type: Object, optional: true },
    };
    static defaultProps = { allowAllYears: false };

    setup() {
        this.orm = useService("orm");
        this.state = useState({ years: [] });
        this.months = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
        onWillStart(async () => {
            if (!this.props.years) {
                this.state.years = await loadLedgerYears(this.orm);
            }
        });
    }

    get years() {
        return this.props.years || this.state.years;
    }

    get year() {
        return this.props.year ? String(this.props.year) : "";
    }

    get month() {
        return this.props.month ? String(this.props.month) : "";
    }

    // السنة المستخدمة عند الضغط على شهر بلا سنة مختارة: أحدث سنة فيها قيود
    get selectedYear() {
        return this.year || String(this.years[0] || new Date().getFullYear());
    }

    isYearActive(year) {
        return String(year) === this.year;
    }

    isMonthActive(month) {
        return String(month) === this.month;
    }

    onYear(ev) {
        const year = ev.target.value;
        // إلغاء السنة يلغي الشهر معها (لا معنى لشهر بلا سنة)
        this.props.onChange({ year, month: year ? this.month : "" });
    }

    // الضغط على الشهر المفعّل يلغيه
    onMonth(month) {
        this.props.onChange(this.isMonthActive(month)
            ? { year: this.year, month: "" }
            : { year: this.selectedYear, month: String(month) });
    }
}
