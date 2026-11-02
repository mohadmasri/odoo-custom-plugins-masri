/** @odoo-module **/

import { Component, onWillStart, useState } from "@odoo/owl";
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { buildBlockLines, evalFormula, formulaNames } from "./block_formula";

const ICONS = [
    ["fa-file-text-o", "فاتورة"], ["fa-shield", "كفالة"], ["fa-money", "قبض"],
    ["fa-bank", "بنك"], ["fa-credit-card", "دفع"], ["fa-users", "رواتب"],
    ["fa-truck", "مشتريات"], ["fa-th-large", "عام"],
];

const ACCOUNT_LIST_ID = "o_blocks_accounts";

/**
 * صفحة "الكتل الجاهزة": بناء الكتل وتعديلها وحذفها.
 * الكتلة = خانات مبالغ + بنود تُحسب منها بصيغ، وتُجرَّب هنا قبل استعمالها.
 */
export class BlocksSettings extends Component {
    static template = "my_accounting.BlocksSettings";
    static props = ["*"];

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.dialogService = useService("dialog");
        this.icons = ICONS;
        this.listId = ACCOUNT_LIST_ID;
        this.state = useState({
            loading: true,
            blocks: [],
            accounts: [],
            edited: null,      // الكتلة المفتوحة للتعديل (نسخة عمل)
            trying: {},        // قيم التجربة في المعاينة
            saving: false,
        });
        onWillStart(() => this.load());
    }

    async load() {
        this.state.loading = true;
        const data = await this.orm.call("myaccounting.block", "get_blocks", []);
        this.state.blocks = data.blocks;
        this.state.accounts = data.accounts;
        this.state.loading = false;
    }

    accountLabel(id) {
        const account = this.state.accounts.find((acc) => acc.id === id);
        return account ? account.label : "";
    }

    // ------------------------------------------------------------------
    // فتح كتلة للتعديل
    // ------------------------------------------------------------------

    edit(block) {
        // نسخة عمل: لا يُمسّ الأصل حتى يُضغط حفظ
        this.state.edited = JSON.parse(JSON.stringify(block));
        this.resetTrial();
    }

    create() {
        this.state.edited = {
            id: false, name: "", icon: "fa-th-large", hint: "", text_template: "",
            sequence: (this.state.blocks.length + 1) * 10, active: true,
            fields: [{ key: "amount", label: "المبلغ", kind: "number", default_value: 0 }],
            lines: [
                { id: "n1", label: "", account_id: false, ask_account: true,
                  account_prompt: "الحساب المدين", side: "debit", formula: "amount",
                  zero_visible: false },
                { id: "n2", label: "", account_id: false, ask_account: true,
                  account_prompt: "الحساب الدائن", side: "credit", formula: "amount",
                  zero_visible: false },
            ],
        };
        this.resetTrial();
    }

    close() {
        this.state.edited = null;
    }

    resetTrial() {
        const trying = {};
        for (const field of this.state.edited.fields) {
            // خانة النص لا تُحسب، فتدخل التجربة بصفر لئلّا تُعدّ مفقودة
            trying[field.key] = field.kind && field.kind !== "number"
                ? 0
                : field.default_value || 100;
        }
        this.state.trying = trying;
    }

    // ------------------------------------------------------------------
    // تعديل الخانات والبنود
    // ------------------------------------------------------------------

    addField() {
        this.state.edited.fields.push(
            { key: "", label: "", kind: "number", default_value: 0 });
    }

    removeField(index) {
        this.state.edited.fields.splice(index, 1);
        this.resetTrial();
    }

    onFieldChange(field, prop, ev) {
        field[prop] = prop === "default_value"
            ? parseFloat(ev.target.value) || 0
            : ev.target.value.trim();
        if (prop === "key") {
            this.resetTrial();
        }
    }

    addLine() {
        this.state.edited.lines.push({
            id: `n${Date.now()}`, label: "", account_id: false, ask_account: false,
            account_prompt: "", side: "debit", formula: "0", zero_visible: false,
        });
    }

    removeLine(index) {
        this.state.edited.lines.splice(index, 1);
    }

    moveLine(index, step) {
        const lines = this.state.edited.lines;
        const target = index + step;
        if (target < 0 || target >= lines.length) {
            return;
        }
        [lines[index], lines[target]] = [lines[target], lines[index]];
    }

    onLineChange(line, prop, ev) {
        if (prop === "ask_account" || prop === "zero_visible") {
            line[prop] = ev.target.checked;
            if (prop === "ask_account" && ev.target.checked) {
                line.account_id = false;
            }
            return;
        }
        if (prop === "account_id") {
            const account = this.state.accounts.find((acc) => acc.label === ev.target.value);
            line.account_id = account ? account.id : false;
            return;
        }
        line[prop] = ev.target.value;
    }

    onTrial(key, ev) {
        this.state.trying[key] = parseFloat(ev.target.value) || 0;
    }

    // ------------------------------------------------------------------
    // المعاينة والتحقق
    // ------------------------------------------------------------------

    get knownKeys() {
        return this.state.edited.fields.map((field) => field.key).filter(Boolean);
    }

    /** خطأ الصيغة في بند، إن وُجد */
    lineError(line) {
        const unknown = formulaNames(line.formula).filter(
            (name) => !this.knownKeys.includes(name));
        if (unknown.length) {
            return `لا توجد خانة اسمها ${unknown[0]}`;
        }
        const values = {};
        for (const key of this.knownKeys) {
            values[key] = 1;
        }
        return evalFormula(line.formula, values).error || "";
    }

    get preview() {
        return buildBlockLines(this.state.edited, this.state.trying, {}, "بيان تجريبي");
    }

    get previewTotals() {
        const lines = this.preview;
        const debit = lines.reduce((sum, line) => sum + line.debit, 0);
        const credit = lines.reduce((sum, line) => sum + line.credit, 0);
        return { debit, credit, difference: Math.round((debit - credit) * 1000) / 1000 };
    }

    get problems() {
        const block = this.state.edited;
        const problems = [];
        if (!block.name.trim()) {
            problems.push("اكتب اسم الكتلة.");
        }
        if (!block.lines.length) {
            problems.push("أضف بنداً واحداً على الأقل.");
        }
        const keys = this.knownKeys;
        if (new Set(keys).size !== keys.length) {
            problems.push("مفاتيح الخانات مكرّرة.");
        }
        for (const field of block.fields) {
            if (!field.key.trim()) {
                problems.push("كل خانة تحتاج مفتاحاً بالإنجليزية.");
                break;
            }
        }
        for (const line of block.lines) {
            const error = this.lineError(line);
            if (error) {
                problems.push(error);
                break;
            }
            if (!line.ask_account && !line.account_id) {
                problems.push("كل بند يحتاج حساباً، أو علامة أنه يُسأل عنه.");
                break;
            }
        }
        return problems;
    }

    // ------------------------------------------------------------------
    // الحفظ والحذف
    // ------------------------------------------------------------------

    async save() {
        if (this.problems.length || this.state.saving) {
            return;
        }
        this.state.saving = true;
        try {
            await this.orm.call("myaccounting.block", "save_block", [this.state.edited]);
            await this.load();
            this.state.edited = null;
            this.notification.add("حُفظت الكتلة.", { type: "success" });
        } catch (error) {
            this.notification.add(error.data?.message || "تعذّر الحفظ.", { type: "danger" });
        } finally {
            this.state.saving = false;
        }
    }

    remove(block) {
        this.dialogService.add(ConfirmationDialog, {
            title: "حذف الكتلة",
            body: `هل تريد حذف كتلة "${block.name}"؟ لن تظهر بعدها في شاشة القيد.`,
            confirmLabel: "احذف",
            confirm: async () => {
                await this.orm.call("myaccounting.block", "delete_block", [block.id]);
                await this.load();
                if (this.state.edited && this.state.edited.id === block.id) {
                    this.state.edited = null;
                }
                this.notification.add("حُذفت الكتلة.", { type: "success" });
            },
            cancel: () => {},
        });
    }

    async duplicate(block) {
        await this.orm.call("myaccounting.block", "duplicate_block", [block.id]);
        await this.load();
        this.notification.add("نُسخت الكتلة، عدّل النسخة كما تشاء.", { type: "success" });
    }
}

registry.category("actions").add("my_accounting.blocks_settings", BlocksSettings);
