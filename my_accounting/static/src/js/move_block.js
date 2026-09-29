/** @odoo-module **/

import { Component, onWillStart, useRef, useState } from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { standardWidgetProps } from "@web/views/widgets/standard_widget_props";

const ACCOUNT_LIST_ID = "o_move_block_accounts";

/** ثلاث خانات عشرية كما في بقية النظام */
function round3(value) {
    return Math.round((Number(value) || 0) * 1000) / 1000;
}

/** وصف كل كتلة: عنوانها وأيقونتها والحسابات التي تُحفظ لاستعمالها لاحقاً */
const BLOCKS = {
    invoice: {
        title: "فاتورة",
        icon: "fa-file-text-o",
        hint: "ذمم الجهة مديناً، الإيراد دائناً، وضريبة المبيعات دائناً.",
        remembered: ["income_account_id", "tax_account_id", "tax_rate"],
    },
    guarantee: {
        title: "كفالة",
        icon: "fa-shield",
        hint: "الكفالة والعمولة مدينتان، والبنك دائن بالمجموع.",
        remembered: ["guarantee_account_id", "commission_account_id", "guarantee_bank_id"],
    },
    receipt: {
        title: "قبض",
        icon: "fa-money",
        hint: "ذمم الجهة دائنة، البنك مدين بالصافي، والطوابع مدينة بالفرق.",
        remembered: ["receipt_bank_id", "receipt_fee_account_id"],
    },
};

/**
 * نافذة الكتلة: صف واحد من البيانات يُترجم إلى بنود القيد الثلاثة.
 * المبالغ تُحسب أمام المستخدم قبل الإضافة، فلا مفاجأة بعدها.
 */
export class MoveBlockDialog extends Component {
    static template = "my_accounting.MoveBlockDialog";
    static components = { Dialog };
    static props = {
        close: Function,
        kind: String,
        accounts: Array,
        settings: Object,
        onConfirm: Function,
    };

    setup() {
        this.listId = ACCOUNT_LIST_ID;
        this.firstRef = useRef("first");
        const settings = this.props.settings;
        this.state = useState({
            partyId: false,
            text: "",
            amount: "",
            includesTax: false,
            exempt: false,
            commission: "",
            fee: "",
            taxRate: settings.tax_rate,
            incomeId: settings.income_account_id,
            taxId: settings.tax_account_id,
            guaranteeId: settings.guarantee_account_id,
            commissionId: settings.commission_account_id,
            bankId: this.props.kind === "receipt"
                ? settings.receipt_bank_id
                : settings.guarantee_bank_id,
            feeId: settings.receipt_fee_account_id,
        });
    }

    get block() {
        return BLOCKS[this.props.kind];
    }

    get isInvoice() {
        return this.props.kind === "invoice";
    }

    get isGuarantee() {
        return this.props.kind === "guarantee";
    }

    get isReceipt() {
        return this.props.kind === "receipt";
    }

    accountLabel(id) {
        const account = this.props.accounts.find((acc) => acc.id === id);
        return account ? account.label : "";
    }

    onAccountInput(field, ev) {
        const account = this.props.accounts.find((acc) => acc.label === ev.target.value);
        this.state[field] = account ? account.id : false;
    }

    onNumber(field, ev) {
        this.state[field] = ev.target.value;
    }

    // ------------------------------------------------------------------
    // الحساب المعروض قبل الإضافة
    // ------------------------------------------------------------------

    get amountValue() {
        return round3(parseFloat(this.state.amount) || 0);
    }

    /** الفاتورة: الصافي والضريبة والإجمالي مهما كان المُدخل شاملاً أو لا */
    get invoiceAmounts() {
        const rate = (parseFloat(this.state.taxRate) || 0) / 100;
        const amount = this.amountValue;
        if (this.state.exempt || !rate) {
            return { net: amount, tax: 0, gross: amount };
        }
        if (this.state.includesTax) {
            const net = round3(amount / (1 + rate));
            return { net, tax: round3(amount - net), gross: amount };
        }
        const tax = round3(amount * rate);
        return { net: amount, tax, gross: round3(amount + tax) };
    }

    get guaranteeAmounts() {
        const amount = this.amountValue;
        const commission = round3(parseFloat(this.state.commission) || 0);
        return { amount, commission, total: round3(amount + commission) };
    }

    get receiptAmounts() {
        const amount = this.amountValue;
        const fee = round3(parseFloat(this.state.fee) || 0);
        return { amount, fee, net: round3(amount - fee) };
    }

