/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { standardWidgetProps } from "@web/views/widgets/standard_widget_props";

const MONTHS = [
    "كانون الثاني", "شباط", "آذار", "نيسان", "أيار", "حزيران",
    "تموز", "آب", "أيلول", "تشرين الأول", "تشرين الثاني", "كانون الأول",
];

/**
 * سطر القيد الظاهر كما يظهر في دفتر الأستاذ العام: نفس الأعمدة (مدين/دائن لكل
 * حساب رئيسي) لكن للقيد وحده. يُحسب من بنود القيد المعروضة، فيتحدّث مباشرة مع
 * كل تعديل قبل الحفظ، ويعمل للمسودة والقيد المرحّل معاً.
 */
export class MoveLedgerRow extends Component {
    static template = "my_accounting.MoveLedgerRow";
    static props = { ...standardWidgetProps };

    setup() {
        this.orm = useService("orm");
        this.actionService = useService("action");
        this.state = useState({ columns: null, onlyUsed: true });
        onWillStart(async () => {
            this.state.columns = await this.orm.call("myaccounting.account", "get_ledger_columns", []);
        });
    }

    get record() {
        return this.props.record;
    }

    get lines() {
        const field = this.record.data.line_ids;
        return field ? field.records : [];
    }

    /** مجاميع كل حساب رئيسي في هذا القيد + إجمالي مدين/دائن + بنود بلا حساب */
    get row() {
        const rootOf = (this.state.columns && this.state.columns.root_of) || {};
        const amounts = {};
        let totalDebit = 0;
        let totalCredit = 0;
        let missing = 0;
        for (const line of this.lines) {
            const data = line.data;
            const debit = data.debit || 0;
            const credit = data.credit || 0;
            totalDebit += debit;
            totalCredit += credit;
            const accountId = data.account_id && data.account_id.id;
            if (!accountId) {
                // بند لم يُحدَّد حسابه بعد: لا عمود له، لكنه ضمن الإجمالي (مثل الدفتر)
                missing += 1;
                continue;
            }
            const root = rootOf[accountId] || accountId;
            if (!amounts[root]) {
                amounts[root] = { debit: 0, credit: 0, debit_zero: false, credit_zero: false };
            }
            amounts[root].debit += debit;
            amounts[root].credit += credit;
            amounts[root].debit_zero ||= !!data.debit_zero_entered;
            amounts[root].credit_zero ||= !!data.credit_zero_entered;
        }
        return { amounts, totalDebit, totalCredit, missing };
    }

    get accounts() {
        const all = (this.state.columns && this.state.columns.accounts) || [];
        if (!this.state.onlyUsed) {
            return all;
        }
        const { amounts } = this.row;
        return all.filter((acc) => amounts[acc.id]);
    }

    get difference() {
        const { totalDebit, totalCredit } = this.row;
        return Math.round((totalDebit - totalCredit) * 1000) / 1000;
    }

    // التاريخ بصيغة يوم/شهر/سنة بأرقام لاتينية، كما في شاشة دفتر الأستاذ العام
    // (التنسيق من أجزاء التاريخ مباشرة، فلا تتدخّل أرقام اللغة العربية)
    get dateText() {
        const date = this.record.data.date;
        if (!date) {
            return "";
        }
        if (typeof date === "string") {
            return date;
        }
        const pad = (value) => String(value).padStart(2, "0");
        return `${date.year}-${pad(date.month)}-${pad(date.day)}`;
    }

    get differenceText() {
        return Math.abs(this.difference).toFixed(3);
    }

    get ledgerPeriod() {
        const month = parseInt(this.record.data.ledger_month, 10);
        const year = this.record.data.ledger_year;
        if (!month || !year) {
            return "";
        }
        return `${MONTHS[month - 1]} ${year}`;
    }

    fmt(value) {
        return value ? value.toFixed(3) : "";
    }

    // خانة حساب: فارغة إن لم يُدخل شيء، و0 إن أُدخل صفر يدوياً (نفس الدفتر)
    cell(amount, side) {
        if (!amount) {
            return "";
        }
        return amount[side] ? amount[side].toFixed(3) : (amount[`${side}_zero`] ? "0.000" : "");
    }

    toggleOnlyUsed() {
        this.state.onlyUsed = !this.state.onlyUsed;
    }

    // فتح دفتر الأستاذ العام على شهر هذا القيد وبحالته، فيظهر السطر ضمن الدفتر كاملاً
    openLedger() {
        const month = parseInt(this.record.data.ledger_month, 10);
        const year = this.record.data.ledger_year;
        const state = this.record.data.state;
        this.actionService.doAction("my_accounting.action_myaccounting_general_ledger", {
            additionalContext: {
                ledger_month: month && year ? `${year}-${String(month).padStart(2, "0")}` : false,
                ledger_states: state === "posted" ? ["posted"] : ["posted", state],
            },
        });
    }
}

registry.category("view_widgets").add("my_accounting.move_ledger_row", {
    component: MoveLedgerRow,
});