    /** البنود كما ستُضاف، معروضة في النافذة للمراجعة */
    get lines() {
        const text = this.state.text.trim();
        if (this.isInvoice) {
            const { net, tax, gross } = this.invoiceAmounts;
            const lines = [
                { account_id: this.state.partyId, name: text, debit: gross, credit: 0 },
                { account_id: this.state.incomeId, name: text, debit: 0, credit: net },
            ];
            // بند الضريبة يبقى ظاهراً بصفر في الفواتير المعفاة، كما تكتبها بيدك
            lines.push({
                account_id: this.state.taxId, name: text, debit: 0, credit: tax,
                credit_zero_entered: !tax,
            });
            return lines;
        }
        if (this.isGuarantee) {
            const { amount, commission, total } = this.guaranteeAmounts;
            const lines = [
                { account_id: this.state.guaranteeId, name: text, debit: amount, credit: 0 },
            ];
            if (commission) {
                lines.push({
                    account_id: this.state.commissionId, name: text, debit: commission, credit: 0,
                });
            }
            lines.push({ account_id: this.state.bankId, name: text, debit: 0, credit: total });
            return lines;
        }
        const { amount, fee, net } = this.receiptAmounts;
        const lines = [
            { account_id: this.state.partyId, name: text, debit: 0, credit: amount },
            { account_id: this.state.bankId, name: text, debit: net, credit: 0 },
        ];
        if (fee) {
            lines.push({ account_id: this.state.feeId, name: "طوابع", debit: fee, credit: 0 });
        }
        return lines;
    }

    get problem() {
        if (!this.state.text.trim()) {
            return "اكتب البيان (رقم الفاتورة أو الكفالة أو اسم الجهة).";
        }
        if (!this.amountValue) {
            return "اكتب المبلغ.";
        }
        if (this.lines.some((line) => !line.account_id)) {
            return "اختر كل الحسابات المطلوبة.";
        }
        if (this.isReceipt && this.receiptAmounts.net < 0) {
            return "الطوابع أكبر من المبلغ.";
        }
        return "";
    }

    confirm() {
        if (this.problem) {
            return;
        }
        const settings = {};
        for (const key of this.block.remembered) {
            settings[key] = key === "tax_rate"
                ? parseFloat(this.state.taxRate) || 0
                : this.stateOf(key);
        }
        this.props.onConfirm(this.lines, settings);
        this.props.close();
    }

    /** ربط مفتاح الإعداد المحفوظ بالخانة المقابلة له في النافذة */
    stateOf(key) {
        return {
            income_account_id: this.state.incomeId,
            tax_account_id: this.state.taxId,
            guarantee_account_id: this.state.guaranteeId,
            commission_account_id: this.state.commissionId,
            guarantee_bank_id: this.state.bankId,
            receipt_bank_id: this.state.bankId,
            receipt_fee_account_id: this.state.feeId,
        }[key];
    }

    onKeydown(ev) {
        if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            this.confirm();
        }
    }
}

/**
 * شريط الكتل فوق بنود القيد: زر لكل كتلة متكررة في قيود المكتب.
 */
export class MoveBlockBar extends Component {
    static template = "my_accounting.MoveBlockBar";
    static props = { ...standardWidgetProps };

    setup() {
        this.orm = useService("orm");
        this.dialog = useService("dialog");
        this.notification = useService("notification");
        this.blocks = Object.entries(BLOCKS).map(([kind, block]) => ({ kind, ...block }));
        this.setup_ = useState({ accounts: [], settings: null });
        onWillStart(async () => {
            const data = await this.orm.call("myaccounting.move.block", "get_setup", []);
            this.setup_.accounts = data.accounts;
            this.setup_.settings = data.settings;
        });
    }

    get readonly() {
        return this.props.record.data.state === "posted";
    }

    get accountListId() {
        return ACCOUNT_LIST_ID;
    }

    open(kind) {
        if (!this.setup_.settings) {
            return;
        }
        this.dialog.add(MoveBlockDialog, {
            kind,
            accounts: this.setup_.accounts,
            settings: this.setup_.settings,
            onConfirm: (lines, settings) => this.addLines(kind, lines, settings),
        });
    }

    async addLines(kind, lines, settings) {
        const list = this.props.record.data.line_ids;
        for (const line of lines) {
            // mode readonly: نضيف البنود دون فتح أي صف في وضع التحرير
            const record = await list.addNewRecord({ position: "bottom", mode: "readonly" });
            await record.update({
                name: line.name,
                account_id: { id: line.account_id, display_name: this.label(line.account_id) },
                debit: line.debit,
                credit: line.credit,
                debit_zero_entered: !!line.debit_zero_entered,
                credit_zero_entered: !!line.credit_zero_entered,
            });
        }
        this.notification.add(`أُضيفت ${lines.length} بنود من كتلة ${BLOCKS[kind].title}.`,
            { type: "success" });
        Object.assign(this.setup_.settings, settings);
        await this.orm.call("myaccounting.move.block", "remember", [settings]);
    }

    label(id) {
        const account = this.setup_.accounts.find((acc) => acc.id === id);
        return account ? account.name : "";
    }
}

registry.category("view_widgets").add("my_accounting.move_block", {
    component: MoveBlockBar,
});
